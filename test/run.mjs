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

test("повторный проход по неизменному ящику ничего не переписывает", async () => {
  const tb = generate(new FakeThunderbird(), { messages: 300, seed: 3 });
  await scanner(tb).run("full");
  const before = await db.count("messages");

  tb.restart();
  const s = scanner(tb);
  await s.run("full");

  const state = await db.checkpoint.load("full");
  equal(await db.count("messages"), before, "число писем");
  equal(state.stats.stored, 0, "новых записей во втором проходе");
  assert(state.stats.duplicates >= before, "повторы должны быть распознаны");
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

test("обогащение идёт от свежих писем к старым", async () => {
  const tb = generate(new FakeThunderbird(), { messages: 600, foldersPerAccount: 4, seed: 17 });
  await scanner(tb).run("full");
  await enricher(tb, { batchSize: 50 }).run();

  const log = tb.fullLog;
  equal(log.length, 600, "прочитано писем");
  assert(log.every((d, i) => i === 0 || d <= log[i - 1]),
    "каждое следующее прочитанное письмо не новее предыдущего");
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

test("замер гейта считает долю снятых писем по всей базе", async () => {
  const tb = new FakeThunderbird();
  tb.addAccount("account1", "Ящик", ["me@example.ru"]);
  const inbox = tb.addFolder("account1", "/INBOX", { name: "Входящие", type: "inbox" });
  for (let i = 0; i < 6; i++) {
    tb.addMessage(inbox, { ...msg(`bulk${i}`, 20 + i), headers: { "List-Id": "<news.example.ru>" } });
  }
  for (let i = 0; i < 2; i++) tb.addMessage(inbox, msg(`direct${i}`, 10 + i));
  tb.addMessage(inbox, { ...msg("mine", 5), author: "me@example.ru" });

  await scanner(tb).run("full");
  await enricher(tb).run();

  const report = await gateReport({ db, me: new Set(["me@example.ru"]), cfg: DEFAULTS.gate });
  equal(report.total, 9, "писем всего");
  equal(report.own, 1, "моих");
  equal(report.noise, 6, "шума");
  equal(report.model, 2, "в модель");
  equal(report.removedShare, 0.75, "доля снятых гейтом");
  equal(report.reasons["noise: рассылка"], 6, "разбивка по причинам");
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
