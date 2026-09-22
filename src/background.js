// Оркестровка. Держит проходы по ящику и проход обогащения и решает, какой
// из них сейчас уместен.
//
// Порядок работы — LIFO: сначала свежее, архивы потом.
//
//   recent         последние `recentDays` суток. Запускается при старте
//                  клиента и на приход новой почты. Занимает секунды.
//   enrich-recent  полные заголовки той же свежей почты — вслед, кроме писем
//                  моложе `freshDelayMinutes`: их клиент ещё сохраняет
//                  офлайн, и до них дойдёт повторный запуск по таймеру.
//   archive        всё, что старше. Только в простое, уступает свежему.
//   enrich         полные заголовки всего остального. Только в простое:
//                  getFull читает письмо целиком и может тянуть его с сервера.
//   enrich-now     «Обновить» во вкладке «Дела»: свежая почта без задержки —
//                  сознательно, с предупреждением, что письма моложе
//                  `freshDelayMinutes` клиент заберёт из Exchange.
//
// Одновременно идёт один проход. Шаги выстраиваются в цепочки; «Остановить»
// обрывает цепочку целиком, а не только текущий шаг.
//
// Модели здесь по-прежнему нет: классификация подключается поверх
// разобранного, когда гейт снимает нужную долю писем (T2 → T3).

import * as db from "./db.js";
import { Scanner } from "./scan.js";
import { Enricher } from "./enrich.js";
import { myAddresses } from "./me.js";
import { gateReport } from "./report.js";
import { buildCases, loadCaseRows } from "./cases.js";
import { findHeader } from "./locate.js";
import * as settings from "./settings.js";
import * as trial from "./trial.js";

const DAY = 86400000;
const RECENT = "recent";
const ARCHIVE = "archive";
const ENRICH_RECENT = "enrich-recent";
const ENRICH = "enrich";
const ENRICH_NOW = "enrich-now";
const CASES_PAGE = "src/ui/cases.html";
const CASES_BUTTON = "cases";
// Идут только в простое и уступают вернувшемуся пользователю.
const IDLE_ONLY = new Set([ARCHIVE, ENRICH]);
const PROGRESS_THROTTLE_MS = 500;
const NEW_MAIL_DEBOUNCE_MS = 10000;

let active = null;          // { id, runner, promise }
let chain = 0;              // номер живой цепочки; устаревшая молча сходит
let chainKind = null;       // "idle" — цепочка простоя, её отменяет пользователь
let lastProgress = null;
let lastEmit = 0;
let newMailTimer = null;
let freshTimer = null;
let badgeTimer = null;

function broadcast(progress, force = false) {
  lastProgress = progress;
  const now = Date.now();
  if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
  lastEmit = now;
  // Панель может быть закрыта — получателя нет, и это нормально.
  browser.runtime.sendMessage({ type: "scan.progress", progress }).catch(() => {});
}

// --- проходы -------------------------------------------------------------

const recentEdge = (cfg) => Date.now() - cfg.scan.recentDays * DAY;

function makeJob(id, cfg) {
  const onProgress = (p) => broadcast({ ...p, pass: id }, !p.running);

  if (id === RECENT || id === ARCHIVE) {
    const runner = new Scanner({ browser, db, config: cfg.scan, onProgress });
    const bounds = id === RECENT
      ? { since: recentEdge(cfg), until: null }
      : { since: null, until: recentEdge(cfg) };
    return { runner, start: () => runner.run(id, bounds) };
  }

  // «Обновить» во вкладке — по явной команде и без задержки для свежих писем.
  const config = id === ENRICH_NOW ? { ...cfg.enrich, freshDelayMinutes: 0 } : cfg.enrich;
  const runner = new Enricher({
    browser, db, config,
    hosts: cfg.trueconf.hosts, overlapDays: cfg.scan.overlapDays, onProgress,
  });
  // Неудачи прошлых раз возвращаются в очередь только на полном проходе:
  // свежему незачем тратить время на старые хвосты.
  const opts = id === ENRICH ? { since: null, requeue: true } : { since: recentEdge(cfg) };
  return { runner, start: () => runner.run(opts) };
}

