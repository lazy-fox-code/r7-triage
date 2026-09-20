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
import { install, resetFakeIndexedDB } from "./fake-idb.js";
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
const trial = await import(`${SRC}trial.js`);

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
/** Подменяет отметки срока так, будто прошло указанное число дней. */
function agedTrial(daysUsed, { watermarkAhead = 0 } = {}) {
  const now = Date.now();
  storage.set("trial", {
    installedAt: now - daysUsed * DAYS,
    watermark: now + watermarkAhead * DAYS,
  });
}

const config = (over = {}) => ({ ...DEFAULTS.scan, ...over });

function scanner(tb, over = {}) {
  return new Scanner({ browser: tb.api, db, config: config(over) });
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
  console.log(`    (это скорость движка на заглушках, не Thunderbird:` +
    ` там цену задаёт messages.query)`);
});

// --- вспомогательное -----------------------------------------------------

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
