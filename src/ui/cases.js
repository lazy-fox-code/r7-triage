// Вкладка «Дела»: список, граф, карточка, строка сбора и лента событий.
//
// Показываются дела, в которых было движение за период из настроек (по
// умолчанию 30 дней), но собирается каждое с первого письма: ранние письма
// той же ветки поднимаются из базы (cases.js, loadCaseRows). Хронология в
// карточке идёт от старых записей к новым — по ней читается жизненный цикл
// дела. Пока модель не подключена, дело — это ветка, встреча, беседа
// Outlook или объект информационной системы без поручений и сроков;
// вкладка говорит об этом прямо.
//
// Открытие вкладки запускает дочитывание новых писем. Пока идёт обогащение,
// дела пересобираются, и граф растёт на глазах: новые письма прирастают к
// делам, дела пульсируют, лента пишет, почему письмо попало в дело.
//
// Всё, что пришло из писем (темы, имена, адреса), вставляется через
// textContent: темы писем — чужие данные, в разметку их не пускаем.

import * as db from "../db.js";
import * as settings from "../settings.js";
import { myAddresses } from "../me.js";
import { buildCases, diffCases, displaySubject, loadCaseRows, mergeCases } from "../cases.js";
import { objectId, statusOf, categoryOf } from "../senders.js";
import { CaseGraph, STATE_NAMES, plural, initials } from "./cases-graph.js";
import { DirectoryLookup } from "../directory.js";
import { TrueConfApi } from "../trueconf-api.js";

const DAY = 86400000;
const MAX_CASES = 300;
const REBUILD_MS = 1500;
const TL_STEP = 30;

const S = {
  cfg: null,
  me: new Set(),
  cases: [],
  cross: [],
  systems: [],
  history: { added: 0, truncated: false },
  historyWarned: false,
  since: null,
  // Системы свёрнуты, пока их не развернули: сотня уведомлений не должна
  // закрывать собой переписку. Скрытые — в настройках, они переживают
  // перезапуск.
  expandedSystems: new Set(),
  selectedSystem: null,
  sysLimit: 200,
  byId: new Map(),
  selected: null,
  filter: "all",
  query: "",
  scope: "all",
  allPeople: false,
  expanded: new Set(),
  events: [],
  feedOpen: false,
  status: null,
  tlLimit: TL_STEP,
  built: false,
  lastEnriched: -1,
  rebuildTimer: null,
  tcSession: null,
  collectSig: "",
};

const $ = (id) => document.getElementById(id);

/** Элемент DOM. Текст — только через textContent. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.setAttribute("style", v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}

function icon(id, size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", size); svg.setAttribute("height", size); svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

const num = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
// Дело может начаться в прошлом году — тогда год виден.
const day = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  const year = d.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year });
};
const stamp = (ms) => (ms ? new Date(ms).toLocaleString("ru-RU",
  { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const clock = () => new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const STATE_COLOR = { new: "var(--st-new)", branch: "var(--st-stale)" };

// --- данные -------------------------------------------------------------------

async function rebuild({ initial = false } = {}) {
  const since = Date.now() - S.cfg.cases.periodDays * DAY;
  S.since = since;
  const { rows, systems: found, merges, history } = await loadCaseRows(db,
    { since, me: S.me, cfg: S.cfg.cases, sendersCfg: S.cfg.senders });
  const { cases, cross, systems } = buildCases(rows, {
    me: S.me, gateCfg: S.cfg.gate, cfg: S.cfg.cases, sendersCfg: S.cfg.senders,
    systems: found, merges, since,
  });
  const events = S.built ? diffCases(S.cases, cases) : [];
  S.cases = cases;
  S.cross = cross;
  S.systems = systems;
  S.history = history;
  // Предел подъёма ранних писем — не молча: часть дел показана не с начала.
  if (history.truncated && !S.historyWarned) {
    S.historyWarned = true;
    pushEvent({ icon: "i-warn", kind: "err",
      what: `Ранние письма подняты не для всех дел: предел ${num(S.cfg.cases.historyLimit)}`,
      why: "поднять предел — настройки → Дела" });
  }
  S.byId = new Map(cases.map((c) => [c.id, c]));
  if (S.selected && !S.byId.has(S.selected)) S.selected = null;
  S.built = true;

  // Пачка больше 20 событий не анимируется по письму — сводится в одну строку.
  const letters = events.filter((e) => e.kind === "letter");
  const created = events.filter((e) => e.kind === "case");
  if (events.length > 20) {
    const touched = new Set(events.map((e) => e.caseId));
    pushEvent({ icon: "i-branch", what: `+${letters.length} ${plural(letters.length, ["письмо", "письма", "писем"])} ` +
      `в ${touched.size} ${plural(touched.size, ["деле", "делах", "делах"])}` +
      (created.length ? `, новых дел ${created.length}` : ""), why: "пачка событий" });
  } else {
    for (const e of created) pushEvent({ icon: "i-cases", what: `Новое дело «${e.title}»`, why: e.why, caseId: e.caseId });
    for (const e of letters) pushEvent({ icon: "i-mail", what: `Письмо «${e.subject}» → «${e.title}»`, why: e.why, caseId: e.caseId });
  }

  render({ initial });
  for (const id of new Set(events.map((e) => e.caseId))) graph.pulse(id);
}

const hiddenSystem = (email) => S.cfg.cases.hiddenSystems.includes(email);
const bigCase = (c) => c.counts.mail >= 3 && c.counts.people >= 2;

function visibleCases() {
  const q = S.query.trim().toLowerCase();
  return S.cases.filter((c) => {
    const owner = c.systemOwner;
    if (owner && hiddenSystem(owner)) return false;
    // Дела свёрнутой системы в общем списке не показываются — они под её
    // строкой. Поиск свёрнутость отменяет: искать нужно везде.
    if (owner && !q && !S.expandedSystems.has(owner)) return false;
    if (S.filter === "new" && c.state !== "new") return false;
    if (S.filter === "big" && !bigCase(c)) return false;
    if (S.filter === "meet" && !c.counts.meet) return false;
    if (S.filter === "conf" && !c.counts.conf) return false;
    if (!q) return true;
    const hay = [c.title, c.object ?? "", ...c.people.map((p) => `${p.name} ${p.email}`),
      ...c.conferences.map((f) => `${f.id} ${f.topic ?? ""}`), ...c.meetings.map((m) => m.summary)]
      .join(" ").toLowerCase();
    return hay.includes(q);
  }).sort((a, b) => (S.filter === "big" ? b.weight - a.weight : b.lastAt - a.lastAt));
}

/** Системы с их делами — строки списка и узлы графа. */
function visibleSystems() {
  return S.systems
    .map((s) => {
      const cases = s.cases.map((id) => S.byId.get(id)).filter(Boolean);
      return {
        ...s, cases: cases.map((c) => c.id),
        letters: cases.reduce((n, c) => n + c.counts.mail, 0),
        unread: cases.reduce((n, c) => n + c.unread, 0),
        hidden: hiddenSystem(s.email),
        collapsed: !S.expandedSystems.has(s.email),
      };
    })
    .filter((s) => s.cases.length)
    .sort((a, b) => b.letters - a.letters);
}

