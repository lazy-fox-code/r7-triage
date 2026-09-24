// Проверки прохода по ящику (T1). Зависимостей нет: node test/run.mjs.
//
// R7_SRC=<путь> подменяет каталог исходников — так релизная сборка проверяет
// обфусцированный код теми же тестами, что и обычный.
//
// Проверяется именно то, что заявлено критерием готовности: клиент закрыли
// на середине прохода, открыли — разбор продолжился с того же места, дублей
// нет. Поддельный Thunderbird при «перезапуске» раздаёт письмам другие
// номера, как настоящий, поэтому проход, опирающийся на MessageHeader.id,
// эти проверки не прошёл бы.

import { pathToFileURL } from "node:url";
import { install, resetFakeIndexedDB, fakeIndexedDB } from "./fake-idb.js";
import { FakeThunderbird, generate } from "./fake-thunderbird.js";

// Откуда брать исходники. По умолчанию — рабочее дерево; релизная сборка
// подставляет сюда обфусцированную копию и прогоняет те же проверки на ней.
// Обфускация, молча сломавшая проход по ящику, хуже отсутствия обфускации.
const SRC = process.env.R7_SRC
  ? pathToFileURL(`${process.env.R7_SRC}/`).href
  : new URL("../src/", import.meta.url).href;

install();

const { DEFAULTS } = await import(`${SRC}settings.js`);

// storage.local для модуля срока
const storage = new Map();
globalThis.browser = {
  storage: {
    local: {
      async get(key) {
        if (key === null || key === undefined) return Object.fromEntries(storage);
        return storage.has(key) ? { [key]: storage.get(key) } : {};
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) storage.set(k, v); },
    },
  },
};

const { Scanner } = await import(`${SRC}scan.js`);
const db = await import(`${SRC}db.js`);
const { Enricher, threadIndexRoot } = await import(`${SRC}enrich.js`);
const { parseCalendar } = await import(`${SRC}ical.js`);
const { conferenceRefs, conferenceKey } = await import(`${SRC}trueconf.js`);
const { normalizeSubject } = await import(`${SRC}keys.js`);
const { derive, gate } = await import(`${SRC}features.js`);
const { gateReport } = await import(`${SRC}report.js`);
const { myAddresses } = await import(`${SRC}me.js`);
const tc = await import(`${SRC}trueconf-api.js`);
const { Semaphore } = await import(`${SRC}llm.js`);
const { checkModel, SAMPLES } = await import(`${SRC}model-check.js`);
const { checkDirectory } = await import(`${SRC}directory-check.js`);
const { DirectoryLookup, levelOf } = await import(`${SRC}directory.js`);
const report = await import(`${SRC}check-report.js`);
const { buildCases, diffCases, displaySubject, loadCaseRows, objectId, subjectTemplate } = await import(`${SRC}cases.js`);
const { SenderProfiler, actionHint, objectKey, statusOf, categoryOf } = await import(`${SRC}senders.js`);
const trial = await import(`${SRC}trial.js`);
// В релизной сборке дата впечена (см. scripts/build.mjs), и якорь срока — она,
// а не установка. Тесты срока подстраиваются под текущий якорь.
const { BUILD_DATE_MS } = await import(`${SRC}build-info.js`);

