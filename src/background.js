// Оркестровка. Держит два прохода по ящику и решает, какой из них сейчас
// уместен.
//
// Порядок работы — LIFO: сначала свежее, архивы потом.
//
//   recent   последние `recentDays` суток. Запускается при старте клиента и
//            на приход новой почты. Занимает секунды и разбирает ровно то,
//            что пользователь видит перед собой.
//   archive  всё, что старше. Идёт только в простое и немедленно уступает
//            дорогу свежему проходу: разбор архивов не должен ощущаться.
//
// Модели здесь нет и на этом этапе быть не должно: T1 — это перечисление
// писем и разбор заголовков. Классификация подключается отдельным проходом
// поверх уже разобранного, когда дешёвые признаки отработают (T2).

import * as db from "./db.js";
import { Scanner } from "./scan.js";
import * as settings from "./settings.js";
import * as trial from "./trial.js";

const DAY = 86400000;
const RECENT = "recent";
const ARCHIVE = "archive";
const PROGRESS_THROTTLE_MS = 500;
const NEW_MAIL_DEBOUNCE_MS = 10000;

let active = null;          // { scanId, scanner, promise }
let lastProgress = null;
let lastEmit = 0;
let newMailTimer = null;

function broadcast(progress, force = false) {
  lastProgress = progress;
  const now = Date.now();
  if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
  lastEmit = now;
  // Панель может быть закрыта — получателя нет, и это нормально.
  browser.runtime.sendMessage({ type: "scan.progress", progress }).catch(() => {});
}

// --- проходы -------------------------------------------------------------

async function bounds(scanId, cfg) {
  const edge = Date.now() - cfg.scan.recentDays * DAY;
  return scanId === RECENT
    ? { since: edge, until: null }
    : { since: null, until: edge };
}

/**
 * Запускает проход. Если идёт другой и новый важнее, прежний останавливается:
 * чекпойнт уже на диске, поэтому остановка ничего не стоит.
 */
async function runPass(scanId, { preempt = false } = {}) {
  // Срок демоверсии останавливает разбор почты, но не доступ к уже
  // разобранному: выгрузка состояния работает всегда.
  if (!(await trial.allowsScanning())) {
    broadcast({ running: false, pass: scanId, trialExpired: true,
      error: "Срок работы демоверсии истёк" }, true);
    return null;
  }

  if (active) {
    if (active.scanId === scanId) return active.promise;
    if (!preempt) return null;
    active.scanner.stop();
    await active.promise.catch(() => {});
  }

  const cfg = await settings.load();
  const scanner = new Scanner({
    browser,
    db,
    config: cfg.scan,
    onProgress: (p) => broadcast({ ...p, pass: scanId }, !p.running),
  });

  const promise = scanner.run(scanId, await bounds(scanId, cfg))
    .catch((e) => {
      console.error("r7-triage: проход прерван", scanId, e);
      broadcast({ ...(lastProgress ?? {}), pass: scanId, running: false,
        error: String(e?.message ?? e) }, true);
    })
    .finally(() => { if (active?.scanId === scanId) active = null; });

  active = { scanId, scanner, promise };
  return promise;
}

/** Свежая почта важнее всего остального и вытесняет разбор архивов. */
const startRecent = () => runPass(RECENT, { preempt: true });

/**
 * Архив разбирается, только если он вообще нужен: незавершённый проход
 * продолжается, завершённый пересматривается не чаще, чем раз в
 * `archiveRecheckDays` — за это время успевает состариться новая почта.
 */
async function startArchiveIfDue() {
  if (active) return null;
  const cfg = await settings.load();
  if (!cfg.scan.archiveOnIdle) return null;

  const cp = await db.checkpoint.load(ARCHIVE);
  const due = !cp || !cp.done
    || Date.now() - (cp.finishedAt ?? 0) > cfg.scan.archiveRecheckDays * DAY;
  return due ? runPass(ARCHIVE) : null;
}

/** Явная команда из панели: разобрать всё, не дожидаясь простоя. */
async function scanAll() {
  await startRecent();
  return runPass(ARCHIVE, { preempt: true });
}

// --- события клиента -----------------------------------------------------

async function installIdleWatch() {
  const cfg = await settings.load();
  if (!browser.idle) return;            // на всякий случай: API опционален
  browser.idle.setDetectionInterval(cfg.scan.idleSeconds);
  browser.idle.onStateChanged.addListener((state) => {
    if (state === "idle") {
      startArchiveIfDue();
    } else if (state === "active" && active?.scanId === ARCHIVE) {
      // Пользователь вернулся — архив ждёт следующего простоя.
      active.scanner.stop();
    }
  });
}

browser.messages.onNewMailReceived.addListener(() => {
  // Почта приходит пачками, на каждое письмо дёргать проход незачем.
  clearTimeout(newMailTimer);
  newMailTimer = setTimeout(startRecent, NEW_MAIL_DEBOUNCE_MS);
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
  const s = active?.scanner.status() ?? { running: false, stopping: false };
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

  return {
    ...s,
    pass: active?.scanId ?? null,
    progress: s.progress ?? lastProgress,
    checkpoints,
    counts: await db.stats(),
    trial: await trial.state(),
  };
}

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.cmd) {
    case "scan.start":
      if (msg.scope === "recent") { startRecent(); }
      else if (msg.scope === "archive") { runPass(ARCHIVE, { preempt: true }); }
      else { scanAll(); }
      return status();
    case "scan.stop":   active?.scanner.stop(); return status();
    case "scan.status": return status();
    case "scan.forget": return db.checkpoint.clear(msg.scanId).then(() => ({ ok: true }));
    case "db.stats":    return db.stats();
    case "db.reset":    return db.reset().then(() => ({ ok: true }));
    default:            return undefined;
  }
});

installIdleWatch();