function scheduleRebuild() {
  if (S.rebuildTimer) return;
  S.rebuildTimer = setTimeout(async () => {
    S.rebuildTimer = null;
    await rebuild();
  }, REBUILD_MS);
}

// --- отрисовка ------------------------------------------------------------------

function render({ initial = false } = {}) {
  const vis = visibleCases();
  const shown = vis.slice(0, MAX_CASES);
  renderChips();
  renderList(shown);
  renderCard();
  renderOverlay(vis.length, shown.length);
  graph.setData({
    cases: shown, cross: S.cross, systems: visibleSystems().filter((x) => !x.hidden),
    selected: S.selected, selectedSystem: S.selectedSystem, scope: S.scope,
    allPeople: S.allPeople, expanded: S.expanded,
  }, { initial });
}

function renderChips() {
  const own = S.cases.filter((c) => !c.systemOwner || !hiddenSystem(c.systemOwner));
  const counts = {
    all: own.length,
    new: own.filter((c) => c.state === "new").length,
    big: own.filter(bigCase).length,
    meet: own.filter((c) => c.counts.meet).length,
    conf: own.filter((c) => c.counts.conf).length,
  };
  const names = { all: "Все", new: "Новое", big: "Крупные", meet: "Со встречами", conf: "С конференциями" };
  const box = $("chips");
  box.textContent = "";
  for (const k of Object.keys(names)) {
    box.append(h("button", {
      type: "button", class: "chip", "aria-pressed": String(S.filter === k),
      onclick: () => { S.filter = k; render(); },
    }, names[k], h("span", { class: "num", text: num(counts[k]) })));
  }
}

function faces(c) {
  const box = h("span", { class: "faces" });
  const top = c.people.filter((p) => p.wrote).slice(0, 3);
  for (const p of top) box.append(h("span", { class: "face", title: p.name || p.email, text: initials(p.name, p.email) }));
  const more = c.people.length - top.length;
  if (more > 0) box.append(h("span", { class: "face-more", text: `+${more}` }));
  return box;
}

function statePill(state) {
  return h("span", { class: "state", style: `background: ${state === "new" ? "var(--st-new-bg)" : "var(--st-stale-bg)"};` },
    h("span", { class: "glyph", style: `background: ${STATE_COLOR[state]};` }),
    STATE_NAMES[state] ?? "Ветка");
}

function srcCount(id, n, label) {
  return n ? h("span", { class: "srccount", title: label }, icon(id, 12), num(n)) : null;
}

/** Строка системы: свёрнутые дела, таблица и «скрыть». */
function systemRow(sys) {
  const row = h("div", { class: "sysrow", "data-open": String(!sys.collapsed) });
  row.append(h("button", {
    type: "button", class: "sys-toggle", title: sys.collapsed ? "Показать дела" : "Свернуть дела",
    "aria-expanded": String(!sys.collapsed),
    onclick: () => {
      if (S.expandedSystems.has(sys.email)) S.expandedSystems.delete(sys.email);
      else S.expandedSystems.add(sys.email);
      render();
    },
  }, sys.collapsed ? "▸" : "▾"));
  row.append(h("button", {
    type: "button", class: "sys-name", title: "Таблица писем системы",
    onclick: () => selectSystem(sys.email),
  }, icon("i-branch", 12), h("span", { text: sys.name }),
  h("span", { class: "num", text: `${num(sys.cases.length)} дел · ${num(sys.letters)} писем` }),
  sys.unread ? h("span", { class: "new-tag", text: `новое · ${sys.unread}` }) : null));
  row.append(h("button", {
    type: "button", class: "more", title: "Убрать дела системы из списка и графа",
    onclick: () => hideSystem(sys.email, true), text: "скрыть",
  }));
  return row;
}