// --- крошечный раннер ----------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "условие не выполнено");
}
function equal(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg ?? "не совпало"}: ожидалось ${expected}, получено ${actual}`);
  }
}

async function fresh() {
  db.close();
  resetFakeIndexedDB();
  storage.clear();
}

const DAYS = 86400000;
/**
 * Подменяет отметки срока так, будто от якоря прошло указанное число дней.
 * Якорь — впечённая дата сборки (релиз) либо установка (отладка); водяной
 * знак ставим на `daysUsed + watermarkAhead` дней вперёд от якоря, чтобы
 * проверка работала одинаково в обоих режимах.
 */
function agedTrial(daysUsed, { watermarkAhead = 0 } = {}) {
  const now = Date.now();
  const installedAt = BUILD_DATE_MS || now - daysUsed * DAYS;
  const anchor = BUILD_DATE_MS || installedAt;
  storage.set("trial", {
    installedAt,
    watermark: anchor + (daysUsed + watermarkAhead) * DAYS,
  });
}

const config = (over = {}) => ({ ...DEFAULTS.scan, ...over });

function scanner(tb, over = {}) {
  return new Scanner({ browser: tb.api, db, config: config(over) });
}

// Задержка для свежих писем в тестах выключена: генератор кладёт письма
// в любые моменты, и часть попала бы моложе получаса. Её проверяет
// отдельный тест.
function enricher(tb, over = {}, hosts = []) {
  return new Enricher({
    browser: tb.api, db, config: { ...DEFAULTS.enrich, freshDelayMinutes: 0, ...over },
    hosts, overlapDays: 1 });
}

async function storedRows() {
  return db.getAll("messages");
}

// --- проверки ------------------------------------------------------------

test("полный проход разбирает все письма и ставит признак завершения", async () => {
  const tb = generate(new FakeThunderbird(), { messages: 450, foldersPerAccount: 3 });
  await scanner(tb).run("full");

  equal(await db.count("messages"), 450, "писем в базе");

  const state = await db.checkpoint.load("full");
  assert(state.done, "проход должен быть помечен завершённым");
  equal(state.doneFolders.length, state.folders.length, "разобранных папок");

  const rows = await storedRows();
  assert(rows.every((r) => r.locations.length === 1), "у письма должно быть одно место");
  assert(rows.every((r) => r.enriched === 0), "полные заголовки на этом шаге не читаются");
  assert(rows.every((r) => Number.isFinite(r.date)), "дата должна быть числом");
});

test("проход прерывается и продолжается с того же места после перезапуска клиента", async () => {
  const tb = generate(new FakeThunderbird(), { messages: 1500, foldersPerAccount: 4, seed: 7 });
  const total = 1500;

  let rounds = 0;
  let stoppedAt = 0;

  // Три обрыва подряд: каждый раз клиент «закрывают» через несколько страниц.
  for (let round = 0; round < 3; round++) {
    const s = scanner(tb);
    let pages = 0;
    tb.onPage = () => { if (++pages >= 3) s.stop(); };
    await s.run("full");
    rounds++;
    stoppedAt = await db.count("messages");
    assert(stoppedAt < total, `после обрыва ${round + 1} база не должна быть полной`);

    // Перезапуск клиента: номера писем другие, курсоры страниц мертвы.
    tb.restart();
  }

  tb.onPage = null;
  await scanner(tb).run("full");

  equal(await db.count("messages"), total, "писем в базе после возобновления");
  const state = await db.checkpoint.load("full");
  assert(state.done, "проход должен завершиться");

  const rows = await storedRows();
  const keys = new Set(rows.map((r) => r.id));
  equal(keys.size, rows.length, "ключи должны быть уникальны");
  assert(rounds === 3 && stoppedAt > 0, "обрывы должны были случиться");
});

test("одно письмо в двух папках — одна запись и два места хранения", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик");
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  const proj = tb.addFolder("account1", "/INBOX/Проект", { name: "Проект" });

  const rec = {
    mid: "<same@example.ru>", date: Date.now() - 5 * 86400000,
    author: "ivanov@example.ru", recipients: ["me@example.ru"],
    subject: "Копия", size: 2048,
  };
  tb.addMessage(inbox, rec);
  tb.addMessage(proj, { ...rec });

  await scanner(tb).run("full");

  equal(await db.count("messages"), 1, "копия не должна удваивать запись");
  const [row] = await storedRows();
  equal(row.locations.length, 2, "мест хранения");
  assert(row.locations.includes("account1|/INBOX"), "должно быть во Входящих");
  assert(row.locations.includes("account1|/INBOX/Проект"), "должно быть в Проекте");
});

test("письма без Message-ID не дублируются при повторном проходе", async () => {
  const tb = generate(new FakeThunderbird(), {
    messages: 200, foldersPerAccount: 2, noMessageIdShare: 1, seed: 11 });

  await scanner(tb).run("full");
  const first = await db.count("messages");
  equal(first, 200, "писем после первого прохода");

  tb.restart();
  await scanner(tb).run("full");
  equal(await db.count("messages"), first, "повторный проход не должен добавить записей");
});

test("повторный проход пропускает папки, в которых ничего не изменилось", async () => {
  const tb = generate(new FakeThunderbird(), { messages: 300, seed: 3 });
  await scanner(tb).run("full");
  const before = await db.count("messages");
  const queriesFirst = tb.queries;

  tb.restart();
  await scanner(tb).run("full");

  const state = await db.checkpoint.load("full");
  equal(await db.count("messages"), before, "число писем");
  equal(state.stats.stored, 0, "новых записей во втором проходе");
  equal(state.stats.skippedFolders, state.folders.length, "все папки пропущены как неизменные");
  equal(tb.queries, queriesFirst, "к неизменным папкам запросов нет");

  // Пришло письмо — папка снова разбирается, остальные по-прежнему нет.
  const inbox = tb.folders.find((f) => f.type === "inbox");
  tb.addMessage(inbox, msg("свежее письмо", 0));
  await scanner(tb).run("full");
  const after = await db.checkpoint.load("full");
  equal(after.stats.stored, 1, "новое письмо разобрано");
  equal(after.stats.skippedFolders, state.folders.length - 1, "перебрана только изменившаяся папка");
  equal(await db.count("messages"), before + 1, "писем стало на одно больше");
});

test("письмо ровно на границе окна не теряется", async () => {
  const startedAt = Date.UTC(2025, 5, 1);
  const DAY = 86400000;

  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик");
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });

  // Ровно на границах окон: 30, 60 и 90 суток назад от старта прохода.
  for (const k of [1, 2, 3]) {
    tb.addMessage(inbox, {
      mid: `<edge${k}@example.ru>`, date: startedAt - k * 30 * DAY,
      author: "ivanov@example.ru", recipients: ["me@example.ru"],
      subject: `Граница ${k}`, size: 100,
    });
  }
  // Контрольное письмо внутри окна.
  tb.addMessage(inbox, {
    mid: "<inside@example.ru>", date: startedAt - 15 * DAY,
    author: "ivanov@example.ru", recipients: ["me@example.ru"],
    subject: "Внутри", size: 100,
  });

  await seedCheckpoint(tb, startedAt);
  // Окно фиксируем: иначе после первого пустого окна оно вырастет и границы
  // перестанут приходиться на нужные даты.
  await scanner(tb, {
    initialWindowDays: 30, minWindowDays: 30, maxWindowDays: 30,
  }).run("full");

  equal(await db.count("messages"), 4, "письма на границах окон");
});

test("без перекрытия окон письмо на границе теряется — перекрытие не украшение", async () => {
  const startedAt = Date.UTC(2025, 5, 1);
  const DAY = 86400000;

  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик");
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  tb.addMessage(inbox, {
    mid: "<edge@example.ru>", date: startedAt - 30 * DAY,
    author: "ivanov@example.ru", recipients: ["me@example.ru"],
    subject: "Граница", size: 100,
  });

  await seedCheckpoint(tb, startedAt);
  await scanner(tb, {
    overlapDays: 0, initialWindowDays: 30, minWindowDays: 30, maxWindowDays: 30,
  }).run("full");

  equal(await db.count("messages"), 0,
    "при строгом сравнении дат и нулевом перекрытии письмо на границе выпадает");
});

test("недоступная папка не считается разобранной и повторяется в следующий проход", async () => {
  const tb = generate(new FakeThunderbird(), { messages: 200, foldersPerAccount: 3, seed: 5 });
  const broken = "account1|/INBOX/Проект1";
  tb.failFolders.add(broken);

  await scanner(tb).run("full");
  let state = await db.checkpoint.load("full");
  assert(!state.done, "проход с недоступной папкой не завершён");
  assert(!state.doneFolders.includes(broken), "сломанная папка не должна быть в разобранных");
  assert(state.errors.length > 0, "ошибка должна быть записана");

  tb.failFolders.clear();
  await scanner(tb).run("full");
  state = await db.checkpoint.load("full");
  assert(state.done, "после починки папки проход завершается");
  equal(await db.count("messages"), 200, "писем в базе");
});

test("свежий проход берёт только новое, архивный — остальное", async () => {
  const DAY = 86400000;
  const now = Date.now();
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик");
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });

  // По письму на каждые десять суток за два года.
  for (let k = 0; k < 73; k++) {
    tb.addMessage(inbox, {
      mid: `<age${k}@example.ru>`, date: now - k * 10 * DAY,
      author: "ivanov@example.ru", recipients: ["me@example.ru"],
      subject: `Возраст ${k * 10}`, size: 100,
    });
  }

  const edge = now - 30 * DAY;
  await scanner(tb).run("recent", { since: edge, until: null });

  const afterRecent = await db.count("messages");
  equal(afterRecent, 4, "писем моложе 30 суток (0, 10, 20 и 30 суток)");
  const recentState = await db.checkpoint.load("recent");
  assert(recentState.done, "свежий проход завершается");

  await scanner(tb).run("archive", { since: null, until: edge });
  equal(await db.count("messages"), 73, "архивный проход добирает остальное");

  const rows = await storedRows();
  equal(new Set(rows.map((r) => r.id)).size, 73, "дублей между проходами нет");
});

test("папка «Входящие» разбирается раньше прочих", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик");
  tb.addFolder("account1", "/Архив", { name: "Архив" });
  tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  tb.addFolder("account1", "/Отправленные", { name: "Отправленные", type: "sent" });

  await scanner(tb).run("full");
  const state = await db.checkpoint.load("full");

  equal(state.folders[0].key, "account1|/INBOX", "первой идёт папка входящих");
  equal(state.folders[1].key, "account1|/Отправленные", "затем отправленные");
});

test("выгрузка состояния даёт разбираемый JSON", async () => {
  const tb = generate(new FakeThunderbird(), { messages: 120, seed: 9 });
  await scanner(tb).run("full");

  const parts = [];
  await db.exportChunks((c) => parts.push(c), { batch: 50 });
  const parsed = JSON.parse(parts.join(""));

  equal(parsed.stores.messages.length, 120, "писем в выгрузке");
  equal(parsed.meta.counts.messages, 120, "счётчик в шапке выгрузки");
  assert(Array.isArray(parsed.stores.meta), "служебное хранилище тоже выгружается");
});

test("срок демоверсии: отсчёт включается с 30-го дня, работа прекращается после 90-го", async () => {
  agedTrial(5);
  let t = await trial.state();
  assert(!t.countdown, "на пятый день секундомер не показывается");
  assert(!t.expired, "на пятый день работа не ограничена");
  equal(t.daysLeft, 85, "осталось дней");

  agedTrial(30);
  t = await trial.state();
  assert(t.countdown, "с 30-го дня показывается обратный отсчёт");
  assert(!t.expired, "но работа продолжается");

  agedTrial(91);
  t = await trial.state();
  assert(t.expired, "после 90 дней срок истёк");
  equal(t.msLeft, 0, "остатка нет");
  equal(await trial.allowsScanning(), false, "разбор почты запрещён");
});

test("перевод часов назад не продлевает срок", async () => {
  // Водяной знак помнит, что расширение уже видело время на 60 дней вперёд.
  agedTrial(1, { watermarkAhead: 60 });
  const t = await trial.state();

  equal(t.daysUsed, 61, "учитывается наибольшее виденное время, а не текущее");
  assert(t.countdown, "секундомер уже включён");
  assert(t.daysLeft < 30, "остаток считается от водяного знака");
});

test("переустановка профиля не сбрасывает срок релизной сборки", async () => {
  // Пустое storage — как на свежей установке той же сборки.
  await fresh();
  const t = await trial.state();
  if (BUILD_DATE_MS) {
    // Релиз: якорь — впечённая дата сборки, «now» на него не влияет.
    equal(t.endsAt, BUILD_DATE_MS + trial.TRIAL_DAYS * DAYS,
      "срок отсчитан от даты сборки, а не от новой установки");
  } else {
    // Отладка: якорь — установка, срок начинается заново.
    assert(Math.abs(t.endsAt - (Date.now() + trial.TRIAL_DAYS * DAYS)) < 5000,
      "в отладке срок считается от установки");
  }
  assert(!t.expired, "свежая установка не истекла");
});

test("остаток срока выводится в читаемом виде", async () => {
  equal(trial.formatLeft(0), "00:00:00", "ноль");
  equal(trial.formatLeft(12 * 86400000 + 3661000), "12 дней 01:01:01", "дни и часы");
  equal(trial.formatLeft(86400000 * 21 + 1000), "21 день 00:00:01", "склонение для 21");
  equal(trial.formatLeft(86400000 * 3), "3 дня 00:00:00", "склонение для 3");
});

test("замер на ящике больше 10 000 писем", async () => {
  const COUNT = 12000;
  const tb = generate(new FakeThunderbird(), {
    messages: COUNT, accounts: 2, foldersPerAccount: 5, spanDays: 1800, seed: 21 });

  const t0 = Date.now();
  await scanner(tb).run("full");
  const ms = Date.now() - t0;

  equal(await db.count("messages"), COUNT, "писем в базе");
  const state = await db.checkpoint.load("full");

  const heap = process.memoryUsage().heapUsed / 1048576;
  console.log(`    ${COUNT} писем за ${ms} мс · запросов ${state.stats.queries}` +
    ` · страниц ${state.stats.pages} · куча ${heap.toFixed(0)} МБ`);

  const t1 = Date.now();
  await enricher(tb).run();
  const ems = Date.now() - t1;
  const es = await db.meta.get("enrich");
  equal((await db.enrichCounts()).done, COUNT, "дочитано писем");
  console.log(`    обогащение: ${ems} мс · запросов к папкам ${es.stats.queries}` +
    ` · чтений getFull ${es.stats.fullReads}`);
  console.log(`    (это скорость движка на заглушках, не Thunderbird: там цену задают` +
    ` messages.query и getFull)`);
});


// --- T2: обогащение ------------------------------------------------------

test("обогащение дочитывает все письма и переживает перезапуск клиента без повторных чтений", async () => {
  const TOTAL = 1200;
  const tb = generate(new FakeThunderbird(), { messages: TOTAL, foldersPerAccount: 3, seed: 13 });
  await scanner(tb).run("full");

  // Три обрыва: клиент закрывают посреди обогащения, номера писем меняются.
  for (let round = 0; round < 3; round++) {
    const e = enricher(tb, { batchSize: 100 });
    let reads = 0;
    tb.onFull = () => { if (++reads >= 150) e.stop(); };
    await e.run();
    const c = await db.enrichCounts();
    assert(c.pending > 0, `после обрыва ${round + 1} очередь не должна опустеть`);
    tb.restart();
  }

  tb.onFull = null;
  await enricher(tb, { batchSize: 100 }).run();

  const c = await db.enrichCounts();
  equal(c.done, TOTAL, "дочитано писем");
  equal(c.pending, 0, "осталось в очереди");
  equal(c.failed, 0, "неудач");
  equal(tb.fullReads, TOTAL, "каждое письмо прочитано ровно один раз");

  const rows = await storedRows();
  assert(rows.every((r) => r.threadId), "у каждого письма есть ветка");
  assert(rows.every((r) => r.hasAttachments === false), "вложений в генераторе нет");
});

test("обогащение: свежая почта от новых писем, архив по хронологии с первого", async () => {
  const tb = generate(new FakeThunderbird(), { messages: 600, foldersPerAccount: 4, seed: 17 });
  await scanner(tb).run("full");
  // Архив по умолчанию читается от старых писем к свежим: история дела
  // собирается с начала, а не с середины.
  await enricher(tb, { batchSize: 50 }).run();
  const log = tb.fullLog;
  equal(log.length, 600, "прочитано писем");
  assert(log.every((d, i) => i === 0 || d >= log[i - 1]),
    "архив читается по хронологии, от первого письма к последнему");

  // Свежий проход — наоборот: свежая почта нужна сразу.
  const tb2 = generate(new FakeThunderbird(), { messages: 300, foldersPerAccount: 3, seed: 21 });
  await scanner(tb2).run("full");
  await enricher(tb2, { batchSize: 50 }).run({ since: 0 });
  const log2 = tb2.fullLog;
  equal(log2.length, 300, "прочитано писем свежим проходом");
  assert(log2.every((d, i) => i === 0 || d <= log2[i - 1]),
    "свежий проход идёт от новых писем к старым");

  // Порядок архива — настройка: прежнее поведение возвращается ею.
  const tb3 = generate(new FakeThunderbird(), { messages: 200, foldersPerAccount: 2, seed: 23 });
  await scanner(tb3).run("full");
  await enricher(tb3, { batchSize: 50, archiveOrder: "newest" }).run();
  const log3 = tb3.fullLog;
  assert(log3.every((d, i) => i === 0 || d <= log3[i - 1]),
    "archiveOrder: newest возвращает чтение от свежих писем");
});

test("свежий проход обогащения не трогает архив", async () => {
  const DAY = 86400000;
  const now = Date.now();
  const tb = generate(new FakeThunderbird(), { messages: 400, spanDays: 300, seed: 19, now });
  await scanner(tb).run("full");

  const edge = now - 30 * DAY;
  await enricher(tb).run({ since: edge });

  const rows = await storedRows();
  const fresh = rows.filter((r) => r.date >= edge);
  const old = rows.filter((r) => r.date < edge);
  assert(fresh.length > 0 && old.length > 0, "в ящике есть и свежее, и архив");
  assert(fresh.every((r) => r.enriched === 1), "свежее дочитано");
  assert(old.every((r) => r.enriched === 0), "архив не тронут");
});

test("удалённое после прохода письмо помечается ненайденным, остальные дочитываются", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["me@example.ru"]);
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  const gone = tb.addMessage(inbox, msg("gone", 3));
  tb.addMessage(inbox, msg("stays", 2));

  await scanner(tb).run("full");
  tb.removeMessage(inbox, gone);
  await enricher(tb).run();

  const byMid = await rowsByMid();
  equal(byMid.gone.enriched, -1, "удалённое письмо");
  equal(byMid.gone.enrichError, "not-found", "причина");
  equal(byMid.stays.enriched, 1, "оставшееся письмо дочитано");
});

test("письмо находится по второму месту хранения, если из первого его унесли", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["me@example.ru"]);
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  const proj = tb.addFolder("account1", "/INBOX/Проект", { name: "Проект" });
  const first = tb.addMessage(inbox, msg("copy", 4));
  tb.addMessage(proj, msg("copy", 4));

  await scanner(tb).run("full");
  tb.removeMessage(inbox, first);
  await enricher(tb).run();

  const byMid = await rowsByMid();
  equal(byMid.copy.enriched, 1, "дочитано из второй папки");
});

test("перенесённое в другую папку письмо возвращается в очередь, как только проход его увидел", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["me@example.ru"]);
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  const proj = tb.addFolder("account1", "/INBOX/Проект", { name: "Проект" });
  const m = tb.addMessage(inbox, msg("moved", 3));

  await scanner(tb).run("full");
  // Пользователь разложил почту: письмо ушло в папку проекта.
  tb.removeMessage(inbox, m);
  await enricher(tb).run();
  equal((await rowsByMid()).moved.enrichError, "not-found", "на старом месте письма нет");

  tb.addMessage(proj, msg("moved", 3));
  tb.restart();
  await scanner(tb).run("full-2");
  equal((await rowsByMid()).moved.enriched, 0, "проход по ящику вернул письмо в очередь");

  await enricher(tb).run();
  const row = (await rowsByMid()).moved;
  equal(row.enriched, 1, "дочитано на новом месте");
  assert(row.locations.includes("account1|/INBOX/Проект"), "новое место записано");
});

test("серия отказов сервера останавливает обогащение и возвращает письма в очередь", async () => {
  const tb = generate(new FakeThunderbird(), { messages: 50, seed: 23 });
  await scanner(tb).run("full");

  let reads = 0;
  tb.failFull = () => { reads++; return true; };
  await enricher(tb, { maxConsecutiveErrors: 5 }).run();

  const c = await db.enrichCounts();
  equal(c.failed, 0, "неудачи не должны осесть — это беда сервера, не писем");
  equal(c.pending, 50, "все письма остались в очереди");
  equal(reads, 5, "проход остановился после пятой неудачи подряд");
  const state = await db.meta.get("enrich");
  assert(state.error, "причина остановки записана");

  // Сервер ожил — следующий проход дочитывает всё.
  tb.failFull = null;
  await enricher(tb).run();
  equal((await db.enrichCounts()).done, 50, "после восстановления дочитано");
});

test("крупное письмо не читается, состав вложений у него неизвестен", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["me@example.ru"]);
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  tb.addMessage(inbox, { ...msg("big", 1), size: 40 * 1048576 });

  await scanner(tb).run("full");
  await enricher(tb).run();

  const byMid = await rowsByMid();
  equal(byMid.big.enriched, 2, "пропущено по размеру");
  equal(byMid.big.hasAttachments, null, "вложения неизвестны, а не отсутствуют");
  equal(tb.fullReads, 0, "письмо не читалось");
});

test("обогащение извлекает ветку, рассылку, вложения, встречу и конференцию", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["me@example.ru"]);
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });

  tb.addMessage(inbox, msg("root", 10));
  tb.addMessage(inbox, { ...msg("reply", 9), headers: {
    References: "<root@example.ru>",
    "In-Reply-To": "<root@example.ru>",
    "Thread-Index": threadIndex(1),
    "Thread-Topic": "Договор с подрядчиком",
  } });
  tb.addMessage(inbox, { ...msg("news", 8), headers: {
    "List-Id": "Новости <news.example.ru>",
    "List-Unsubscribe": "<mailto:unsub@example.ru>",
  } });
  tb.addMessage(inbox, { ...msg("files", 7), parts: [
    { contentType: "text/plain", partName: "1.1", headers: {}, body: "Во вложении договор", size: 20 },
    { contentType: "application/pdf", partName: "1.2", name: "договор_v2.pdf", size: 52000,
      headers: { "content-disposition": ["attachment; filename=\"договор_v2.pdf\""] } },
    { contentType: "image/png", partName: "1.3", name: "image001.png", size: 3000,
      headers: { "content-disposition": ["inline"], "content-id": ["<logo>"] } },
  ] });
  tb.addMessage(inbox, { ...msg("invite", 6), parts: [
    { contentType: "text/html", partName: "1.1", headers: {},
      body: '<a href="https://tc.example.ru/c/weekly_sync">Подключиться</a>.', size: 60 },
    { contentType: "text/calendar", partName: "1.2", name: "invite.ics", size: 900,
      headers: { "content-disposition": ["attachment"] }, content: INVITE },
  ] });
  tb.addMessage(inbox, { ...msg("accepted", 5), parts: [
    { contentType: "text/calendar; method=REPLY", partName: "1", headers: {},
      body: ACCEPTED, size: 400 },
  ] });

  await scanner(tb).run("full");
  await enricher(tb, {}, ["tc.example.ru"]).run();
  const r = await rowsByMid();

  equal(r.root.threadId, "m:root@example.ru", "корень — сам себе ветка");
  equal(r.reply.threadId, "m:root@example.ru", "ответ — в ветке корня");
  equal(r.reply.thread.parent, "m:root@example.ru", "родитель ответа");
  equal(r.reply.thread.index, threadIndexRoot(threadIndex(0)).root,
    "корень Thread-Index общий с началом беседы");
  equal(r.reply.thread.topic, "Договор с подрядчиком", "тема беседы Exchange");

  equal(r.news.bulk.listId, "Новости <news.example.ru>", "List-Id сохранён как есть");
  equal(r.news.bulk.listUnsubscribe, true, "List-Unsubscribe");
  equal(r.root.bulk, null, "у обычного письма признаков рассылки нет");

  equal(r.files.hasAttachments, true, "письмо с вложением");
  equal(r.files.attachments.length, 2, "вложений вместе с картинкой подписи");
  equal(r.files.attachments.find((a) => a.name === "image001.png").inline, true,
    "картинка подписи — встроенная");

  const [meeting] = r.invite.calendar;
  equal(r.invite.hasAttachments, false, "приглашение .ics — не вложение");
  equal(meeting.kind, "meeting", "встреча");
  equal(meeting.method, "REQUEST", "приглашение");
  equal(meeting.uid, "040000008200E00074C5B7101A82E0080000000011", "UID встречи");
  equal(meeting.summary, "Еженедельная сверка по договору", "тема с переносом строки");
  equal(meeting.organizer, "ivanov@example.ru", "организатор");
  equal(meeting.attendees.length, 2, "участников");
  equal(meeting.start.tzid, "Russian Standard Time", "часовой пояс сохранён");
  equal(r.invite.conferences.length, 1, "одна конференция на письмо");
  equal(r.invite.conferences[0].id, "weekly_sync", "идентификатор конференции");
  equal(r.invite.conferences[0].topic, "Еженедельная сверка по договору",
    "тема конференции — тема встречи из приглашения");
  equal(r.invite.conferences[0].key, "tc:tc.example.ru|weekly_sync|еженедельная сверка по договору",
    "ключ: сервер, номер и тема");

  equal(r.accepted.calendar[0].method, "REPLY", "ответ на приглашение");
  equal(r.accepted.calendar[0].uid, meeting.uid, "ответ связан со встречей по UID");
  equal(r.accepted.calendar[0].attendees[0].partstat, "ACCEPTED", "ответ участника");
});

test("iCalendar: задача, экранирование, кавычки в параметрах, VALARM не путается со встречей", async () => {
  const { method, items } = parseCalendar([
    "BEGIN:VCALENDAR", "METHOD:REQUEST",
    "BEGIN:VTODO", "UID:task-1",
    'ORGANIZER;CN="Петрова: отдел; закупки":mailto:Petrova@Example.ru',
    "SUMMARY:Подготовить справку\\, срочно", "DUE:20260930T150000Z",
    "BEGIN:VALARM", "DESCRIPTION:Напоминание", "END:VALARM",
    "END:VTODO", "END:VCALENDAR",
  ].join("\r\n"));

  equal(method, "REQUEST", "метод");
  equal(items.length, 1, "одна запись");
  equal(items[0].kind, "task", "VTODO — задача");
  equal(items[0].organizer, "petrova@example.ru", "адрес из параметра с кавычками");
  equal(items[0].summary, "Подготовить справку, срочно", "экранированная запятая");
  equal(items[0].due.ms, Date.UTC(2026, 8, 30, 15), "срок в UTC");
  equal(items[0].description, undefined, "описание напоминания не приписано задаче");
});

test("ссылки TrueConf: https — только на своих серверах, схема trueconf — всегда", async () => {
  const text = "Подключайтесь: https://tc.example.ru/c/2381734096. " +
    "Или https://other.example.ru/c/abc. Клиент: trueconf:c/2381734096@tc.example.ru";
  const refs = conferenceRefs(text, ["TC.example.ru"]);
  equal(refs.length, 1, "обе ссылки ведут на одну конференцию");
  equal(refs[0].id, "2381734096", "идентификатор без точки в конце");
  equal(refs[0].host, "tc.example.ru", "сервер");
  const bare = conferenceRefs("запуск: trueconf:\\c\\777", []);
  equal(bare.length, 1, "схема trueconf признаётся без списка серверов");
  equal(bare[0].id, "777", "идентификатор из ссылки с обратными косыми");
  equal(conferenceRefs("https://tc.example.ru/c/x", []).length, 0,
    "без списка серверов https-ссылки не признаются");
});

test("конференция узнаётся по номеру вместе с темой: обнулённый номер не склеивает разные", async () => {
  const ref = { host: "tc.example.ru", id: "0005439837" };
  equal(conferenceKey(ref, "Приглашение: Планёрка «Договор»"),
    conferenceKey(ref, "RE: планерка договор"),
    "одна конференция под разными приставками темы");
  assert(conferenceKey(ref, "Планёрка отдела") !== conferenceKey(ref, "Совещание по договору"),
    "тот же номер с другой темой — другая конференция");

  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["me@example.ru"]);
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  tb.addMessage(inbox, { ...msg("march", 200), subject: "Планёрка отдела",
    body: "Ссылка: https://tc.example.ru/c/0005439837" });
  tb.addMessage(inbox, { ...msg("sept", 5), subject: "FW: Совещание по договору",
    body: "Ссылка: https://tc.example.ru/c/0005439837" });
  await scanner(tb).run("full");
  await enricher(tb, {}, ["tc.example.ru"]).run();

  const r = await rowsByMid();
  equal(r.march.conferences[0].id, r.sept.conferences[0].id, "номер один и тот же");
  assert(r.march.conferences[0].key !== r.sept.conferences[0].key,
    "а конференции разные: тема письма входит в ключ");
  equal(r.sept.conferences[0].key, "tc:tc.example.ru|0005439837|совещание по договору",
    "приставка пересылки в ключ не попадает");
});

test("тема нормализуется: приставки ответов, приглашений, кавычки, ё", async () => {
  equal(normalizeSubject("RE: FW: Принято: Сверка «Договор №5»"), "сверка договор №5", "цепочка приставок");
  equal(normalizeSubject("Отв[2]: Отчёт"), "отчет", "счётчик ответов и ё");
  equal(normalizeSubject("Updated invitation: Weekly  sync"), "weekly sync", "английский календарь");
  equal(normalizeSubject("Решение: протокол"), "решение: протокол", "обычное двоеточие в теме не срезается");
});

test("свежие письма ждут, пока клиент сохранит их офлайн", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["me@example.ru"]);
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  tb.addMessage(inbox, { ...msg("justnow", 0), date: Date.now() - 5 * 60000 });
  tb.addMessage(inbox, { ...msg("hourago", 0), date: Date.now() - 60 * 60000 });

  await scanner(tb).run("full");
  await enricher(tb, { freshDelayMinutes: 30 }).run();

  const r = await rowsByMid();
  equal(r.justnow.enriched, 0, "письмо пятиминутной давности ждёт");
  equal(r.hourago.enriched, 1, "часовой давности — дочитано");
  equal(tb.fullReads, 1, "свежее письмо не читалось");
});

test("Thread-Index: корень общий у беседы, глубина по числу ответов", async () => {
  const a = threadIndexRoot(threadIndex(0));
  const b = threadIndexRoot(threadIndex(3));
  equal(a.root, b.root, "корень");
  equal(a.depth, 0, "глубина начала");
  equal(b.depth, 3, "глубина третьего ответа");
  equal(threadIndexRoot("не base64!"), null, "мусор не роняет разбор");
});

// --- T2: гейт и свои адреса ----------------------------------------------

test("гейт: у решения есть причина и цитата, моё и недочитанное не решается", async () => {
  const me = new Set(["me@example.ru"]);
  const cfg = DEFAULTS.gate;
  const base = { fromId: "ivanov@example.ru", to: ["me@example.ru"], cc: [], enriched: 1 };

  let g = gate(derive({ ...base, bulk: { listId: "<news.example.ru>" } }, me), cfg);
  equal(g.outcome, "noise", "рассылка — шум");
  equal(g.quote, "List-Id: <news.example.ru>", "цитата — заголовок письма");
  assert(g.features.includes("list-id"), "признак назван");

  g = gate(derive({ ...base, calendar: [{ method: "REPLY", kind: "meeting" }] }, me), cfg);
  equal(g.outcome, "noise", "ответ на приглашение — шум");

  const many = Array.from({ length: 12 }, (_, i) => `p${i}@example.ru`);
  g = gate(derive({ ...base, to: many, cc: ["me@example.ru"], enriched: 0 }, me), cfg);
  equal(g.outcome, "info", "массовая копия решается и без полных заголовков");

  equal(gate(derive({ ...base, fromId: "me@example.ru" }, me), cfg).outcome, "own", "моё письмо");
  equal(gate(derive({ ...base, enriched: 0 }, me), cfg).outcome, "pending", "недочитанное ждёт");
  equal(gate(derive(base, me), cfg).outcome, "model", "адресное письмо — в модель");
});

test("замер отсева: заголовки рассылок, профиль отправителя и признак действия", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["me@example.ru"]);
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  // Рассылка с заголовком — старое правило работает как работало.
  for (let i = 0; i < 6; i++) {
    tb.addMessage(inbox, { ...msg(`Дайджест ${i}`, 20 + i), author: "news@example.ru",
      headers: { "List-Id": "<news.example.ru>" } });
  }
  // Система уведомлений без единого заголовка рассылки: узнаётся по себе.
  for (let i = 1; i <= 5; i++) {
    tb.addMessage(inbox, { ...msg(`Инцидент INC00${i} зарегистрирован`, 15 + i), author: "sd@example.ru" });
  }
  // Она же, но от вас ждут действия: такое письмо остаётся модели.
  tb.addMessage(inbox, { ...msg("Инцидент INC006 назначен вам", 12), author: "sd@example.ru" });
  // Живой коллега.
  tb.addMessage(inbox, { ...msg("Договор с подрядчиком", 11) });
  tb.addMessage(inbox, { ...msg("Смета на ремонт", 10) });
  tb.addMessage(inbox, { ...msg("Ответ коллеге", 5), author: "me@example.ru" });

  await scanner(tb).run("full");
  await enricher(tb).run();

  const report = await gateReport({ db, me: new Set(["me@example.ru"]), cfg: DEFAULTS.gate });
  equal(report.total, 15, "писем всего");
  equal(report.own, 1, "моих");
  equal(report.noise, 6, "шум по заголовку рассылки");
  equal(report.info, 5, "уведомления системы сняты без модели");
  equal(report.model, 3, "в модель: два письма коллеги и одно с признаком действия");
  equal(Math.round(report.removedShare * 100), 79, "доля снятых без модели, %");
  equal(report.reasons["info: уведомление информационной системы"], 5, "разбивка по причинам");
  // И служба поддержки, и адрес рассылки пишут одинаково: много, по
  // шаблону, без ответа. Что рассылка ещё и с заголовком List-Id — видно
  // раньше, по заголовку, поэтому её письма остаются шумом, а не
  // информированием.
  equal(report.senders.system, 2, "оба односторонних отправителя узнаны");
  equal(report.senders.person, 1, "живой коллега остался обычным отправителем");
  equal(report.samples, undefined, "без запроса выборки писем нет");

  const profiles = await db.getAll("people");
  const sd = profiles.find((p) => p.email === "sd@example.ru");
  equal(sd.kind, "system", "профиль отправителя сохранён в people");
  assert(sd.why.includes("одна и та же тема") && sd.why.includes("не писали"),
    "видно, почему это система");

  const withSample = await gateReport({ db, me: new Set(["me@example.ru"]), cfg: DEFAULTS.gate, sampleSize: 4 });
  equal(withSample.samples.noise.length, 4, "выборка отсеянных ограничена размером");
  assert(withSample.samples.noise.every((x) => x.reason === "рассылка" && x.subject), "в выборке причина и тема");
  assert(withSample.samples.info.some((x) => x.quote.includes("вы этому адресу не писали")),
    "в цитате — на чём основано решение по отправителю");
});

test("отсев по адресации: копия, письмо не мне и служебные темы", async () => {
  const me = new Set(["me@example.ru"]);
  const cfg = DEFAULTS.gate;
  const row = (extra) => ({
    id: "m:x@example.ru", date: Date.now(), subject: "Смета на ремонт", fromId: "petrov@example.ru",
    to: ["petrov2@example.ru"], cc: [], enriched: 1, thread: { parent: null }, ...extra,
  });

  const cc = gate(derive(row({ to: ["boss@example.ru"], cc: ["me@example.ru"] }), me), cfg);
  equal(cc.outcome, "info", "я в копии — информирование");
  equal(cc.reason, "я в копии, а не в адресатах", "причина названа");

  const toMe = gate(derive(row({ to: ["me@example.ru"] }), me), cfg);
  equal(toMe.outcome, "model", "письмо лично мне решает модель");

  const notMine = gate(derive(row({ to: ["otdel@example.ru"] }), me), cfg);
  equal(notMine.outcome, "info", "меня нет в адресатах — пришло через список");

  // С тем, с кем есть переписка, правило «я не в адресатах» не срабатывает:
  // обращение могло прийти и через список рассылки.
  const known = new Map([["petrov@example.ru", { kind: "person", iWrote: true, dialogThreads: 2, features: [] }]]);
  const viaList = gate(derive(row({ to: ["otdel@example.ru"] }), me, known), cfg);
  equal(viaList.outcome, "model", "с собеседником решает модель");

  const auto = gate(derive(row({ to: ["me@example.ru"], subject: "Автоответ: Отсутствую на рабочем месте" }), me), cfg);
  equal(auto.outcome, "noise", "служебная тема — шум");

  equal(objectKey("Совещание 15.09.2026 перенесено"), null, "дата номером предмета не считается");
  equal(objectKey("Договор № 15 на согласование").key, objectKey("Справка по договору 15").key,
    "разные формулировки об одном договоре дают один ключ");
  equal(statusOf("Инцидент INC001 решён", DEFAULTS.senders.statusWords), "решен", "статус из темы");
  equal(categoryOf("Инцидент INC001 решён", DEFAULTS.senders.statusWords), "инцидент",
    "категория — тема без номера и статуса");
});

test("отсев: обработка встреч по теме и письма, на которые вы уже ответили", async () => {
  const me = new Set(["me@example.ru"]);
  const cfg = DEFAULTS.gate;
  const base = {
    id: "m:x@example.ru", date: Date.now() - 3600000, fromId: "petrov@example.ru",
    to: ["me@example.ru"], cc: [], enriched: 1, threadId: "t1", thread: { parent: null },
  };

  equal(gate(derive({ ...base, subject: "Принято: Планёрка в понедельник" }, me), cfg).outcome,
    "noise", "ответ участника на приглашение — шум");
  equal(gate(derive({ ...base, subject: "Новое время: Планёрка" }, me), cfg).outcome,
    "info", "перенос встречи — информирование");
  equal(gate(derive({ ...base, subject: "Отменено: Планёрка" }, me), cfg).reason,
    "отмена встречи", "отмена встречи названа");
  equal(gate(derive({ ...base, subject: "Планёрка в понедельник" }, me), cfg).outcome,
    "model", "обычное письмо остаётся модели");

  // Ваш ответ в ветке позже письма — действие уже сделано.
  const threads = new Map([["t1", Date.now() - 600000]]);
  const answered = gate(derive({ ...base, subject: "Смета на ремонт" }, me, { threads }), cfg);
  equal(answered.outcome, "info", "письмо, на которое вы ответили, модели не нужно");
  equal(answered.reason, "вы уже ответили в этой переписке", "причина названа");
  const fresh = gate(derive({ ...base, subject: "Смета на ремонт", date: Date.now() }, me, { threads }), cfg);
  equal(fresh.outcome, "model", "письмо после вашего ответа решает модель");
});

test("дела: состояние видно по переписке — новое, жду ответа, в работе, остыло", async () => {
  const me = new Set(["me@example.ru"]);
  const now = Date.now();
  const build = (rows) => buildCases(rows, { me, cfg: DEFAULTS.cases, now }).cases[0];

  const fresh = build([letter("n1", { subject: "Смета на ремонт", read: false, ageH: 5 })]);
  equal(fresh.state, "new", "непрочитанное входящее — новое");

  const waiting = build([
    letter("w1", { subject: "Договор на согласование", ageH: 30 }),
    letter("w2", { subject: "RE: Договор на согласование", from: "me@example.ru", ageH: 10,
      to: ["ivanov@example.ru"], threadId: "m:w1@example.ru",
      thread: { root: "m:w1@example.ru", parent: "m:w1@example.ru", index: null } }),
  ]);
  equal(waiting.state, "wait", "последним писали вы — ждём ответа");

  const working = build([
    letter("k1", { subject: "Смета по объекту", ageH: 50 }),
    letter("k2", { subject: "RE: Смета по объекту", from: "me@example.ru", ageH: 40,
      to: ["ivanov@example.ru"], threadId: "m:k1@example.ru",
      thread: { root: "m:k1@example.ru", parent: "m:k1@example.ru", index: null } }),
    letter("k3", { subject: "RE: Смета по объекту", ageH: 20, threadId: "m:k1@example.ru",
      thread: { root: "m:k1@example.ru", parent: "m:k2@example.ru", index: null } }),
  ]);
  equal(working.state, "work", "вы в переписке, последнее письмо прочитано — в работе");

  const cold = build([letter("o1", { subject: "Прошлая переписка", ageH: 24 * 90 })]);
  equal(cold.state, "old", "движения нет давно — дело остыло");

  const notice = build([
    letter("s1", { from: "noreply@sd.example.ru", fromName: "Service Desk",
      subject: "Инцидент INC0012345 зарегистрирован", ageH: 40 }),
    letter("s2", { from: "noreply@sd.example.ru", fromName: "Service Desk",
      subject: "Инцидент INC0012345 решён", ageH: 20 }),
  ]);
  equal(notice.state, "info", "уведомления системы без вашего участия — информирование");
});

test("дела: приглашение, ответы участников и перенос — одна встреча", async () => {
  const me = new Set(["me@example.ru"]);
  const rows = [
    letter("inv", { subject: "Планёрка по проекту", from: "petrov@example.ru",
      to: ["me@example.ru", "sidorov@example.ru"], ageH: 50 }),
    letter("a1", { subject: "Принято: Планёрка по проекту", from: "sidorov@example.ru", ageH: 40 }),
    letter("a2", { subject: "Отклонено: Планёрка по проекту", from: "kuznecov@example.ru", ageH: 30 }),
    letter("upd", { subject: "Новое время: Планёрка по проекту", from: "petrov@example.ru", ageH: 20 }),
  ];
  const { cases } = buildCases(rows, { me, cfg: DEFAULTS.cases });
  equal(cases.length, 1, "встреча собрана в одно дело");
  const c = cases[0];
  equal(c.counts.mail, 4, "приглашение, два ответа и перенос вместе");
  equal(c.counts.meet, 1, "встреча видна как сущность дела");
  equal(c.meetings[0].responses, 2, "ответы участников посчитаны");
  assert(c.letters.some((l) => l.why === "ответ участника на ту же встречу"), "почему письмо в деле");
});

test("профиль отправителя: ваши письма отменяют вердикт «система»", async () => {
  const me = new Set(["me@example.ru"]);
  const notifications = [];
  for (let i = 1; i <= 6; i++) {
    notifications.push(letter(`n${i}`, { from: "hr@example.ru", fromName: "Кадры",
      subject: `Табель за 0${i}.2026`, ageH: 100 - i, threadId: `t${i}` }));
  }
  const alone = new SenderProfiler(me);
  for (const row of notifications) alone.add(row);
  const asSystem = alone.profiles(DEFAULTS.senders).get("hr@example.ru");
  equal(asSystem.kind, "system", "одностороннее вещание по шаблону — система");
  equal(asSystem.dialogThreads, 0, "разговора не было");

  // Те же письма, но в одной из веток ответил я — это уже переписка.
  const talked = new SenderProfiler(me);
  for (const row of notifications) talked.add(row);
  talked.add(letter("reply", { from: "me@example.ru", to: ["hr@example.ru"],
    subject: "RE: Табель за 03.2026", threadId: "t3" }));
  const asPerson = talked.profiles(DEFAULTS.senders).get("hr@example.ru");
  equal(asPerson.kind, "person", "вы отвечали — значит, не вещание");
  equal(asPerson.dialogThreads, 1, "ветка с вашим ответом посчитана");
  assert(asPerson.iWrote, "видно, что вы писали на этот адрес");

  equal(actionHint("Инцидент INC001 назначен вам", DEFAULTS.gate.actionWords), "назначен",
    "признак действия в теме находится");
  equal(actionHint("Инцидент INC001 закрыт", DEFAULTS.gate.actionWords), null,
    "без признака действия тема чистая");
});

test("свои адреса: личности учётных записей и алиасы из настроек", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["Me@Example.ru"]);
  tb.addAccount("account2", "Exchange", ["i.ivanov@corp.example.ru"]);
  const me = await myAddresses(tb.api, ["Отдел закупок <Zakupki@Corp.Example.ru>"]);
  assert(me.has("me@example.ru"), "адрес личности нормализован");
  assert(me.has("i.ivanov@corp.example.ru"), "личность второй учётной записи");
  assert(me.has("zakupki@corp.example.ru"), "список рассылки из настроек");
  equal(me.size, 3, "всего адресов");
});

test("база v2 с живого профиля поднимается до v3 без потери писем", async () => {
  // Воспроизводим базу, какой её оставила версия 0.2.1.
  await new Promise((resolve, reject) => {
    const req = fakeIndexedDB.open("r7-triage", 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      const m = d.createObjectStore("messages", { keyPath: "id" });
      m.createIndex("date", "date");
      m.createIndex("enriched", "enriched");
      d.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => {
      const d = req.result;
      const t = d.transaction("messages", "readwrite");
      t.objectStore("messages").put({ id: "m:old@example.ru", date: 1000, enriched: 0, locations: [] });
      t.objectStore("messages").put({ id: "m:new@example.ru", date: 2000, enriched: 0, locations: [] });
      t.oncomplete = () => { d.close(); resolve(); };
      t.onabort = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });

  const queue = await db.enrichQueue();
  equal(await db.count("messages"), 2, "письма пережили миграцию");
  equal(queue.length, 2, "очередь построена по старым записям");
  equal(queue[0].id, "m:new@example.ru", "первым идёт свежее");
});


// --- T9: TrueConf от имени пользователя -----------------------------------

const TC = {
  server: "tc.example.ru", apiVersion: "v4.1", clientId: "cid", clientSecret: "sec",
  authorizePath: "/oauth2/authorize", tokenUrl: "", hosts: [],
};

/** fetch по таблице маршрутов: "METHOD url" → (init) => [status, body]. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, init, body: init.body ? JSON.parse(init.body) : null });
    const route = routes[`${method} ${url}`];
    if (!route) throw new Error(`нет маршрута ${method} ${url}`);
    const [status, body] = route(init, calls.length);
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls;
  return fn;
}

test("TrueConf: вход через страницу сервера, код меняется на токен, запросы идут с Bearer", async () => {
  const api = "https://tc.example.ru/api/v4.1";
  const fetch = fakeFetch({
    [`POST ${api}/oauth2/token`]: () => [200, {
      access_token: "AT1-long-token", refresh_token: "RT1-long", expires_in: 3600, user_id: "ivanov" }],
    [`GET ${api}/conferences/0005439837/messages?page=1&page_size=50`]: (init) =>
      init.headers.Authorization === "Bearer AT1-long-token" ? [200, { list: [{ message: "Привет" }] }] : [401, {}],
  });
  let flowUrl = null;
  const identity = {
    getRedirectURL: () => "https://abc.extensions.allizom.org/",
    async launchWebAuthFlow({ url, interactive }) {
      flowUrl = new URL(url);
      if (!interactive) throw new Error("Requires user interaction");
      return `https://abc.extensions.allizom.org/?code=XYZ&state=${flowUrl.searchParams.get("state")}`;
    },
  };

  const client = new tc.TrueConfApi({ cfg: TC, store: db.meta, fetch });
  const { silent } = await client.login(identity);
  equal(silent, false, "сессии не было — понадобилось окно");
  equal(flowUrl.origin + flowUrl.pathname, "https://tc.example.ru/oauth2/authorize", "страница входа");
  equal(flowUrl.searchParams.get("client_id"), "cid", "ID приложения");
  equal(flowUrl.searchParams.get("redirect_uri"), "https://abc.extensions.allizom.org/", "адрес возврата");

  const exchange = fetch.calls[0].body;
  equal(exchange.grant_type, "authorization_code", "тип обмена");
  equal(exchange.auth_code, "XYZ", "код передаётся полем auth_code, как у TrueConf");
  equal(exchange.client_secret, "sec", "секрет приложения");

  const res = await client.conferenceMessages("0005439837");
  equal(res.status, 200, "чат конференции");
  equal(res.data.list[0].message, "Привет", "ответ сервера как есть");
  equal((await client.session()).userId, "ivanov", "кто вошёл");
});

