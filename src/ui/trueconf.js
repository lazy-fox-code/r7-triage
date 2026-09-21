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
    log({
      method: "ВХОД", status: "ok",
      note: silent ? "без окна — по сохранённой сессии" : "через окно входа сервера",
      data: { user_id: tokens.user_id, scope: tokens.scope, expires_in: tokens.expires_in,
        refresh_token: Boolean(tokens.refresh_token) },
    });
  } catch (e) {
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
    try { await QUERIES[btn.dataset.q](await api()); } catch (e) { fail(btn.textContent, e); }
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
  } catch (e) {
    $("chatStatus").textContent = `не подключено (${how})`;
    socket = null;
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
  try { await needSocket().getChats(); } catch (e) { fail("getChats", e); }
});

$("history").addEventListener("click", async () => {
  try {
    const id = $("chatId").value.trim();
    if (!id) throw new Error("укажите ID беседы");
    await needSocket().getChatHistory(id);
  } catch (e) {
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

fill();