function renderList(shown) {
  const box = $("list");
  box.textContent = "";
  const systems = visibleSystems();
  const hidden = systems.filter((s) => s.hidden);
  if (systems.some((s) => !s.hidden)) {
    box.append(h("div", { class: "grp" }, "Системы",
      h("span", { class: "num", style: "color: var(--c-text-2);", text: num(systems.filter((s) => !s.hidden).length) })));
    for (const sys of systems) if (!sys.hidden) box.append(systemRow(sys));
  }
  if (hidden.length) {
    box.append(h("div", { class: "hidden-note" },
      `Скрыто систем: ${hidden.length}. `,
      ...hidden.map((s) => h("button", {
        type: "button", class: "more", onclick: () => hideSystem(s.email, false),
        text: `вернуть «${s.name}»`,
      }))));
  }
  if (!shown.length) {
    box.append(h("div", { class: "empty", text: S.cases.length
      ? "Ничего не найдено. Сбросьте фильтр или поиск — или разверните систему."
      : "Дел пока нет: письма ещё разбираются. Вкладку можно закрыть — сбор продолжится." }));
    return;
  }
  const groups = S.filter === "big"
    ? [["Крупные дела", shown]]
    : [["Новое", shown.filter((c) => c.state === "new")],
      ["Ветки", shown.filter((c) => c.state !== "new")]];
  for (const [name, items] of groups) {
    if (!items.length) continue;
    box.append(h("div", { class: "grp" }, name, h("span", { class: "num", style: "color: var(--c-text-2);", text: num(items.length) })));
    for (const c of items) {
      const row = h("button", {
        type: "button", class: "row", role: "option", "data-id": c.id,
        "aria-selected": String(S.selected === c.id), onclick: () => select(c.id),
      },
      h("span", { class: "row-top" }, statePill(c.state),
        h("span", { class: "row-title", text: c.title }),
        c.object ? h("span", { class: "why", text: c.object }) : null),
      h("span", { class: "row-meta" },
        c.state === "new" ? h("span", { class: "new-tag", text: `новое · ${c.unread}` }) : null,
        srcCount("i-mail", c.counts.mail, "писем"),
        srcCount("i-meet", c.counts.meet, "встреч"),
        srcCount("i-conf", c.counts.conf, "конференций"),
        srcCount("i-clip", c.counts.files, "вложений"),
        faces(c),
        h("span", { style: "margin-left: auto;", text: day(c.lastAt) })));
      box.append(row);
    }
  }
}

function whyChip(text, tone) {
  return h("span", { class: "why", "data-tone": tone ?? null, text });
}

function timeline(c) {
  const items = [];
  for (const l of c.letters) {
    items.push({ at: l.date, node: h("div", { class: "tl" },
      h("span", { class: "tl-ico" }, icon("i-mail", 13)),
      h("div", { class: "tl-body" },
        h("button", { type: "button", class: "link", title: "Открыть письмо", onclick: () => openLetter(l.id) },
          h("span", { class: "tl-title", text: displaySubject(l.subject) })),
        h("div", { class: "tl-sub", text: `${l.mine ? "вы" : (l.fromName || l.fromId)} · ${stamp(l.date)}` +
          (l.attachments ? ` · ${l.attachments} ${plural(l.attachments, ["вложение", "вложения", "вложений"])}` : "") +
          (!l.read && !l.mine ? " · не прочитано" : "") }),
        whyChip(`почему в деле: ${l.why}`))) });
  }
  for (const m of c.meetings) {
    items.push({ at: m.start ?? c.firstAt, node: h("div", { class: "tl" },
      h("span", { class: "tl-ico" }, icon("i-meet", 13)),
      h("div", { class: "tl-body" },
        h("div", { class: "tl-title", text: `${m.summary || "Встреча"}${m.cancelled ? " — отменена" : ""}` }),
        h("div", { class: "tl-sub", text: [stamp(m.start), m.organizer ? `организатор ${m.organizer}` : null,
          m.attendees ? `участников ${m.attendees}` : null].filter(Boolean).join(" · ") }),
        whyChip("почему в деле: приглашение к той же встрече"))) });
  }
  for (const f of c.conferences) {
    items.push({ at: c.lastAt, node: h("div", { class: "tl" },
      h("span", { class: "tl-ico" }, icon("i-conf", 13)),
      h("div", { class: "tl-body" },
        h("div", { class: "tl-title", text: `Конференция № ${f.id}${f.topic ? ` «${f.topic}»` : ""}` }),
        h("div", { class: "tl-sub", text: f.host ? `сервер ${f.host}` : "ссылка без имени сервера" }),
        whyChip("почему в деле: номер и тема конференции из ссылки в письме"))) });
  }
  // От старых записей к новым: дело читается как история — с чего началось
  // и чем закончилось на сегодня.
  items.sort((a, b) => a.at - b.at);
  return items;
}