/**
 * Запускает проход. Если идёт другой и новый важнее, прежний останавливается:
 * позиция уже на диске, поэтому остановка ничего не стоит.
 */
async function runPass(id, { preempt = false } = {}) {
  // Срок демоверсии останавливает разбор почты, но не доступ к уже
  // разобранному: выгрузка состояния работает всегда.
  if (!(await trial.allowsScanning())) {
    broadcast({ running: false, pass: id, trialExpired: true,
      error: "Срок работы демоверсии истёк" }, true);
    return null;
  }

  const cfg = await settings.load();
  if ((id === ENRICH || id === ENRICH_RECENT || id === ENRICH_NOW) && !cfg.enrich.enabled) return null;

  // Проверка и запуск — без await между ними: пока ждали вытесненный
  // проход, мог стартовать третий, и два прохода сразу — это проход по
  // ящику, затирающий свежие результаты обогащения старой копией письма.
  while (active) {
    if (active.id === id) return active.promise;
    if (!preempt) return null;
    const prev = active;
    prev.runner.stop();
    await prev.promise.catch(() => {});
  }

  const { runner, start } = makeJob(id, cfg);
  const promise = start()
    .catch((e) => {
      console.error("r7-triage: проход прерван", id, e);
      broadcast({ ...(lastProgress ?? {}), pass: id, running: false,
        error: String(e?.message ?? e) }, true);
    })
    .finally(() => {
      if (active?.runner === runner) active = null;
      scheduleBadge();
    });

  active = { id, runner, promise };
  return promise;
}

/**
 * Шаги по очереди. Новая цепочка отменяет прежнюю: та досматривает текущий
 * шаг (его останавливает вытеснение) и дальше не идёт.
 */
async function sequence(steps, kind = "command") {
  const mine = ++chain;
  chainKind = kind;
  try {
    for (const [id, opts] of steps) {
      if (mine !== chain) return;
      await runPass(id, opts);
    }
  } finally {
    if (mine === chain) chainKind = null;
  }
}

/** Свежая почта важнее всего остального и вытесняет работу в простое. */
const startRecent = () => sequence([
  [RECENT, { preempt: true }],
  [ENRICH_RECENT, {}],
]);

/**
 * Работа в простое. Архив разбирается, только если он нужен: незавершённый
 * проход продолжается, завершённый пересматривается не чаще, чем раз в
 * `archiveRecheckDays`. Обогащение идёт следом всегда — пустая очередь
 * заканчивается одним запросом к индексу.
 */
async function startIdleWork() {
  if (active) return null;
  const cfg = await settings.load();
  if (!cfg.scan.archiveOnIdle) return null;

  const cp = await db.checkpoint.load(ARCHIVE);
  const due = !cp || !cp.done
    || Date.now() - (cp.finishedAt ?? 0) > cfg.scan.archiveRecheckDays * DAY;
  return sequence([...(due ? [[ARCHIVE, {}]] : []), [ENRICH, {}]], "idle");
}

/** Явная команда из панели: всё, не дожидаясь простоя. */
const scanAll = () => sequence([
  [RECENT, { preempt: true }],
  [ENRICH_RECENT, {}],
  [ARCHIVE, { preempt: true }],
  [ENRICH, { preempt: true }],
]);

/** «Обновить» во вкладке «Дела»: свежая почта и её заголовки прямо сейчас. */
const refreshNow = () => sequence([
  [RECENT, { preempt: true }],
  [ENRICH_NOW, { preempt: true }],
]);

function stopAll() {
  chain++;
  active?.runner.stop();
}

// --- события клиента -----------------------------------------------------