test("TrueConf: вход по сохранённой сессии проходит без окна", async () => {
  const fetch = fakeFetch({
    "POST https://tc.example.ru/api/v4.1/oauth2/token": () => [200, { access_token: "AT", expires_in: 3600 }],
  });
  let windows = 0;
  const identity = {
    getRedirectURL: () => "https://abc.extensions.allizom.org/",
    async launchWebAuthFlow({ interactive }) {
      if (interactive) windows++;
      return "https://abc.extensions.allizom.org/?code=S1";
    },
  };
  const { silent } = await new tc.TrueConfApi({ cfg: TC, store: db.meta, fetch }).login(identity);
  equal(silent, true, "вход без окна");
  equal(windows, 0, "окно не открывалось");
});

test("TrueConf: 401 продлевает токен один раз, неудачное продление требует входа", async () => {
  const api = "https://tc.example.ru/api/v4.1";
  await db.meta.set(tc.SECRET_API, {
    access_token: "OLD", refresh_token: "RT", expires_at: Date.now() + 3600000 });

  let refreshOk = true;
  const fetch = fakeFetch({
    [`GET ${api}/me/token`]: (init) => (init.headers.Authorization === "Bearer NEW" ? [200, { ok: 1 }] : [401, {}]),
    [`POST ${api}/oauth2/token`]: () => (refreshOk
      ? [200, { access_token: "NEW", expires_in: 3600 }]
      : [400, { error: "invalid_grant" }]),
  });
  const client = new tc.TrueConfApi({ cfg: TC, store: db.meta, fetch });

  const res = await client.me();
  equal(res.status, 200, "после продления запрос прошёл");
  equal(fetch.calls.map((c) => c.method).join(","), "GET,POST,GET", "запрос, продление, повтор");
  equal(fetch.calls[1].body.grant_type, "refresh_token", "продление по refresh-токену");
  equal((await db.meta.get(tc.SECRET_API)).refresh_token, "RT", "старый refresh-токен сохранён");

  refreshOk = false;
  await db.meta.set(tc.SECRET_API, { access_token: "STALE", refresh_token: "RT", expires_at: 1 });
  let error = null;
  try { await client.me(); } catch (e) { error = e; }
  assert(error && /нужен вход/.test(error.message), "неудачное продление просит войти заново");
  equal(await db.meta.get(tc.SECRET_API), null, "токены стёрты");
});