/**
 * Хронология со свёрнутой серединой: первая запись — начало дела — видна
 * всегда, дальше идут последние записи, а между ними кнопка разворачивает
 * ранние. Иначе у дела на сотню писем самое свежее пряталось бы в конце.
 */
function timelineSection(tl, sec) {
  const hidden = Math.max(0, tl.length - S.tlLimit);
  const head = hidden ? tl.slice(0, 1) : [];
  const tail = hidden ? tl.slice(tl.length - (S.tlLimit - 1)) : tl;
  let shownEarly = null;
  const append = (it) => {
    // Граница периода: дальше идут записи, из-за которых дело и показано.
    if (shownEarly === true && !isEarly(it)) {
      sec.append(h("div", { class: "tl-sep",
        text: `последние ${S.cfg.cases.periodDays} ${plural(S.cfg.cases.periodDays, ["день", "дня", "дней"])}` }));
    }
    shownEarly = isEarly(it);
    sec.append(it.node);
  };
  for (const it of head) append(it);
  if (hidden) {
    sec.append(h("button", {
      type: "button", class: "more", text: `Показать ещё ${Math.min(TL_STEP, hidden)} ранних`,
      onclick: () => { S.tlLimit += TL_STEP; renderCard(); },
    }));
    shownEarly = null;
  }
  for (const it of tail) append(it);
}

const isEarly = (it) => S.since != null && it.at < S.since;

/**
 * Строки таблицы системы: по одной на письмо. Дата, категория (тема-бланк
 * без номера и статуса), запрос, номер объекта и статус берутся из темы.
 * Ответственный и срок остаются пустыми до модели — выдумывать их нельзя.
 */
function systemTable(sys) {
  const rows = [];
  for (const id of sys.cases) {
    const c = S.byId.get(id);
    if (!c) continue;
    for (const l of c.letters) {
      if (l.mine) continue;
      rows.push({
        date: l.date,
        category: categoryOf(l.subject, S.cfg.senders.statusWords) || "—",
        request: displaySubject(l.subject),
        owner: "",
        due: "",
        number: objectId(l.subject) ?? c.object ?? "",
        status: statusOf(l.subject, S.cfg.senders.statusWords) || "",
        caseId: c.id,
        letterId: l.id,
      });
    }
  }
  return rows.sort((a, b) => a.date - b.date);
}

const CSV_HEAD = ["Дата", "Категория", "Запрос", "Ответственный", "Срок", "Номер", "Статус"];

