// Проверка подключения к TrueConf на живом сервере. Страница делает запросы
// сама: у страниц расширения те же права, что у фона, а результат нужен
// здесь же, в журнале.

import * as settings from "../settings.js";
import * as db from "../db.js";
import {
  TrueConfApi, ChatSocket, chatToken, chatSocketUrl, serverBase, redact, SECRET_CHAT,
} from "../trueconf-api.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["server", "apiVersion", "clientId", "clientSecret", "authorizePath", "tokenUrl"];
const BODY_LIMIT = 20000;

const entries = [];
let socket = null;
const REPORT = "report:trueconf";
const ADMIN = "report:trueconf-admin";

const SCOPES = [
  "conferences:read",
  "conferences.messages:read",
  "logs.conferences.participants:read",
  "logs.calls:read",
  "logs.calls.participants:read",
];

// Вопросы администратору: ответы идут в отчёт о проверке.
const ADMIN_QUESTIONS = [
  ["Версия TrueConf Server", "text"],
  ["OAuth-приложение создано", "yesno"],
  ["Типы входа приложения (grant_types)", "text"],
  ["Путь страницы входа OAuth", "text"],
  ["Версия API в пути (v4.1 или иная)", "text"],
  ["Chatbot Connector включён и доступен обычным пользователям", "yesno"],
  ["Журналы участников (logs.*) доступны обычным пользователям", "yesno"],
  ["На странице входа есть «Запомнить меня»", "yesno"],
  ["На входе включена многофакторная аутентификация", "yesno"],
  ["Примечания администратора", "text"],
];

function when(ms) {
  return ms ? new Date(ms).toLocaleString("ru-RU") : "—";
}

// --- журнал ----------------------------------------------------------------

function log(e) {
  const entry = { at: Date.now(), ...e };
  entries.unshift(entry);
  const body = redact(JSON.stringify(e.data ?? e.error ?? null, null, 2));
  const div = document.createElement("div");
  div.className = "entry";
  const head = document.createElement("div");
  head.className = "head";
  const status = String(e.status ?? "");
  const bad = e.error || /^[45]\d\d$/.test(status) || status === "ошибка";
  head.innerHTML = `<span class="${bad ? "danger" : "ok"}"></span> <span class="muted"></span>`;
  head.children[0].textContent = `${e.method ?? ""} ${status}`.trim();
  head.children[1].textContent =
    `${new Date(entry.at).toLocaleTimeString("ru-RU")} · ${e.url ?? ""}` +
    `${e.ms != null ? ` · ${e.ms} мс` : ""}${e.note ? ` · ${e.note}` : ""}`;
  const pre = document.createElement("pre");
  pre.textContent = body.length > BODY_LIMIT
    ? `${body.slice(0, BODY_LIMIT)}\n… обрезано, всего ${body.length} знаков`
    : body;
  div.append(head, pre);
  $("log").prepend(div);
}

const fail = (what, e) => log({ method: what, status: "ошибка", error: String(e?.message ?? e) });

// --- итоги для отчёта о проверке ------------------------------------------
// Только статус, время и число записей — без содержимого ответов.

function countItems(data) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) if (Array.isArray(v)) return v.length;
    if (typeof data.cnt === "number") return data.cnt;
  }
  return null;
}

async function record(key, { ok, status, ms, note }) {
  const all = (await db.meta.get(REPORT)) ?? {};
  all[key] = { ok: Boolean(ok), status: String(status ?? ""), ms: ms ?? null, note: note ?? null, at: Date.now() };
  await db.meta.set(REPORT, all);
}

async function recordHttp(key, res) {
  const n = countItems(res?.data);
  await record(key, {
    ok: res?.status >= 200 && res?.status < 300,
    status: res?.status, ms: res?.ms, note: n == null ? null : `записей: ${n}`,
  });
}

// --- запрос администратору ------------------------------------------------

