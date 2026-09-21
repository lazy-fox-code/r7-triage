// Отчёт о проверке: ручные отметки, проверки модели и каталога, сборка файла.

import * as db from "../db.js";
import * as settings from "../settings.js";
import * as trial from "../trial.js";
import { BUILD_DATE_MS } from "../build-info.js";
import { STAGES, STATUS, collect, renderMarkdown } from "../check-report.js";
import { gateReport } from "../report.js";
import { myAddresses } from "../me.js";
import { checkModel } from "../model-check.js";
import { checkDirectory } from "../directory-check.js";
import { TrueConfApi } from "../trueconf-api.js";

const $ = (id) => document.getElementById(id);
const MANUAL = "report:manual";

let manual = {};
let lastMarkdown = "";

// --- ручные проверки -------------------------------------------------------

function stageBlock(st) {
  const section = document.createElement("section");
  const h = document.createElement("h2");
  h.textContent = `${st.id}. ${st.title}`;
  const headline = document.createElement("div");
  headline.className = "headline muted";
  headline.id = `headline-${st.id}`;
  section.append(h, headline);

  // Автоматические проверки, которые запускаются отсюда.
  if (st.id === "T3") {
    section.append(actionRow("Проверить модель на 6 эталонных письмах", runModelCheck,
      "Уходят только выдуманные письма, реальная почта в модель не отправляется."));
  }
  if (st.id === "T5") {
    const row = actionRow("Проверить адресные книги", runDirectoryCheck,
      "Имя или адрес коллеги нужны для пробного поиска; в отчёт они не попадают.");
    const input = document.createElement("input");
    input.type = "text";
    input.id = "dirQuery";
    input.placeholder = "имя или адрес коллеги";
    row.prepend(input);
    section.append(row);
  }
  if (st.id === "T9") {
    section.append(actionRow("Открыть подключение и проверку TrueConf", () =>
      browser.tabs.create({ url: browser.runtime.getURL("src/ui/trueconf.html") })));
  }

  const table = document.createElement("table");
  for (const [id, text] of st.checks) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.className = "check";
    td1.textContent = text;
    const td2 = document.createElement("td");
    const sel = document.createElement("select");
    for (const [k, label] of Object.entries(STATUS)) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = label;
      sel.append(o);
    }
    sel.value = manual[id]?.status ?? "skip";
    const td3 = document.createElement("td");
    const note = document.createElement("input");
    note.placeholder = "комментарий";
    note.value = manual[id]?.note ?? "";
    const store = () => {
      manual[id] = { status: sel.value, note: note.value.trim() };
      db.meta.set(MANUAL, manual);
    };
    sel.addEventListener("change", store);
    note.addEventListener("change", store);
    td2.append(sel);
    td3.append(note);
    tr.append(td1, td2, td3);
    table.append(tr);
  }
  section.append(table);
  return section;
}

function actionRow(label, fn, hint) {
  const row = document.createElement("div");
  row.className = "row";
  const btn = document.createElement("button");
  btn.textContent = label;
  const out = document.createElement("span");
  out.className = "muted";
  if (hint) out.textContent = hint;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    out.textContent = "Идёт проверка…";
    try {
      out.textContent = await fn();
      await refresh();
    } catch (e) {
      out.textContent = `Не получилось: ${e?.message ?? e}`;
    } finally {
      btn.disabled = false;
    }
  });
  row.append(btn, out);
  return row;
}

// --- проверки, запускаемые отсюда ----------------------------------------

async function runModelCheck() {
  const { llm } = await settings.load();
  const r = await checkModel({ llm });
  await db.meta.set("report:model", r);
  if (!r.configured) return r.error;
  return `Ответили ${r.answered} из ${r.total}, верно ${r.correct}, JSON ${r.validJson}` +
    `${r.reasoningDetected ? ", модель рассуждающая — не годится для батча" : ""}.`;
}

async function runDirectoryCheck() {
  const r = await checkDirectory({ browser, query: $("dirQuery").value });
  await db.meta.set("report:directory", r);
  return `Книг ${r.books}, удалённых ${r.remoteBooks}.` +
    (r.search?.remote?.error ? ` Поиск в удалённых: ${r.search.remote.error}` : "");
}

// --- метрики и файл -----------------------------------------------------

async function environment() {
  const info = await browser.runtime.getBrowserInfo().catch(() => null);
  const t = await trial.state();
  return {
    version: browser.runtime.getManifest().version,
    release: Boolean(BUILD_DATE_MS),
    buildDate: BUILD_DATE_MS ? new Date(BUILD_DATE_MS).toISOString().slice(0, 10) : null,
    client: info ? `${info.name} ${info.version}` : "—",
    trialDaysLeft: t.daysLeft ?? null,
  };
}

async function refresh() {
  $("status").textContent = "Собираю метрики…";
  const cfg = await settings.load();
  const me = await myAddresses(browser, cfg.me.aliases);
  const gate = await gateReport({ db, me, cfg: cfg.gate });
  const session = await new TrueConfApi({ cfg: cfg.trueconf, store: db.meta }).session();
  const auto = await collect({
    db, cfg, env: await environment(), gate, me, trueconfSession: session,
  });
  lastMarkdown = renderMarkdown({ generatedAt: Date.now(), auto, manual });
  $("preview").textContent = lastMarkdown;
  // Главная цифра каждой стадии — из той же сводки, что и в файле.
  for (const line of lastMarkdown.split("\n")) {
    const m = /^\| (T\d+)\. [^|]+\|(?:[^|]*\|){3} (.*) \|$/.exec(line);
    if (m && $(`headline-${m[1]}`)) $(`headline-${m[1]}`).textContent = m[2];
  }
  $("status").textContent = `Обновлено ${new Date().toLocaleTimeString("ru-RU")}.`;
}

$("refresh").addEventListener("click", refresh);

$("save").addEventListener("click", async () => {
  await refresh();
  const blob = new Blob([lastMarkdown], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const v = browser.runtime.getManifest().version;
  a.download = `r7-triage-${v}-проверка-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

manual = (await db.meta.get(MANUAL)) ?? {};
for (const st of STAGES) $("stages").append(stageBlock(st));
refresh();