function downloadCsv(name, rows) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [CSV_HEAD.map(cell).join(";")];
  for (const r of rows) {
    lines.push([new Date(r.date).toLocaleString("ru-RU"), r.category, r.request,
      r.owner, r.due, r.number, r.status].map(cell).join(";"));
  }
  // BOM — чтобы кириллица открылась в Excel без плясок с кодировкой.
  const blob = new Blob([`\uFEFF${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function renderSystemCard(sys) {
  const card = $("card");
  card.hidden = false;
  card.textContent = "";
  const rows = systemTable(sys);

  card.append(h("div", { class: "card-hd" },
    h("h2", { text: sys.name }),
    h("span", { class: "state", style: "background: var(--c-surface-3);" }, "Система"),
    h("div", { class: "card-meta", text: `${num(sys.cases.length)} ${plural(sys.cases.length, ["дело", "дела", "дел"])} · ` +
      `${num(rows.length)} ${plural(rows.length, ["письмо", "письма", "писем"])}` +
      (rows.length ? ` · ${day(rows[0].date)} — ${day(rows[rows.length - 1].date)}` : "") }),
    h("button", { type: "button", class: "icon-btn card-close", "aria-label": "Закрыть карточку",
      onclick: () => selectSystem(null), text: "×" })));

  const scroll = h("div", { class: "card-scroll" });
  scroll.append(h("section", { class: "sec" },
    h("h3", {}, icon("i-branch", 12), " Почему это система"),
    whyChip(sys.why, "src"),
    h("p", { style: "margin: 8px 0 0; font-size: var(--fs-xs); color: var(--c-text-2);",
      text: "Её письма собираются в дела по номеру объекта и не смешиваются с перепиской. " +
        "Ответственный и срок появятся, когда будет подключена модель: из темы их не достать." })));

  const sec = h("section", { class: "sec" },
    h("h3", { text: `Хронология — ${num(rows.length)} ${plural(rows.length, ["запись", "записи", "записей"])}` }));
  const table = h("table", { class: "systab" });
  table.append(h("tr", {}, ...CSV_HEAD.map((t) => h("th", { text: t }))));
  for (const r of rows.slice(0, S.sysLimit)) {
    table.append(h("tr", {},
      h("td", { text: day(r.date) }),
      h("td", { text: r.category }),
      h("td", {}, h("button", { type: "button", class: "link", title: "Открыть письмо",
        onclick: () => openLetter(r.letterId), text: r.request })),
      h("td", { text: r.owner || "—" }),
      h("td", { text: r.due || "—" }),
      h("td", {}, r.number
        ? h("button", { type: "button", class: "link", title: "Открыть дело",
          onclick: () => { selectSystem(null); select(r.caseId); }, text: r.number })
        : "—"),
      h("td", { text: r.status || "—" })));
  }
  sec.append(table);
  if (rows.length > S.sysLimit) {
    sec.append(h("button", { type: "button", class: "more",
      text: `Показать ещё ${Math.min(200, rows.length - S.sysLimit)}`,
      onclick: () => { S.sysLimit += 200; renderCard(); } }));
  }
  scroll.append(sec);
  card.append(scroll);

  card.append(h("div", { class: "actions" },
    h("button", { type: "button", class: "btn", "data-kind": "primary",
      onclick: () => downloadCsv(`${sys.email.replace(/[^\w.-]+/g, "_")}.csv`, rows) },
    "Скачать таблицу (CSV)"),
    h("button", { type: "button", class: "btn",
      onclick: () => hideSystem(sys.email, !hiddenSystem(sys.email)) },
    hiddenSystem(sys.email) ? "Показать в списке" : "Скрыть из списка"),
    h("button", { type: "button", class: "btn", onclick: () => {
      if (S.expandedSystems.has(sys.email)) S.expandedSystems.delete(sys.email);
      else S.expandedSystems.add(sys.email);
      render();
    } }, S.expandedSystems.has(sys.email) ? "Свернуть дела" : "Показать дела в списке")));
}

function renderCard() {
  const card = $("card");
  if (S.selectedSystem) {
    const sys = visibleSystems().find((x) => x.email === S.selectedSystem);
    if (sys) { renderSystemCard(sys); return; }
    S.selectedSystem = null;
  }
  const c = S.selected ? S.byId.get(S.selected) : null;
  card.hidden = !c;
  card.textContent = "";
  if (!c) return;

  const linked = S.cross.filter((l) => l.a === c.id || l.b === c.id)
    .map((l) => ({ other: S.byId.get(l.a === c.id ? l.b : l.a), why: l.why })).filter((x) => x.other);

  card.append(h("div", { class: "card-hd" },
    h("h2", { text: c.title }),
    statePill(c.state),
    h("div", { class: "card-meta", text: `${c.counts.mail} ${plural(c.counts.mail, ["письмо", "письма", "писем"])} · ` +
      `${c.counts.people} ${plural(c.counts.people, ["участник", "участника", "участников"])} · ` +
      `${day(c.firstAt)} — ${day(c.lastAt)}` }),
    h("button", { type: "button", class: "icon-btn card-close", "aria-label": "Закрыть карточку",
      onclick: () => select(null), text: "×" })));

  const scroll = h("div", { class: "card-scroll" });
  const sys = c.joinedBy.system ? S.systems.find((s) => s.email === c.joinedBy.system.email) : null;
  const joined = [];
  if (c.joinedBy.thread) joined.push(whyChip("одна ветка: References", "src"));
  if (c.joinedBy.outlook) joined.push(whyChip("одна беседа Outlook: Thread-Index", "src"));
  if (c.joinedBy.meeting) joined.push(whyChip("письма об одной встрече: UID", "src"));
  if (c.joinedBy.system) {
    joined.push(whyChip(c.joinedBy.system.object
      ? `письма системы «${c.joinedBy.system.name}» об одном объекте: ${c.joinedBy.system.object}`
      : `письма системы «${c.joinedBy.system.name}» с одной темой`, "src"));
  }
  if (!joined.length) joined.push(whyChip("одно письмо", "src"));
  scroll.append(h("section", { class: "sec" },
    h("h3", {}, icon("i-branch", 12), " Почему это одно дело"),
    h("div", { style: "display: flex; flex-wrap: wrap; gap: 4px;" }, joined),
    c.startedBefore ? h("div", { style: "margin-top: 8px; font-size: var(--fs-xs); color: var(--c-text-2);",
      text: `Дело началось ${day(c.firstAt)}, раньше показываемого периода: ранние письма подняты из ящика.` }) : null,
    sys ? h("div", { style: "margin-top: 8px; font-size: var(--fs-xs); color: var(--c-text-2);" },
      `Система «${sys.name}» — ${sys.why}. `,
      sys.cases.length > 1
        ? h("button", { type: "button", class: "more", onclick: () => selectSystem(sys.email),
          text: `Все дела этой системы: ${sys.cases.length}` })
        : null) : null,
    linked.length ? h("div", { style: "margin-top: 8px; font-size: var(--fs-xs); color: var(--c-text-2);" },
      "Связано с: ", ...linked.map((x, i) => h("span", {},
        i ? ", " : "", h("button", { type: "button", class: "more", onclick: () => select(x.other.id), text: `«${x.other.title}»` }),
        ` — ${x.why}`))) : null,
    S.cfg.llm.endpoint ? null : h("p", { style: "margin: 8px 0 0; font-size: var(--fs-xs); color: var(--c-text-2);",
      text: "Поручения, сроки и состояния появятся, когда будет подключена модель." })));

  const tl = timeline(c);
  const tlSec = h("section", { class: "sec" },
    h("h3", { text: `Хронология — ${tl.length} ${plural(tl.length, ["запись", "записи", "записей"])}, от первой к последней` }));
  timelineSection(tl, tlSec);
  scroll.append(tlSec);

  if (c.people.length) {
    const sec = h("section", { class: "sec" }, h("h3", { text: `Участники — ${c.people.length}` }));
    for (const p of c.people.slice(0, 12)) {
      // Должность и подразделение — из адресной книги, по одному запросу с
      // паузой и только для открытой карточки: каталог отвечает не сразу и
      // нагружать его списком дел нельзя.
      const level = h("div", { class: "tl-sub" });
      if (!p.system) showLevel(p, level);
      sec.append(h("div", { class: "person" },
        h("span", { class: "face", text: initials(p.name, p.email) }),
        h("span", { style: "flex-grow: 1; min-width: 0;" },
          h("div", { style: "font-size: var(--fs-sm);", text: (p.name || p.email) + (p.system ? " · система" : "") }),
          h("div", { class: "tl-sub", text: `${p.email} · писал ${p.wrote}, в адресатах ${p.letters - p.wrote}` }),
          level)));
    }
    if (c.people.length > 12) sec.append(h("div", { class: "tl-sub", text: `и ещё ${c.people.length - 12}` }));
    scroll.append(sec);
  }

  if (c.files.length) {
    const sec = h("section", { class: "sec" }, h("h3", { text: `Вложения — ${c.files.length}` }));
    for (const f of c.files.slice().reverse().slice(0, 20)) {
      sec.append(h("div", { class: "att" }, icon("i-clip", 13),
        h("button", { type: "button", class: "link", title: "Открыть письмо с вложением",
          onclick: () => openLetter(f.messageId), text: f.name || "вложение" }),
        h("span", { class: "tl-sub", style: "margin-left: auto;", text: day(f.date) })));
    }
    scroll.append(sec);
  }
  card.append(scroll);

  const last = c.letters[c.letters.length - 1];
  const lastIncoming = [...c.letters].reverse().find((l) => !l.mine) ?? last;
  card.append(h("div", { class: "actions" },
    h("button", { type: "button", class: "btn", "data-kind": "primary", title: "Откроется окно ответа — отправляете вы",
      onclick: () => replyLetter(lastIncoming.id) }, "Черновик ответа"),
    h("button", { type: "button", class: "btn", onclick: () => openLetter(last.id) }, "Открыть в почте")));
}

function renderOverlay(total, shown) {
  const box = $("overlay");
  if (!S.cases.length) {
    box.hidden = false; box.removeAttribute("data-soft");
    box.textContent = "";
    box.append(h("b", { text: "Дел пока нет" }),
      h("span", { text: `Письма за последние ${S.cfg.cases.periodDays} ` +
        `${plural(S.cfg.cases.periodDays, ["день", "дня", "дней"])} ещё разбираются. ` +
        "Граф будет расти по мере сбора." }));
  } else if (total > shown) {
    box.hidden = false; box.setAttribute("data-soft", "true");
    box.textContent = "";
    box.append(h("span", { text: `Показаны ${num(shown)} из ${num(total)} — сузьте поиск или фильтр` }));
  } else {
    box.hidden = true;
  }
}

// --- строка сбора, источники, баннер ----------------------------------------------

function src(name, dotState, extra) {
  return h("span", { class: "src" }, h("span", { class: "dot", "data-s": dotState }), h("b", { text: name }), extra ?? null);
}

function renderCollect() {
  const st = S.status;
  const box = $("collect");
  if (!st) return;
  // Перерисовываем, только если что-то изменилось: опрос идёт каждые 2 с, и
  // кнопка, пересозданная между нажатием и отпусканием, теряет клик.
  const sig = JSON.stringify([st.running, st.pass, st.progress?.rate, st.progress?.folder,
    st.enrich, st.trial?.expired, st.trial?.daysLeft, Boolean(S.tcSession)]);
  if (sig === S.collectSig) return;
  S.collectSig = sig;
  box.textContent = "";
  const e = st.enrich ?? {};
  const counts = e.counts ?? {};
  const p = st.progress ?? {};
  const pass = st.running ? st.pass : null;
  const enriching = pass && pass.startsWith("enrich");

  if (enriching) {
    const done = counts.done ?? 0;
    const total = done + (counts.pending ?? 0);
    box.append(h("span", {}, h("strong", { text: "Дочитываю новые письма" }), " · ",
      h("span", { class: "num", text: `${num(done)} из ${num(total)}` }),
      p.rate ? ` · ${p.rate} ${plural(p.rate, ["письмо", "письма", "писем"])}/с` : ""),
      h("span", { class: "bar" }, h("i", { style: `width: ${total ? Math.round(done / total * 100) : 0}%;` })),
      h("button", { type: "button", class: "btn", onclick: pause }, icon("i-pause", 13), "Пауза"));
  } else if (pass) {
    box.append(h("span", {}, h("strong", { text: "Разбираю ящик" }), p.folder ? ` · ${p.folder}` : ""),
      h("button", { type: "button", class: "btn", onclick: pause }, icon("i-pause", 13), "Пауза"));
  } else {
    const at = e.savedAt ?? e.finishedAt;
    box.append(h("span", { style: "display: flex; align-items: center; gap: 8px;" },
      h("span", { class: "dot", "data-s": e.error ? "err" : "ok" }),
      h("strong", { text: e.error ? "Сбор приостановлен" : "Всё актуально" }),
      at ? h("span", { class: "sep", text: "·" }) : null, at ? `обновлено в ${new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : null),
      h("button", { type: "button", class: "btn", "data-kind": "primary", onclick: refresh,
        title: "Дочитает все новые письма сейчас, в том числе моложе задержки — их клиент заберёт с сервера Exchange" },
      icon("i-refresh", 13), "Обновить"));
  }
  if (e.young) {
    box.append(h("span", { class: "sep", text: "|" }),
      h("span", { class: "note",
        title: "Свежие письма читаются, когда клиент сохранит их на диск. «Обновить» заберёт их с сервера Exchange сейчас.",
        text: `Ещё ${num(e.young)} ${plural(e.young, ["письмо ждёт", "письма ждут", "писем ждут"])} сохранения на диск — «Обновить» заберёт из Exchange` }));
  }

  const mail = e.error ? "err" : pass ? "run" : "ok";
  const model = S.cfg.llm.endpoint ? "ok" : "off";
  const tc = S.cfg.trueconf.server ? (S.tcSession ? "ok" : "auth") : "off";
  box.append(h("span", { class: "srcs" },
    src("Почта", mail),
    src("Модель", model, model === "off" ? h("button", { type: "button", onclick: openSettings, text: "подключить" }) : null),
    src("TrueConf", tc, tc === "auth" ? h("button", { type: "button", onclick: openTrueConf, text: "Войти" })
      : tc === "off" ? h("button", { type: "button", onclick: openTrueConf, text: "подключить" }) : null)));

  const banner = $("banner");
  banner.textContent = "";
  if (e.error) {
    banner.hidden = false; banner.setAttribute("data-tone", "err");
    banner.append(icon("i-warn", 14), h("span", { text: e.error }),
      h("button", { type: "button", class: "btn", onclick: refresh, text: "Повторить" }));
  } else if (st.trial?.expired) {
    banner.hidden = false; banner.setAttribute("data-tone", "warn");
    banner.append(icon("i-warn", 14), h("span", { text: "Срок демоверсии истёк: сбор остановлен, собранное доступно." }));
  } else if (!S.cfg.llm.endpoint) {
    banner.hidden = false; banner.removeAttribute("data-tone");
    banner.append(h("span", { text: "Поручений ещё нет: модель не подключена. Показаны ветки писем, встречи и конференции." }),
      h("button", { type: "button", class: "btn", onclick: openSettings, text: "Настройки" }));
  } else {
    banner.hidden = true;
  }

  const t = st.trial;
  $("trial").textContent = t?.countdown ? `Демоверсия · ${t.daysLeft} ${plural(t.daysLeft, ["день", "дня", "дней"])}` : "";
}