test("TrueConf: токен бесед по паролю, пароль нигде не хранится", async () => {
  const fetch = fakeFetch({
    "POST https://tc.example.ru/bridge/api/client/v1/oauth/token": () =>
      [201, { access_token: "JWT1", token_type: "JWT", expires_at: 1761121632 }],
  });
  await tc.chatToken({ cfg: TC, store: db.meta, username: "ivanov", password: "qwerty", fetch });
  const body = fetch.calls[0].body;
  equal(body.client_id, "chat_bot", "клиент коннектора");
  equal(body.grant_type, "password", "вход по паролю");
  const saved = await db.meta.get(tc.SECRET_CHAT);
  equal(saved.access_token, "JWT1", "токен сохранён");
  equal(saved.expires_at, 1761121632000, "срок в мс");
  assert(!JSON.stringify(saved).includes("qwerty"), "пароля в хранилище нет");
});

test("TrueConf: беседы по WebSocket — авторизация, список, история, подтверждение событий", async () => {
  const sent = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      sent.push(msg);
      if (msg.type !== 1) return;
      const reply = (payload) => setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 2, id: msg.id, payload }) }), 0);
      if (msg.method === "auth") {
        reply({ userId: "ivanov@tc.example.ru/abc" });
        // Сервер сам присылает новое сообщение — клиент обязан подтвердить.
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({
          type: 1, id: 77, method: "sendMessage", payload: { chatId: "c1", content: { text: "Новое" } } }) }), 0);
      }
      if (msg.method === "getChats") reply({ chats: [{ chatId: "c1", title: "Отдел закупок" }] });
      if (msg.method === "getChatHistory") reply({ chatId: msg.payload.chatId, messages: [{ messageId: "m1" }] });
    }
    close() {}
  }

  const url = tc.chatSocketUrl(TC);
  equal(url, "wss://tc.example.ru/websocket/chat_bot/", "адрес коннектора");
  const sock = new tc.ChatSocket({ url, WebSocketImpl: FakeWS });
  const auth = await sock.connect("JWT1");
  equal(auth.userId, "ivanov@tc.example.ru/abc", "вошли от имени пользователя");
  equal(sent[0].payload.tokenType, "JWT", "тип токена");

  const chats = await sock.getChats();
  equal(chats.chats[0].title, "Отдел закупок", "список бесед");
  const history = await sock.getChatHistory("c1", 50);
  equal(history.messages[0].messageId, "m1", "история беседы");
  assert(sent.some((m) => m.type === 2 && m.id === 77), "событие сервера подтверждено");
  equal(sock.events[0].method, "sendMessage", "событие запомнено");
});

