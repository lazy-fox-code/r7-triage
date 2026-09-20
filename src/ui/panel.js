// Панель: запуск и остановка прохода, живой прогресс, переходы к выгрузке
// и настройкам. Всё тяжёлое делает фон — здесь только отображение.

import { formatLeft } from "../trial.js";

const $ = (id) => document.getElementById(id);
const num = (n) => (n == null ? "—" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "));

function duration(ms) {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} ч ${m} мин` : m ? `${m} мин ${s % 60} с` : `${s} с`;
}

const PASS_NAME = { recent: "свежая почта", archive: "архив" };

function renderTrial(t) {
  if (!t) return;
  const box = $("trial");
  box.hidden = !t.countdown && !t.expired;
  box.classList.toggle("over", Boolean(t.expired));
  box.textContent = t.expired
    ? "Срок демоверсии истёк. Разбор почты остановлен, выгрузка работает."
    : `Демоверсия: осталось ${formatLeft(t.msLeft)}`;
}

function render(state) {
  const p = state?.progress;
  const running = Boolean(state?.running);

  renderTrial(state?.trial);

  $("start").hidden = running;
  $("startRecent").hidden = running;
  $("stop").hidden = !running;
  $("stop").textContent = state?.stopping ? "Останавливается…" : "Остановить";
  $("stop").disabled = Boolean(state?.stopping);

  if (!p) {
    $("note").textContent = state?.counts?.messages
      ? `В базе ${num(state.counts.messages)} писем. Проход не запущен.`
      : "Проход ни разу не запускался.";
    return;
  }

  const share = p.foldersTotal ? p.foldersDone / p.foldersTotal : 0;
  $("bar").firstElementChild.style.width = `${Math.round(share * 100)}%`;
  $("folder").textContent = p.folder ?? "";
  $("folders").textContent = `${p.foldersDone} / ${p.foldersTotal}`;
  $("stored").textContent = num(p.stats?.stored);
  $("merged").textContent = num(p.stats?.merged);
  $("dups").textContent = num(p.stats?.duplicates);
  $("rate").textContent = num(p.rate);
  $("elapsed").textContent = duration(p.elapsedMs);
  $("errors").textContent = num(p.errors ?? 0);

  const pass = PASS_NAME[p.pass] ?? "проход";
  $("note").textContent = p.error ? `Ошибка: ${p.error}`
    : p.done ? `Разбор завершён: ${pass}.`
    : running ? `Идёт разбор: ${pass}. Клиент можно закрыть — разбор продолжится с этого места.`
    : "Остановлено. Архив дочитается в простое, новая почта — сразу при получении.";
}

async function refresh() {
  render(await browser.runtime.sendMessage({ cmd: "scan.status" }));
}

async function start(scope) {
  render(await browser.runtime.sendMessage({ cmd: "scan.start", scope }));
  setTimeout(refresh, 300);
}

$("start").addEventListener("click", () => start("all"));
$("startRecent").addEventListener("click", () => start("recent"));

$("stop").addEventListener("click", async () => {
  render(await browser.runtime.sendMessage({ cmd: "scan.stop" }));
});

const openTab = (page) => browser.tabs.create({ url: browser.runtime.getURL(page) });
$("export").addEventListener("click", () => openTab("src/ui/state.html"));
$("settings").addEventListener("click", () => browser.runtime.openOptionsPage());

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "scan.progress") render({ running: msg.progress.running, progress: msg.progress });
});

refresh();
// Панель открыта редко и ненадолго — секундного опроса достаточно и он
// страхует на случай, если широковещательное сообщение до неё не дошло.
setInterval(refresh, 1000);