// --- лента ------------------------------------------------------------------

function pushEvent(e) {
  S.events.unshift({ ...e, time: clock() });
  S.events.length = Math.min(S.events.length, 200);
  renderFeed();
}

function renderFeed() {
  $("feedCount").textContent = num(S.events.length);
  const last = S.events[0];
  $("feedLast").textContent = last ? `${last.what}` : "";
  $("feedBar").setAttribute("aria-expanded", String(S.feedOpen));
  const box = $("feed");
  box.hidden = !S.feedOpen;
  if (!S.feedOpen) return;
  box.textContent = "";
  for (const e of S.events) {
    box.append(h("button", { type: "button", class: "ev", "data-kind": e.kind ?? null,
      onclick: () => e.caseId && select(e.caseId),
      onmouseenter: () => e.caseId && graph.pulse(e.caseId) },
    h("time", { text: e.time }), icon(e.icon ?? "i-mail", 12),
    h("span", {}, e.what, " ", h("span", { class: "ev-why", text: `· ${e.why}` }))));
  }
}

// --- действия ------------------------------------------------------------------

function select(id) {
  // Список перерисовывается целиком — фокус возвращаем на выбранную строку,
  // чтобы стрелки продолжали работать.
  const listHadFocus = $("list").contains(document.activeElement);
  if (id) S.selectedSystem = null;
  S.selected = id;
  S.expanded = new Set();
  S.tlLimit = TL_STEP;
  render();
  const row = document.querySelector(`.row[data-id="${CSS.escape(id ?? "")}"]`);
  row?.scrollIntoView({ block: "nearest" });
  if (listHadFocus) (row ?? $("list")).focus();
}