test("токены TrueConf не попадают в выгрузку состояния", async () => {
  await db.meta.set(tc.SECRET_API, { access_token: "SECRET-TOKEN" });
  await db.meta.set("enrich", { stats: { enriched: 1 } });

  const parts = [];
  await db.exportChunks((c) => parts.push(c));
  const text = parts.join("");
  const parsed = JSON.parse(text);
  assert(!text.includes("SECRET-TOKEN"), "токена нет в выгрузке");
  assert(parsed.stores.meta.some((r) => r.key === "enrich"), "остальное служебное на месте");
  const all = await db.exportAll();
  assert(!JSON.stringify(all).includes("SECRET-TOKEN"), "и в выгрузке одним объектом");

  const shown = tc.redact(JSON.stringify({ access_token: "abcdefghij", password: "qwerty12" }));
  assert(!shown.includes("efghij") && !shown.includes("ty12"), "в журнале токены и пароли обрезаны");
});


// --- проверки сборки на живом ящике ----------------------------------------

test("ограничитель запросов к модели не пропускает больше заданного", async () => {
  // Гонка прежнего варианта: слот освободился, ждущий разбужен, но ещё не
  // проснулся — и в этот промежуток входит новый запрос. Точка входа
  // подбирается числом переходов очереди микрозадач; прежний ограничитель
  // пропускал третий запрос при одном переходе.
  const tick = () => new Promise((r) => setTimeout(r, 0));
  async function attempt(hops) {
    const sem = new Semaphore(2);
    let now = 0;
    let peak = 0;
    const gates = [];
    const task = () => sem.run(async () => {
      now++;
      peak = Math.max(peak, now);
      await new Promise((r) => gates.push(r));
      now--;
    });
    const all = [task(), task(), task()];   // два работают, третий ждёт
    await tick();
    gates[0]();                              // первый освобождает слот
    let p = Promise.resolve();
    for (let i = 0; i < hops; i++) p = p.then(() => {});
    all.push(p.then(() => task()));          // новый запрос — в самый момент освобождения
    for (let k = 0; k < 10; k++) { await tick(); gates.forEach((g) => g()); }
    await Promise.all(all);
    return peak;
  }
  for (let hops = 0; hops <= 6; hops++) {
    equal(await attempt(hops), 2, `одновременно не больше двух (переходов очереди: ${hops})`);
  }
});