function adminRequestText(redirect) {
  return [
    "Запрос администратору TrueConf Server — расширение R7 Triage для Р7-Органайзера",
    "",
    "Расширение читает данные TrueConf только от имени вошедшего пользователя:",
    "чат конференции, фактических участников, беседы. Для этого прошу создать",
    "OAuth-приложение (панель управления → API → OAuth2):",
    "",
    "- Название: R7 Triage",
    `- Redirect URI: ${redirect}`,
    "- Типы авторизации (grant_types): только authorization_code и refresh_token.",
    "  client_credentials, password и остальные НЕ включать: секрет приложения",
    "  хранится в расширении на рабочих местах, и с client_credentials он давал бы",
    "  доступ к данным всего сервера без входа пользователя.",
    `- Права (scopes): ${SCOPES.join(", ")}`,
    "- Срок жизни токена доступа — по умолчанию (1 час), refresh-токена — не меньше 7 дней.",
    "",
    "Прошу сообщить:",
    "1. client_id и client_secret приложения — защищённым каналом;",
    "2. адрес сервера, версию TrueConf Server и версию API в пути (/api/v4.1 или иная);",
    "3. путь страницы входа OAuth на нашем сервере (в документации — /oauth2/authrize);",
    "4. включён ли Chatbot Connector (/websocket/chat_bot/) и можно ли им пользоваться",
    "   обычным учётным записям — через него расширение читает беседы;",
    "5. доступны ли журналы участников конференций (logs.*) обычным пользователям",
    "   или только администраторам;",
    "6. есть ли на странице входа «Запомнить меня» — нужно для входа без повторного",
    "   пароля после входа через плагин TrueConf;",
    "7. включена ли многофакторная аутентификация.",
  ].join("\n");
}

async function renderAdmin() {
  let redirect = "—";
  try { redirect = browser.identity.getRedirectURL(); } catch { /* покажем прочерк */ }
  $("adminRequest").textContent = adminRequestText(redirect);

  const answers = (await db.meta.get(ADMIN)) ?? {};
  const box = $("adminAnswers");
  box.textContent = "";
  for (const [q, kind] of ADMIN_QUESTIONS) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = q;
    let input;
    if (kind === "yesno") {
      input = document.createElement("select");
      for (const v of ["", "да", "нет", "неизвестно"]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v || "—";
        input.append(o);
      }
    } else {
      input = document.createElement("input");
      input.type = "text";
    }
    input.value = answers[q] ?? "";
    input.addEventListener("change", async () => {
      const all = (await db.meta.get(ADMIN)) ?? {};
      all[q] = input.value.trim();
      await db.meta.set(ADMIN, all);
    });
    label.append(span, input);
    box.append(label);
  }
}

$("copyRequest").addEventListener("click", () =>
  navigator.clipboard.writeText($("adminRequest").textContent));