async function send(cmd, extra = {}) {
  try {
    return await browser.runtime.sendMessage({ cmd, ...extra });
  } catch (e) {
    pushEvent({ icon: "i-warn", kind: "err", what: "Действие не выполнено", why: String(e?.message ?? e) });
    return null;
  }
}

/**
 * Должность и подразделение участника из каталога — когда ответит. Ошибка
 * каталога карточку не ломает: строка просто останется пустой.
 */
async function showLevel(person, el) {
  try {
    const level = await dir.level(person.email);
    if (!level?.found) return;
    const text = [level.title, level.department].filter(Boolean).join(" · ");
    if (text) el.textContent = text;
  } catch { /* каталог недоступен — строки просто не будет */ }
}

/** Открыть карточку системы: таблица её писем. */
function selectSystem(email) {
  S.selectedSystem = email;
  S.sysLimit = 200;
  if (email) S.selected = null;
  render();
}

/** Убрать дела системы из списка и графа (или вернуть). Решение помнится. */
async function hideSystem(email, hide) {
  const set = new Set(S.cfg.cases.hiddenSystems);
  if (hide) set.add(email); else set.delete(email);
  S.cfg.cases.hiddenSystems = [...set];
  await settings.save("cases", { hiddenSystems: S.cfg.cases.hiddenSystems });
  pushEvent({ icon: "i-cases", what: hide ? "Система скрыта" : "Система возвращена в список",
    why: "настройки → Дела → скрытые системы" });
  render();
}