async function installIdleWatch() {
  const cfg = await settings.load();
  if (!browser.idle) return;            // на всякий случай: API опционален
  browser.idle.setDetectionInterval(cfg.scan.idleSeconds);
  browser.idle.onStateChanged.addListener((state) => {
    if (state === "idle") {
      startIdleWork();
    } else if (state === "active" && (IDLE_ONLY.has(active?.id) || chainKind === "idle")) {
      // Пользователь вернулся — архив и обогащение ждут следующего простоя.
      // Цепочку простоя отменяем и между шагами, когда прохода нет.
      stopAll();
    }
  });
}

browser.messages.onNewMailReceived.addListener(async () => {
  // Почта приходит пачками, на каждое письмо дёргать проход незачем.
  clearTimeout(newMailTimer);
  newMailTimer = setTimeout(startRecent, NEW_MAIL_DEBOUNCE_MS);

  // Только что пришедшие письма обогащение пока пропускает — клиент ещё
  // сохраняет их офлайн. Дочитываем, когда задержка пройдёт.
  const { enrich } = await settings.load();
  if (!enrich.enabled || !enrich.freshDelayMinutes) return;
  clearTimeout(freshTimer);
  // Не цепочкой: новая цепочка отменила бы идущую. Если сейчас занят другой
  // проход, эти письма подберёт обогащение, которое идёт за ним следом.
  freshTimer = setTimeout(() => runPass(ENRICH_RECENT),
    (enrich.freshDelayMinutes + 1) * 60000);
});

/** Обратный секундомер при запуске — с 30-го дня и до конца срока. */
async function showCountdown() {
  const t = await trial.state();
  if (!t.countdown) return;
  try {
    await browser.windows.create({
      url: browser.runtime.getURL("src/ui/trial.html"),
      type: "popup", width: 420, height: 340,
    });
  } catch (e) {
    console.warn("r7-triage: окно демоверсии не открылось", e);
  }
}

browser.runtime.onStartup.addListener(async () => {
  await showCountdown();
  const cfg = await settings.load();
  if (!cfg.scan.autoResume) return;
  // Клиент на старте занят подключением учётных записей — не мешаем ему.
  setTimeout(startRecent, 15000);
});

browser.runtime.onInstalled.addListener(showCountdown);

// --- панель --------------------------------------------------------------

/**
 * Сводка для панели. Чекпойнт целиком сюда не кладём: в нём список всех
 * папок, а панель опрашивает состояние раз в секунду.
 */
async function status() {
  const s = active?.runner.status() ?? { running: false, stopping: false };
  const checkpoints = (await db.checkpoint.list()).map((c) => ({
    scanId: c.scanId,
    done: Boolean(c.done),
    folders: c.folders?.length ?? 0,
    doneFolders: c.doneFolders?.length ?? 0,
    stored: c.stats?.stored ?? 0,
    errors: c.errors?.length ?? 0,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt ?? null,
    savedAt: c.savedAt,
  }));

  const enrich = await db.meta.get("enrich");
  const cfg = await settings.load();
  const freshDelay = cfg.enrich.freshDelayMinutes;
  const young = freshDelay
    ? await db.countEnrich(db.ENRICH.PENDING, Date.now() - freshDelay * 60000) : 0;
  return {
    ...s,
    pass: active?.id ?? null,
    progress: s.progress ?? lastProgress,
    checkpoints,
    counts: await db.stats(),
    enrich: {
      counts: await db.enrichCounts(),
      error: enrich?.error ?? null,
      finishedAt: enrich?.finishedAt ?? null,
      savedAt: enrich?.savedAt ?? null,
      young,
      freshDelayMinutes: freshDelay,
      enabled: cfg.enrich.enabled,
    },
    trial: await trial.state(),
  };
}

/** Замер гейта по всей базе. Результат запоминается для страницы состояния. */
async function runGateReport() {
  const cfg = await settings.load();
  const me = await myAddresses(browser, cfg.me.aliases);
  // Выборка отсеянных — для проверки глазами на странице состояния.
  const report = await gateReport({ db, me, cfg: cfg.gate, sendersCfg: cfg.senders, sampleSize: 20 });
  report.myAddresses = me.size;
  await db.meta.set("gate:report", report);
  return report;
}