$("saveRequest").addEventListener("click", () => {
  const blob = new Blob([$("adminRequest").textContent], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "запрос-администратору-trueconf.txt";
  document.body.append(a);
  a.click();
  a.remove();
});

// --- подключение -----------------------------------------------------------

async function cfg() {
  return (await settings.load()).trueconf;
}

async function api() {
  return new TrueConfApi({ cfg: await cfg(), store: db.meta, onRequest: log });
}

async function fill() {
  const c = await cfg();
  for (const k of FIELDS) $(k).value = c[k] ?? "";
  try {
    $("redirect").textContent = browser.identity.getRedirectURL();
  } catch (e) {
    $("redirect").textContent = `недоступно: ${e?.message ?? e}`;
  }
  await showSession();
}

async function showSession() {
  const s = await (await api()).session();
  $("session").textContent = s
    ? `вошли${s.userId ? ` как ${s.userId}` : ""}; токен до ${when(s.expiresAt)}` +
      `${s.hasRefresh ? ", продлевается" : ""}${s.scope ? `; права: ${s.scope}` : ""}`
    : "не вошли";
}

$("copyRedirect").addEventListener("click", () =>
  navigator.clipboard.writeText($("redirect").textContent));

$("save").addEventListener("click", async () => {
  const value = {};
  for (const k of FIELDS) value[k] = $(k).value.trim();
  value.server = serverBase(value.server);

  // Разрешение — под конкретный адрес сервера и по нажатию пользователя.
  // Запрос первым делом, до любого await: Firefox принимает
  // permissions.request только внутри обработчика нажатия.
  let asked = Promise.resolve(false);
  try {
    if (value.server) {
      const u = new URL(value.server);
      asked = browser.permissions.request({ origins: [`${u.protocol}//${u.host}/*`] });
    }
  } catch {
    $("saveStatus").textContent = "Адрес сервера разобрать не получилось.";
    return;
  }

  await settings.save("trueconf", value);
  $("server").value = value.server;
  if (!value.server) { $("saveStatus").textContent = "Сохранено. Сервер не задан."; return; }
  const granted = await asked.catch(() => false);
  $("saveStatus").textContent = granted
    ? "Сохранено, доступ к серверу разрешён."
    : "Сохранено, но без разрешения запросы к серверу не пройдут.";
});

// --- вход ------------------------------------------------------------------

$("login").addEventListener("click", async () => {
  try {
    const { silent, tokens } = await (await api()).login(browser.identity);
    await record("вход", { ok: true, status: "ok",
      note: silent ? "без окна, по сохранённой сессии" : "через окно входа сервера" });
    log({
      method: "ВХОД", status: "ok",
      note: silent ? "без окна — по сохранённой сессии" : "через окно входа сервера",
      data: { user_id: tokens.user_id, scope: tokens.scope, expires_in: tokens.expires_in,
        refresh_token: Boolean(tokens.refresh_token) },
    });
  } catch (e) {
    await record("вход", { ok: false, status: "ошибка", note: String(e?.message ?? e).slice(0, 120) });
    fail("ВХОД", e);
  }
  await showSession();
});

$("logout").addEventListener("click", async () => {
  await (await api()).logout();
  await showSession();
});

// --- Server API --------------------------------------------------------------

function confId() {
  const id = $("confId").value.trim();
  if (!id) throw new Error("укажите ID конференции");
  return id;
}

const QUERIES = {
  me: (a) => a.me(),
  conferences: (a) => a.conferences(),
  conference: (a) => a.conference(confId()),
  messages: (a) => a.conferenceMessages(confId()),
  participants: (a) => a.participantsLog(confId()),
  calls: (a) => a.callsLog(),
};

for (const btn of document.querySelectorAll("button[data-q]")) {
  btn.addEventListener("click", async () => {
    try {
      await recordHttp(btn.textContent, await QUERIES[btn.dataset.q](await api()));
    } catch (e) {
      await record(btn.textContent, { ok: false, status: "ошибка", note: String(e?.message ?? e).slice(0, 120) });
      fail(btn.textContent, e);
    }
  });
}

$("custom").addEventListener("click", async () => {
  try {
    const query = Object.fromEntries(new URLSearchParams($("customQuery").value.trim()));
    await (await api()).get($("customPath").value.trim(), query);
  } catch (e) {
    fail("GET", e);
  }
});

// --- беседы ------------------------------------------------------------------

async function connectChat(token, how) {
  socket?.close();
  socket = new ChatSocket({ url: chatSocketUrl(await cfg()), onLog: log });
  $("chatStatus").textContent = "подключаюсь…";
  try {
    const res = await socket.connect(token);
    $("chatStatus").textContent = `подключено (${how})${res?.userId ? ` как ${res.userId}` : ""}`;
    await record(`беседы: ${how}`, { ok: true, status: "ok" });
  } catch (e) {
    $("chatStatus").textContent = `не подключено (${how})`;
    socket = null;
    await record(`беседы: ${how}`, { ok: false, status: "ошибка", note: String(e?.message ?? e).slice(0, 120) });
    fail(`ЧАТ: ${how}`, e);
  }
}

$("chatWithApi").addEventListener("click", async () => {
  try {
    await connectChat(await (await api()).accessToken(), "токен входа");
  } catch (e) {
    fail("ЧАТ: токен входа", e);
  }
});

$("chatWithSaved").addEventListener("click", async () => {
  const t = await db.meta.get(SECRET_CHAT);
  if (!t?.access_token) { fail("ЧАТ", "токена бесед нет — получите его по паролю"); return; }
  await connectChat(t.access_token, "токен бесед");
});

$("chatToken").addEventListener("click", async () => {
  const password = $("chatPass").value;
  $("chatPass").value = "";   // пароль нигде не остаётся
  try {
    const t = await chatToken({
      cfg: await cfg(), store: db.meta, username: $("chatUser").value.trim(), password, onRequest: log,
    });
    log({ method: "ТОКЕН БЕСЕД", status: "ok", data: { expires_at: when(t.expires_at) } });
  } catch (e) {
    fail("ТОКЕН БЕСЕД", e);
  }
});

function needSocket() {
  if (!socket) throw new Error("сначала подключитесь к беседам");
  return socket;
}

$("chats").addEventListener("click", async () => {
  try {
    const r = await needSocket().getChats();
    await record("беседы: список", { ok: true, status: "ok", note: `бесед: ${countItems(r) ?? "?"}` });
  } catch (e) {
    await record("беседы: список", { ok: false, status: "ошибка", note: String(e?.message ?? e).slice(0, 120) });
    fail("getChats", e);
  }
});

$("history").addEventListener("click", async () => {
  try {
    const id = $("chatId").value.trim();
    if (!id) throw new Error("укажите ID беседы");
    const r = await needSocket().getChatHistory(id);
    await record("беседы: история", { ok: true, status: "ok", note: `сообщений: ${countItems(r) ?? "?"}` });
  } catch (e) {
    await record("беседы: история", { ok: false, status: "ошибка", note: String(e?.message ?? e).slice(0, 120) });
    fail("getChatHistory", e);
  }
});

// --- журнал: копирование -----------------------------------------------------

$("copyLog").addEventListener("click", async () => {
  const text = redact(JSON.stringify(entries, null, 2));
  await navigator.clipboard.writeText(text);
});

$("clearLog").addEventListener("click", () => {
  entries.length = 0;
  $("log").textContent = "";
});

renderAdmin();
fill();