test("проверка модели: эталонные письма, JSON по схеме, рассуждающая модель видна", async () => {
  const answer = (label, extra = "") => ({
    choices: [{ message: { content: extra + JSON.stringify({ label, confidence: 0.9, reason: "цитата" }) } }],
  });
  const byBody = (body) => SAMPLES.find((s) => body.includes(s.body.slice(0, 30)));
  const fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    const sample = byBody(req.messages[1].content);
    // Модель ошибается на одном письме с информированием.
    const label = sample.subject.startsWith("Протокол") ? "task" : sample.expect;
    return { ok: true, json: async () => answer(label) };
  };
  const llm = { ...DEFAULTS.llm, endpoint: "http://model:8000", model: "test-7b" };
  const r = await checkModel({ llm, fetch });
  equal(r.total, 6, "писем");
  equal(r.validJson, 6, "все ответы — JSON");
  equal(r.schemaOk, 6, "все по схеме");
  equal(r.correct, 5, "верно 5 из 6");
  equal(r.reasoningDetected, false, "не рассуждающая");

  const thinking = async () => ({ ok: true, json: async () => answer("task", "<think>долго думаю</think>") });
  const t = await checkModel({ llm, fetch: thinking });
  equal(t.reasoningDetected, true, "блок рассуждений замечен");
  equal(t.validJson, 0, "с блоком рассуждений ответ не разбирается как JSON");

  const none = await checkModel({ llm: DEFAULTS.llm });
  equal(none.configured, false, "без эндпоинта проверка честно говорит, что модели нет");
});

test("проверка каталога: книги, поля карточек, в сводке нет ни имён, ни адресов", async () => {
  const browserStub = {
    addressBooks: {
      async list() {
        return [{ id: "local", name: "Личная", remote: false, readOnly: false },
          { id: "gal", name: "GAL организации", remote: true, readOnly: true }];
      },
    },
    contacts: {
      async list(id) { return id === "local" ? [{}, {}, {}] : []; },
      async quickSearch(q) {
        if (!q.includeRemote) return [];
        return [{ properties: {
          vCard: "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Иванов Иван\r\nTITLE:Начальник отдела\r\n" +
            "ORG:ООО Пример;Отдел закупок\r\nEMAIL:ivanov@example.ru\r\nEND:VCARD",
        } }];
      },
    },
  };
  const r = await checkDirectory({ browser: browserStub, query: "Иванов" });
  equal(r.books, 2, "книг");
  equal(r.remoteBooks, 1, "удалённых");
  equal(r.localContacts, 3, "карточек в локальных");
  equal(r.search.remote.results, 1, "найдено в удалённой");
  equal(r.search.remote.levelFields.title, true, "должность есть");
  equal(r.search.remote.levelFields.department, true, "подразделение есть");
  equal(r.search.remote.levelFields.manager, false, "руководителя нет");
  const text = JSON.stringify(r);
  assert(!/Иванов|ivanov|Начальник|закупок/.test(text), "в сводке только названия полей");
});

test("каталог: локальные книги вперёд, GAL по одному запросу, найденное кэшируется", async () => {
  await fresh();
  const calls = { local: 0, remote: 0 };
  const card = (email, extra = "") => ({ properties: {
    vCard: `BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Иванов Иван\r\nTITLE:Начальник отдела\r\n` +
      `ORG:ООО Пример;Отдел закупок\r\nEMAIL:${email}\r\n${extra}END:VCARD`,
  } });
  const browserStub = { contacts: {
    async quickSearch(q) {
      if (q.includeRemote) {
        calls.remote++;
        return q.searchString === "ivanov@example.ru" ? [card("ivanov@example.ru")] : [];
      }
      calls.local++;
      return q.searchString === "local@example.ru" ? [card("local@example.ru")] : [];
    },
  } };
  const cfg = { ...DEFAULTS.directory, pauseMs: 0 };
  const dir = new DirectoryLookup({ browser: browserStub, db, cfg });

  const known = await dir.level("ivanov@example.ru");
  equal(known.title, "Начальник отдела", "должность из карточки");
  equal(known.department, "Отдел закупок", "подразделение из ORG");
  equal(known.source, "remote", "нашлось в удалённой книге");
  equal(calls.local, 1, "сначала спрошены локальные книги");
  equal(calls.remote, 1, "в GAL один запрос");

  await dir.level("ivanov@example.ru");
  equal(calls.remote, 1, "повторный вопрос отвечает из кэша");
  equal((await db.get("people", "ivanov@example.ru")).directory.title, "Начальник отдела",
    "кэш лежит в people и переживёт перезапуск");

  const local = await dir.level("local@example.ru");
  equal(local.source, "local", "локальная книга отвечает без запроса в домен");
  equal(calls.remote, 1, "ради локального адреса в домен не ходили");

  const stranger = await dir.level("unknown@example.com");
  equal(stranger.found, false, "неизвестный адрес помечен как ненайденный");
  await dir.level("unknown@example.com");
  equal(calls.remote, 2, "ненайденное тоже кэшируется — домен не дёргаем повторно");

  // Потолок на сеанс: дальше расширение каталог не спрашивает.
  const capped = new DirectoryLookup({
    browser: browserStub, db, cfg: { ...cfg, maxPerSession: 0 } });
  const skipped = await capped.level("someone@example.ru");
  equal(skipped.found, false, "потолок запросов на сеанс соблюдается");
  equal(calls.remote, 2, "лишних запросов к домену нет");

  equal(levelOf({ properties: { JobTitle: "Инженер", Department: "ИТ" } }).title, "Инженер",
    "поля карточки Thunderbird читаются наравне с vCard");
});

