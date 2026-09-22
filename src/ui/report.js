// Отчёт о проверке: ручные отметки, проверки модели и каталога, сборка файла.

import * as db from "../db.js";
import * as settings from "../settings.js";
import * as trial from "../trial.js";
import { BUILD_DATE_MS } from "../build-info.js";
import { STAGES, STATUS, collect, renderMarkdown, casesSummary } from "../check-report.js";
import { buildCases, loadCaseRows } from "../cases.js";
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
    section.append(requestBlock("Что запросить у команды LLM", "llmRequest", "запрос-команде-llm.txt"));
  }
  if (st.id === "T4") {
    section.append(actionRow("Открыть вкладку «Дела»", () =>
      browser.tabs.create({ url: browser.runtime.getURL("src/ui/cases.html") })));
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

/** Готовый текст запроса: показать, скопировать, сохранить файлом. */
function requestBlock(title, id, filename) {
  const box = document.createElement("details");
  const sum = document.createElement("summary");
  sum.textContent = title;
  const pre = document.createElement("pre");
  pre.id = id;
  pre.style.whiteSpace = "pre-wrap";
  const row = document.createElement("div");
  row.className = "row";
  const copy = document.createElement("button");
  copy.textContent = "Скопировать";
  copy.addEventListener("click", () => navigator.clipboard.writeText(pre.textContent));
  const save = document.createElement("button");
  save.textContent = "Сохранить файлом";
  save.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([pre.textContent], { type: "text/plain" }));
    a.download = filename;
    document.body.append(a); a.click(); a.remove();
  });
  row.append(copy, save);
  box.append(sum, pre, row);
  return box;
}

/**
 * Запрос команде LLM. Объём — по этому ящику: писем в день за 30 дней и
 * доля писем, которые отсев без модели не снимает.
 */
function llmRequestText({ perDay, modelShare, check }) {
  const toModel = perDay != null && modelShare != null ? Math.round(perDay * modelShare) : null;
  return [
    "Запрос команде LLM — расширение R7 Triage для Р7-Органайзера",
    "",
    "Расширение разбирает почту сотрудника: поручение, информирование или шум.",
    "Очевидное (рассылки, автоответы) снимается без модели; остальное уходит в",
    "модель: тема, отправитель и до 4000 знаков текста письма. Ответ — JSON по",
    "схеме. Других сетевых адресатов, кроме модели и сервера TrueConf, нет.",
    "",
    "Что нужно от эндпоинта:",
    "1. OpenAI-совместимый POST /v1/chat/completions во внутренней сети; HTTPS",
    "   с сертификатом, которому доверяет клиент (самоподписанный не пройдёт).",
    "2. Фиксация формата ответа схемой: guided_json (vLLM) или grammar/GBNF",
    "   (llama.cpp). Какой механизм у вас?",
    "3. Instruct-модель 7–14B с хорошим русским (например, Qwen2.5-7B/14B-Instruct).",
    "   Рассуждающие модели (DeepSeek-R1 и дистилляты) не подходят: блок",
    "   рассуждений перед ответом убивает пропускную способность на потоке писем.",
    "4. Не меньше 3 одновременных запросов от одного пользователя; цель — до 2 с",
    "   на письмо (вход ~1500 токенов, выход до 400).",
    "5. Контекст не меньше 8 тысяч токенов.",
    "6. Авторизация: без ключа во внутренней сети или статический ключ",
    "   (Authorization: Bearer).",
    "7. Тексты писем не сохраняются на хосте модели — ни в журналах запросов,",
    "   ни в кэшах. Прошу подтвердить письменно.",
    "",
    "Прошу сообщить: адрес эндпоинта, имя модели (поле model), квантизацию,",
    "лимиты одновременных запросов и частоты, способ авторизации, механизм",
    "фиксации формата, политику журналирования.",
    "",
    toModel != null
      ? `Оценка нагрузки по одному ящику: ~${perDay} писем в день, до модели доходит ` +
        `~${Math.round(modelShare * 100)} % — около ${toModel} запросов в день на пользователя, ` +
        "плюс разовый разбор архива."
      : "Оценка нагрузки появится после разбора ящика (страница «Отчёт о проверке»).",
    check?.configured
      ? `Тестовая проверка: ответили ${check.answered} из ${check.total}, JSON ${check.validJson}, ` +
        `медиана ответа ${Math.round((check.latencyMs?.median ?? 0) / 100) / 10} с` +
        `${check.reasoningDetected ? ", модель рассуждающая — нужна другая" : ""}.`
      : "",
  ].join("\n");
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
  const gate = await gateReport({ db, me, cfg: cfg.gate, sendersCfg: cfg.senders });
  const session = await new TrueConfApi({ cfg: cfg.trueconf, store: db.meta }).session();
  const since = Date.now() - cfg.cases.periodDays * 86400000;
  const { rows, systems, history } = await loadCaseRows(db,
    { since, me, cfg: cfg.cases, sendersCfg: cfg.senders });
  const built = buildCases(rows,
    { me, gateCfg: cfg.gate, cfg: cfg.cases, sendersCfg: cfg.senders, systems, since });
  const auto = await collect({
    db, cfg, env: await environment(), gate, me, trueconfSession: session,
    cases: casesSummary(built.cases, built.cross,
      { systems: built.systems, history, periodDays: cfg.cases.periodDays }),
  });
  $("llmRequest").textContent = llmRequestText({
    // Писем в день считаем по периоду, без поднятой истории.
    perDay: Math.round((rows.length - history.added) / cfg.cases.periodDays),
    modelShare: gate.decidable ? gate.model / gate.decidable : null,
    check: await db.meta.get("report:model"),
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