// --- вкладка «Дела» -----------------------------------------------------------

/**
 * Кнопка «Дела» на панели пространств (spacesToolbar, с TB 100): открывает
 * вкладку и показывает бейдж — сколько дел с непрочитанными письмами.
 */
async function installCasesButton() {
  if (!browser.spacesToolbar) return;
  const icon = (theme) => `src/ui/icons/cases-${theme}.svg`;
  try {
    await browser.spacesToolbar.addButton(CASES_BUTTON, {
      title: "Дела",
      url: browser.runtime.getURL(CASES_PAGE),
      defaultIcons: "src/ui/icons/cases-dark.svg",
      // dark — значок для светлой темы, light — для тёмной.
      themeIcons: [16, 32].map((size) => ({ dark: icon("dark"), light: icon("light"), size })),
    });
  } catch (e) {
    console.warn("r7-triage: кнопка «Дела» не добавлена", e);
  }
  scheduleBadge();
}

/** Бейдж пересчитывается после каждого прохода, не чаще раза в 10 с. */
function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => updateBadge().catch(() => {}), 10000);
}

async function updateBadge() {
  const cfg = await settings.load();
  const me = await myAddresses(browser, cfg.me.aliases);
  const since = Date.now() - cfg.cases.periodDays * DAY;
  const { rows, systems } = await loadCaseRows(db,
    { since, me, cfg: cfg.cases, sendersCfg: cfg.senders });
  const { cases } = buildCases(rows,
    { me, gateCfg: cfg.gate, cfg: cfg.cases, sendersCfg: cfg.senders, systems, since });
  const fresh = cases.filter((c) => c.state === "new").length;
  try {
    await browser.spacesToolbar?.updateButton(CASES_BUTTON, {
      badgeText: fresh ? (fresh > 99 ? "99+" : String(fresh)) : "",
      badgeBackgroundColor: "#0f6cbd",
    });
  } catch { /* кнопки нет — клиент без панели пространств */ }
  return { fresh, cases: cases.length };
}

async function sessionHeader(id) {
  const row = await db.get("messages", id);
  if (!row) throw new Error("письма нет в базе");
  const hdr = await findHeader(browser, row);
  if (!hdr) throw new Error("письмо не найдено в папках — возможно, перенесено или удалено");
  return hdr;
}

async function openLetter(id) {
  const hdr = await sessionHeader(id);
  await browser.messageDisplay.open({ messageId: hdr.id, location: "tab" });
  return { ok: true };
}

/** Только черновик: окно ответа открывается, отправляет человек. */
async function replyToLetter(id) {
  const hdr = await sessionHeader(id);
  await browser.compose.beginReply(hdr.id, "replyToAll");
  return { ok: true };
}

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.cmd) {
    case "scan.start":
      if (msg.scope === "recent") { startRecent(); }
      else if (msg.scope === "archive") { sequence([[ARCHIVE, { preempt: true }]]); }
      else if (msg.scope === "enrich") { sequence([[ENRICH, { preempt: true }]]); }
      else { scanAll(); }
      return status();
    case "scan.stop":   stopAll(); return status();
    case "scan.status": return status();
    case "scan.forget": return db.checkpoint.clear(msg.scanId).then(() => ({ ok: true }));
    case "db.stats":    return db.stats();
    case "gate.report": return runGateReport();
    case "cases.refresh": refreshNow(); return status();
    case "cases.badge":  return updateBadge();
    case "letter.open":  return openLetter(msg.id);
    case "letter.reply": return replyToLetter(msg.id);
    case "db.reset":    return db.reset().then(() => ({ ok: true }));
    default:            return undefined;
  }
});

installIdleWatch();
installCasesButton();