/**
 * Объединить два дела перетаскиванием на графе. Связь запоминается по
 * ключам первых писем — они устойчивы, поэтому объединение переживает и
 * пересборку, и перезапуск клиента.
 */
async function mergeManually(aId, bId) {
  const a = S.byId.get(aId);
  const b = S.byId.get(bId);
  if (!a || !b || a === b) return;
  if (!confirm(`Объединить дела «${a.title}» и «${b.title}»?`)) return;
  await mergeCases(db, a.letters[0].id, b.letters[0].id);
  pushEvent({ icon: "i-cases", what: `Дела объединены: «${a.title}» и «${b.title}»`,
    why: "объединено вручную" });
  await rebuild();
  select(S.cases.find((c) => c.letters.some((l) => l.id === a.letters[0].id))?.id ?? null);
}

const openLetter = (id) => send("letter.open", { id });
const replyLetter = (id) => send("letter.reply", { id });
const openSettings = () => browser.runtime.openOptionsPage();
const openTrueConf = () => browser.tabs.create({ url: browser.runtime.getURL("src/ui/trueconf.html") });

async function refresh() {
  S.status = await send("cases.refresh");
  renderCollect();
}

async function pause() {
  S.status = await send("scan.stop");
  renderCollect();
}

async function poll() {
  const st = await send("scan.status");
  if (!st) return;
  S.status = st;
  renderCollect();
  // Письма разобраны или дочитаны — пересобрать дела; граф прирастёт новыми
  // узлами. Сравниваем сумму: новые письма прохода и дочитанные заголовки.
  const mark = (st.enrich?.counts?.done ?? 0) + (st.counts?.messages ?? 0);
  if (S.lastEnriched >= 0 && mark !== S.lastEnriched) scheduleRebuild();
  S.lastEnriched = mark;
}

// --- граф и клавиатура -------------------------------------------------------------

const graph = new CaseGraph($("graph"), {
  onSelect: (id) => select(id),
  onPickSystem: (email) => selectSystem(email),
  onMerge: (a, b) => mergeManually(a, b),
  onTip: (tip) => {
    const el = $("tip");
    el.hidden = !tip;
    if (!tip) return;
    el.textContent = "";
    el.append(h("b", { text: tip.title }), tip.sub);
    el.style.left = `${Math.max(4, tip.x)}px`;
    el.style.top = `${tip.y}px`;
  },
  onZoom: (k) => { $("zoomVal").textContent = `${Math.round(k * 100)} %`; },
  onOpenLetter: (id) => openLetter(id),
});

$("zoomIn").addEventListener("click", () => graph.zoomBy(1.15));
$("zoomOut").addEventListener("click", () => graph.zoomBy(0.87));
$("fit").addEventListener("click", () => graph.fit());
for (const [id, scope] of [["scopeAll", "all"], ["scopeSel", "sel"]]) {
  $(id).addEventListener("click", () => {
    S.scope = scope;
    $("scopeAll").setAttribute("aria-pressed", String(scope === "all"));
    $("scopeSel").setAttribute("aria-pressed", String(scope === "sel"));
    render();
  });
}
$("allPeople").addEventListener("change", (e) => { S.allPeople = e.target.checked; render(); });
$("q").addEventListener("input", (e) => { S.query = e.target.value; render(); });
$("settings").addEventListener("click", openSettings);
$("feedBar").addEventListener("click", () => { S.feedOpen = !S.feedOpen; renderFeed(); });
$("list").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const ids = [...document.querySelectorAll(".row")].map((r) => r.dataset.id);
  const i = ids.indexOf(S.selected);
  const j = Math.max(0, Math.min(ids.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
  if (ids[j]) select(ids[j]);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.selected && !e.target.closest?.("canvas")) select(null);
});

// Широковещательный прогресс фона — чаще, чем опрос.
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "scan.progress") poll();
});

// --- запуск ------------------------------------------------------------------

S.cfg = await settings.load();
S.me = await myAddresses(browser, S.cfg.me.aliases);
const dir = new DirectoryLookup({ browser, db, cfg: S.cfg.directory });
if (S.cfg.trueconf.server) {
  S.tcSession = await new TrueConfApi({ cfg: S.cfg.trueconf, store: db.meta }).session().catch(() => null);
}
await rebuild({ initial: true });
await poll();
// Открытие вкладки — повод дочитать новые письма. С задержкой для свежих:
// то, что клиент ещё не сохранил на диск, заберёт «Обновить».
send("scan.start", { scope: "recent" });
setInterval(poll, 2000);