test("отчёт о проверке: метрики по стадиям, ручные отметки, секретов нет", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["me@example.ru"]);
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  tb.addMessage(inbox, { ...msg("plain", 3) });
  tb.addMessage(inbox, { ...msg("news", 2), headers: { "List-Id": "<news.example.ru>" } });
  tb.addMessage(inbox, { ...msg("invite", 1), parts: [
    { contentType: "text/calendar", partName: "1", headers: {}, body: INVITE, size: 900 },
  ] });
  await scanner(tb).run("recent", { since: Date.now() - 30 * 86400000, until: null });
  await enricher(tb).run();

  const cfg = {
    ...DEFAULTS,
    llm: { ...DEFAULTS.llm, endpoint: "http://secret-model-host:8000", model: "qwen-test" },
    trueconf: { ...DEFAULTS.trueconf, server: "https://tc.secret.example", clientId: "cid-777",
      clientSecret: "SUPERSECRET" },
  };
  await db.meta.set(tc.SECRET_API, { access_token: "TOKEN-XYZ" });
  await db.meta.set("report:trueconf", { "Чат конференции": { ok: true, status: "200", ms: 120, at: 1 } });

  const me = new Set(["me@example.ru"]);
  const auto = await report.collect({
    db, cfg, me,
    gate: await gateReport({ db, me, cfg: cfg.gate, sampleSize: 20 }),
    env: { version: "0.3.0", release: false, buildDate: null, client: "Thunderbird 115.12.2", trialDaysLeft: 80 },
    trueconfSession: { scope: "conferences:read", hasRefresh: true },
  });
  const md = report.renderMarkdown({
    generatedAt: Date.now(), auto,
    manual: { "t2.offline": { status: "pass", note: "включено у всех" }, "t3.connect": { status: "fail", note: "" } },
  });

  for (const st of report.STAGES) assert(md.includes(`## ${st.id}. ${st.title}`), `раздел ${st.id}`);
  assert(md.includes("| Хранение всех сообщений офлайн включено во всех учётных записях | пройдено | включено у всех |"),
    "ручная отметка с комментарием");
  equal(auto.T2.formats.meetings, 1, "встреча из приглашения посчитана");
  equal(auto.T2.queue.done, 3, "дочитано писем");
  assert(md.includes("рассылка"), "причины отсева в отчёте");
  assert(md.includes("Чат конференции"), "итоги проверок TrueConf в отчёте");
  for (const secret of ["secret-model-host", "tc.secret.example", "SUPERSECRET", "cid-777", "TOKEN-XYZ",
    "me@example.ru", "ivanov@example.ru", "news@", "\"subject\""]) {
    assert(!md.includes(secret), `в отчёте нет «${secret}»`);
  }
});


// --- T4: дела из писем -------------------------------------------------------

/** Запись письма, как её оставляют проход и обогащение. */
function letter(id, extra = {}) {
  const key = `m:${id}@example.ru`;
  return {
    id: key, date: Date.now() - (extra.ageH ?? 1) * 3600000, subject: extra.subject ?? id,
    fromId: extra.from ?? "ivanov@example.ru", fromName: extra.fromName ?? "Иванов Иван",
    to: extra.to ?? ["me@example.ru"], cc: extra.cc ?? [], read: extra.read ?? true,
    enriched: 1, threadId: extra.threadId ?? key, thread: extra.thread ?? { root: null, parent: null, index: null },
    calendar: extra.calendar ?? [], conferences: extra.conferences ?? [], attachments: extra.attachments ?? [],
    bulk: extra.bulk ?? null, locations: ["account1|/INBOX"],
  };
}

test("дела: ветка, беседа Outlook и встреча склеиваются, рассылки — нет", async () => {
  const me = new Set(["me@example.ru"]);
  const rows = [
    letter("root", { subject: "Договор с подрядчиком", ageH: 50 }),
    letter("r1", { subject: "RE: Договор с подрядчиком", ageH: 40, threadId: "m:root@example.ru",
      thread: { root: "m:root@example.ru", parent: "m:root@example.ru", index: null } }),
    letter("r2", { subject: "RE: RE: Договор", ageH: 30, threadId: "m:root@example.ru",
      thread: { root: "m:root@example.ru", parent: "m:r1@example.ru", index: null }, read: false }),
    // Outlook без References, но в той же беседе по Thread-Index.
    letter("o1", { subject: "Смета", ageH: 20, thread: { root: null, parent: null, index: "ti:aa" } }),
    letter("o2", { subject: "Смета", ageH: 10, thread: { root: null, parent: null, index: "ti:aa" } }),
    // Приглашение и его перенос — разные ветки, одна встреча.
    letter("inv", { subject: "Сверка", ageH: 9, calendar: [{ kind: "meeting", method: "REQUEST", uid: "U1", sequence: 0, summary: "Сверка" }] }),
    letter("upd", { subject: "Перенос: Сверка", ageH: 8, calendar: [{ kind: "meeting", method: "REQUEST", uid: "U1", sequence: 1, summary: "Сверка (перенос)" }] }),
    // Рассылка делом не становится.
    letter("news", { subject: "Дайджест", ageH: 5, bulk: { listId: "<news.example.ru>" } }),
  ];
  const { cases } = buildCases(rows, { me });
  equal(cases.length, 3, "дел: ветка, беседа, встреча");

  const byTitle = Object.fromEntries(cases.map((c) => [c.title, c]));
  const contract = byTitle["Договор с подрядчиком"];
  equal(contract.counts.mail, 3, "ответ на ответ — в той же ветке");
  equal(contract.state, "new", "непрочитанный ответ — дело новое");
  equal(contract.letters[0].why, "начало ветки", "первое письмо — начало ветки");
  equal(contract.letters[2].why, "та же ветка", "почему в деле");

  const smeta = byTitle["Смета"];
  equal(smeta.counts.mail, 2, "беседа Outlook склеена по Thread-Index");
  equal(smeta.joinedBy.outlook, true, "склеено по беседе Outlook");

  const meet = byTitle["Сверка"];
  equal(meet.counts.mail, 2, "приглашение и перенос — одно дело");
  equal(meet.counts.meet, 1, "одна встреча");
  equal(meet.meetings[0].summary, "Сверка (перенос)", "последняя версия встречи");
  assert(meet.letters[1].why.startsWith("та же встреча"), "почему в деле — та же встреча");
  assert(!cases.some((c) => c.title === "Дайджест"), "рассылки в делах нет");
});

test("дела: конференция связывает дела, но не склеивает; свои письма не делают дело новым", async () => {
  const me = new Set(["me@example.ru"]);
  const conf = { key: "tc:tc|0005|планерка", id: "0005", topic: "Планёрка", host: "tc" };
  const rows = [
    letter("a", { subject: "Отчёт за квартал", conferences: [conf], read: false, from: "me@example.ru" }),
    letter("b", { subject: "Бюджет", conferences: [conf] }),
  ];
  const { cases, cross } = buildCases(rows, { me });
  equal(cases.length, 2, "одна комната — два разных дела");
  equal(cross.length, 1, "связь между делами");
  equal(cross[0].kind, "conf", "связь — через конференцию");
  assert(cross[0].why.includes("0005"), "в связи назван номер");
  const report = cases.find((c) => c.title === "Отчёт за квартал");
  equal(report.state, "wait", "своё непрочитанное письмо — не новость, но ответа ждём");
  equal(report.people.length, 0, "себя в участниках нет");
});

test("дела: разница между сборками — новое дело и письмо, пришедшее в известное дело", async () => {
  const me = new Set(["me@example.ru"]);
  const before = buildCases([letter("root", { subject: "Договор", ageH: 5 })], { me }).cases;
  const after = buildCases([
    letter("root", { subject: "Договор", ageH: 5 }),
    letter("r1", { subject: "RE: Договор", ageH: 1, threadId: "m:root@example.ru",
      thread: { root: "m:root@example.ru", parent: "m:root@example.ru", index: null } }),
    letter("x", { subject: "Новая тема", ageH: 1 }),
  ], { me }).cases;
  const ev = diffCases(before, after);
  equal(ev.filter((e) => e.kind === "letter").length, 1, "одно письмо в известное дело");
  equal(ev.filter((e) => e.kind === "case").length, 1, "одно новое дело");
  equal(before[0].id, after.find((c) => c.title === "Договор").id, "id дела не меняется с приходом писем");
  equal(displaySubject("RE: FW: Отв: Договор"), "Договор", "название дела без приставок");
});

test("дела: дело собирается с первого письма, а не с границы периода", async () => {
  await fresh();
  const me = new Set(["me@example.ru"]);
  const since = Date.now() - 30 * DAYS;
  await db.putMany("messages", [
    // Ветка началась два месяца назад, движение — вчера.
    letter("root", { subject: "Договор с подрядчиком", ageH: 24 * 60 }),
    letter("r1", { subject: "RE: Договор с подрядчиком", ageH: 24 * 45, threadId: "m:root@example.ru",
      thread: { root: "m:root@example.ru", parent: "m:root@example.ru", index: null } }),
    letter("r2", { subject: "RE: Договор с подрядчиком", ageH: 20, threadId: "m:root@example.ru",
      thread: { root: "m:root@example.ru", parent: "m:r1@example.ru", index: null }, read: false }),
    // Переписка, закончившаяся до периода: поднимать её незачем.
    letter("old", { subject: "Прошлогодняя смета", ageH: 24 * 70 }),
  ]);

  const loaded = await loadCaseRows(db, { since, me, cfg: DEFAULTS.cases });
  equal(loaded.history.added, 2, "подняты два ранних письма ветки");
  assert(!loaded.rows.some((r) => r.subject === "Прошлогодняя смета"), "чужая старая переписка не поднята");

  const { cases } = buildCases(loaded.rows, { me, cfg: DEFAULTS.cases, systems: loaded.systems, since });
  equal(cases.length, 1, "показано дело, в котором было движение");
  const c = cases[0];
  equal(c.counts.mail, 3, "в деле вся ветка, включая ранние письма");
  equal(c.id, "c:m:root@example.ru", "дело опознаётся по первому письму ветки");
  equal(c.letters[0].why, "начало ветки", "первое письмо — начало ветки");
  assert(c.startedBefore, "видно, что дело началось раньше периода");
  equal(c.early, 2, "два письма подняты как история");
  equal(c.unread, 1, "непрочитанное считается только в периоде");
  assert(c.firstAt < since && c.lastAt > since, "дело идёт от первого письма к последнему");

  const alone = buildCases([letter("old2", { subject: "Прошлое", ageH: 24 * 60 })], { me, since });
  equal(alone.cases.length, 0, "дело без движения за период не показывается");
});

test("дела: письма системы склеиваются по номеру объекта, дела системы связаны между собой", async () => {
  const me = new Set(["me@example.ru"]);
  const sd = { from: "noreply@sd.example.ru", fromName: "Service Desk" };
  const rows = [
    letter("i1", { ...sd, subject: "Инцидент INC0012345 зарегистрирован", ageH: 30 }),
    letter("i2", { ...sd, subject: "INC0012345: назначен исполнитель", ageH: 20 }),
    letter("i3", { ...sd, subject: "Инцидент INC0012345 решён", ageH: 10, read: false }),
    letter("i4", { ...sd, subject: "Инцидент INC0012400 зарегистрирован", ageH: 5 }),
  ];
  const { cases, systems } = buildCases(rows, { me, cfg: DEFAULTS.cases });
  equal(cases.length, 2, "два инцидента — два дела, а не одна куча писем");
  const inc = cases.find((c) => c.counts.mail === 3);
  equal(inc.joinedBy.system.object, "INC-0012345", "склеено по номеру инцидента");
  equal(inc.letters[0].why, "первое письмо о INC-0012345", "у первого письма — начало дела");
  equal(inc.letters[1].why, "тот же предмет: INC-0012345", "почему письмо в деле");
  equal(systems.length, 1, "одна система");
  equal(systems[0].cases.length, 2, "оба её дела связаны с ней");
  assert(systems[0].why.includes("noreply"), "сказано, почему отправитель — система");
  assert(inc.people[0].system, "в участниках система помечена");
});

test("дела: предмет из темы собирает письма разных людей, тема с участником — переписку", async () => {
  const me = new Set(["me@example.ru"]);
  const rows = [
    // Один предмет — разные отправители и разные ветки.
    letter("sd1", { from: "noreply@sd.example.ru", fromName: "Service Desk",
      subject: "Инцидент INC0012345 зарегистрирован", ageH: 60 }),
    letter("p1", { from: "petrov@example.ru", fromName: "Петров",
      subject: "По инциденту INC-12345 нужна информация", ageH: 50 }),
    letter("p2", { from: "sidorov@example.ru", fromName: "Сидоров",
      subject: "FW: Договор № 15 — замечания", ageH: 40, to: ["me@example.ru", "petrov@example.ru"] }),
    letter("p3", { from: "petrov@example.ru", fromName: "Петров",
      subject: "Договор 15: итоговая редакция", ageH: 30, to: ["me@example.ru"] }),
    // Ни References, ни Thread-Index — только тема и общий участник.
    letter("t1", { from: "petrov@example.ru", subject: "Внедрение учёта заявок", ageH: 20 }),
    letter("t2", { from: "sidorov@example.ru", subject: "Внедрение учёта заявок", ageH: 10,
      to: ["me@example.ru", "petrov@example.ru"] }),
    // Та же тема, но участники не пересекаются и разрыв больше срока.
    letter("t3", { from: "kuznecov@example.ru", subject: "Внедрение учёта заявок", ageH: 24 * 400 }),
  ];
  const { cases } = buildCases(rows, { me, cfg: DEFAULTS.cases });
  const byObject = cases.find((c) => c.object === "INC-0012345");
  equal(byObject.counts.mail, 2, "уведомление системы и письмо коллеги об одном инциденте — одно дело");
  assert(byObject.letters[1].why.includes("INC-12345"), "в плашке назван предмет");

  const contract = cases.find((c) => c.object && c.object.toLowerCase().includes("договор"));
  equal(contract.counts.mail, 2, "письма о договоре собраны по номеру");

  const rollout = cases.find((c) => c.title === "Внедрение учёта заявок" && c.counts.mail > 1);
  equal(rollout.counts.mail, 2, "тема и общий участник склеили переписку без References");
  equal(rollout.letters[1].why, "та же тема и общий участник", "почему письмо в деле");
  assert(rollout.weight > byObject.weight || rollout.counts.people >= 2, "у переписки с людьми вес выше");
  assert(cases.some((c) => c.title === "Внедрение учёта заявок" && c.counts.mail === 1),
    "давнее письмо без общих участников отдельным делом");

  // Объединение руками переживает пересборку.
  const manual = buildCases(rows, { me, cfg: DEFAULTS.cases,
    merges: [{ a: "m:t1@example.ru", b: "m:p3@example.ru" }] });
  const joined = manual.cases.find((c) => c.letters.some((l) => l.id === "m:t1@example.ru"));
  assert(joined.letters.some((l) => l.id === "m:p3@example.ru"), "дела объединены вручную");
  assert(joined.joinedBy.manual, "объединение руками названо в деле");
});

test("дела: система узнаётся по поведению, а обычный отправитель — нет", async () => {
  const me = new Set(["me@example.ru"]);
  const robot = [];
  for (let i = 1; i <= 6; i++) {
    robot.push(letter(`rep${i}`, { from: "svc@corp.example.ru", fromName: "Мониторинг",
      subject: `Отчёт о доступности за 0${i}.09.2026`, ageH: 100 - i }));
  }
  const built = buildCases(robot, { me, cfg: DEFAULTS.cases });
  equal(built.systems.length, 1, "система узнана без списка адресов: шаблонные темы, ни одного ответа");
  equal(built.cases.length, 1, "серия отчётов — одно дело");
  equal(built.cases[0].counts.mail, 6, "все письма серии вместе");
  equal(built.cases[0].joinedBy.system.object, null, "склеено темой, номера объекта в ней нет");

  // Тот же объём писем от живого человека, которому я отвечал, системой не считается.
  const human = [letter("mine", { from: "me@example.ru", to: ["petrov@example.ru"], subject: "Ответ" })];
  for (let i = 1; i <= 6; i++) {
    human.push(letter(`p${i}`, { from: "petrov@example.ru", fromName: "Петров",
      subject: `Отчёт о доступности за 0${i}.09.2026`, ageH: 100 - i }));
  }
  equal(buildCases(human, { me, cfg: DEFAULTS.cases }).systems.length, 0,
    "отправитель, которому вы писали, системой не считается");
  equal(objectId("Заявка № 12345 от 21.09.2026"), "№ 12345", "номер заявки узнаётся");
  equal(objectId("Протокол совещания от 18.09"), null, "дата номером объекта не считается");
  equal(subjectTemplate("RE: Отчёт за 21.09.2026"), "отчет за #", "тема с точностью до чисел");
});

// --- вспомогательное -----------------------------------------------------

/** Письмо для ручных сценариев: `ageDays` суток назад. */
function msg(name, ageDays) {
  return {
    mid: `<${name}@example.ru>`, date: Date.now() - ageDays * 86400000,
    author: "ivanov@example.ru", recipients: ["me@example.ru"],
    subject: name, size: 1000,
  };
}

async function rowsByMid() {
  const out = {};
  for (const r of await storedRows()) out[r.id.slice(2).split("@")[0]] = r;
  return out;
}

/** Thread-Index Outlook: 22 байта заголовка беседы и по 5 байт на ответ. */
function threadIndex(replies) {
  const bytes = [1, 0xd9, 0x2a, 0x10, 0x33, 0x44];
  for (let i = 0; i < 16; i++) bytes.push((i * 37 + 11) & 0xff);
  for (let r = 0; r < replies; r++) bytes.push(0, 0, 0x10 + r, 0, 0);
  return btoa(String.fromCharCode(...bytes));
}

const INVITE = [
  "BEGIN:VCALENDAR", "METHOD:REQUEST", "PRODID:Microsoft Exchange Server 2016",
  "BEGIN:VEVENT",
  "UID:040000008200E00074C5B7101A82E0080000000011",
  "SUMMARY;LANGUAGE=ru-RU:Еженедельная сверка",
  "  по договору",
  "DTSTART;TZID=Russian Standard Time:20260923T100000",
  "DTEND;TZID=Russian Standard Time:20260923T110000",
  "ORGANIZER;CN=Иванов И.:mailto:Ivanov@example.ru",
  "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:me@example.ru",
  "ATTENDEE;ROLE=OPT-PARTICIPANT:mailto:petrova@example.ru",
  "LOCATION:ВКС TrueConf",
  "BEGIN:VALARM", "TRIGGER:-PT15M", "ACTION:DISPLAY", "DESCRIPTION:REMINDER", "END:VALARM",
  "END:VEVENT", "END:VCALENDAR",
].join("\r\n");

const ACCEPTED = [
  "BEGIN:VCALENDAR", "METHOD:REPLY",
  "BEGIN:VEVENT",
  "UID:040000008200E00074C5B7101A82E0080000000011",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:petrova@example.ru",
  "END:VEVENT", "END:VCALENDAR",
].join("\r\n");


/** Чекпойнт с фиксированным временем старта: границы окон должны быть точными. */
async function seedCheckpoint(tb, startedAt) {
  const folders = [];
  for (const f of tb.folders) {
    folders.push({
      key: `${f.accountId}|${f.path}`, name: f.name, path: f.path,
      type: f.type ?? null, account: f.accountId,
    });
  }
  await db.checkpoint.save("full", {
    v: 2, scanId: "full", startedAt, folders, doneFolders: [], current: null,
    errors: [], done: false,
    stats: { headers: 0, stored: 0, merged: 0, duplicates: 0, queries: 0, pages: 0 },
  });
}

// --- запуск --------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  await fresh();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
    if (process.env.VERBOSE) console.log(e.stack);
  }
}

console.log(failed ? `\n${failed} из ${tests.length} не прошло` : `\nвсе ${tests.length} прошли`);
process.exit(failed ? 1 : 0);
