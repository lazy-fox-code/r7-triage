// Клиент TrueConf от имени пользователя: Server API и беседы.
//
// Правило продукта: сеть — только к модели и к серверу TrueConf, и к
// TrueConf — только под учётной записью пользователя. Отсюда устройство
// входа:
//
//   Server API  OAuth Authorization Code. Пользователь входит на странице
//               своего сервера. Если он уже вошёл через плагин TrueConf с
//               «запомнить меня», сервер пускает по сохранённой сессии
//               (`/oauth2/autologin`), и второй раз пароль не нужен.
//               Обмен кода на токен у TrueConf требует `client_secret`,
//               поэтому у OAuth-приложения администратор оставляет только
//               `authorization_code` и `refresh_token`: без входа
//               пользователя секрет ничего не открывает.
//
//   Беседы      Личных и групповых бесед в Server API v4.1 нет. Они есть в
//               Chatbot Connector — WebSocket от имени обычной учётной
//               записи. Его токен выдаётся по логину и паролю на месяц
//               (`client_id: "chat_bot"`, `grant_type: "password"`); пароль
//               не сохраняется. Примет ли коннектор токен Server API —
//               проверяется на странице проверки подключения.
//
// Токены лежат в IndexedDB под ключами `secret:*`. В выгрузку состояния в
// JSON они не попадают (db.js).

export const SECRET_API = "secret:trueconf";
export const SECRET_CHAT = "secret:trueconf-chat";

const REFRESH_MARGIN_MS = 60000;
const SOCKET_TIMEOUT_MS = 30000;

/** «tc.corp.ru», «https://tc.corp.ru/» → «https://tc.corp.ru» */
export function serverBase(server) {
  const s = String(server ?? "").trim().replace(/\/+$/, "");
  if (!s) return "";
  return /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
}

export function apiBase(cfg) {
  return `${serverBase(cfg.server)}/api/${cfg.apiVersion}`;
}

export function chatSocketUrl(cfg) {
  return `${serverBase(cfg.server).replace(/^http/i, "ws")}/websocket/chat_bot/`;
}

/** Для журнала: значения токенов и секретов не показываем. */
export function redact(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return s
    .replace(/(access_token|refresh_token|auth_code|client_secret|password|token)("?\s*[:=]\s*"?)([^"&,\s}]{4})[^"&,\s}]*/gi,
      "$1$2$3…");
}

function randomState() {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    return [...c.getRandomValues(new Uint8Array(12))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// --- Server API ------------------------------------------------------------

export class TrueConfApi {
  /**
   * @param {object} deps.cfg    ветка `trueconf` из настроек
   * @param {object} deps.store  { get(key), set(key, value) } — db.meta
   * @param {Function} deps.fetch
   * @param {Function} deps.onRequest журнал: { method, url, status, ms, data }
   */
  constructor({ cfg, store, fetch = (...a) => globalThis.fetch(...a), onRequest = () => {} }) {
    this.cfg = cfg;
    this.store = store;
    this.fetch = fetch;
    this.onRequest = onRequest;
  }

  get tokenUrl() {
    return this.cfg.tokenUrl || `${apiBase(this.cfg)}/oauth2/token`;
  }

  authorizeUrl(redirectUri, state) {
    const u = new URL(`${serverBase(this.cfg.server)}${this.cfg.authorizePath}`);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", redirectUri);
    if (state) u.searchParams.set("state", state);
    return u.toString();
  }

  /**
   * Вход через страницу сервера. Сначала без окна — сработает, если сервер
   * пускает по сохранённой сессии без участия человека; иначе с окном, где
   * при живой сессии пароль спрашиваться не должен.
   *
   * @returns {{ silent: boolean, tokens: object }}
   */
  async login(identity, { allowInteractive = true } = {}) {
    const redirectUri = identity.getRedirectURL();
    const state = randomState();
    const url = this.authorizeUrl(redirectUri, state);

    let back = null;
    let silent = true;
    try {
      back = await identity.launchWebAuthFlow({ url, interactive: false });
    } catch (e) {
      if (!allowInteractive) throw e;
      silent = false;
      back = await identity.launchWebAuthFlow({ url, interactive: true });
    }

    const u = new URL(back);
    const params = new URLSearchParams(u.search || u.hash.slice(1));
    if (params.get("error")) {
      throw new Error(`сервер отказал во входе: ${params.get("error")} ${params.get("error_description") ?? ""}`);
    }
    // В документации TrueConf о state ни слова: если сервер его вернул,
    // сверяем, если не вернул — не считаем это ошибкой.
    if (params.get("state") && params.get("state") !== state) {
      throw new Error("state в ответе не совпал — вход отклонён");
    }
    const code = params.get("code");
    if (!code) throw new Error(`в адресе возврата нет code: ${u.search || u.hash}`);
    return { silent, tokens: await this.exchangeCode(code) };
  }

  async exchangeCode(code) {
    return this.#tokenRequest({
      grant_type: "authorization_code",
      auth_code: code,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
  }

  async refresh() {
    const t = await this.store.get(SECRET_API);
    if (!t?.refresh_token) throw new Error("нужен вход: refresh-токена нет");
    try {
      return await this.#tokenRequest({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: this.cfg.clientId,
      });
    } catch (e) {
      await this.logout();
      throw new Error(`нужен вход: продлить доступ не удалось (${e.message})`);
    }
  }

  async logout() {
    await this.store.set(SECRET_API, null);
  }

  /** Сведения о входе без самих токенов. */
  async session() {
    const t = await this.store.get(SECRET_API);
    if (!t) return null;
    return {
      userId: t.user_id ?? null,
      displayName: t.display_name ?? null,
      scope: t.scope ?? null,
      expiresAt: t.expires_at ?? null,
      hasRefresh: Boolean(t.refresh_token),
      obtainedAt: t.obtainedAt,
    };
  }

  async #tokenRequest(body) {
    const t0 = Date.now();
    const res = await this.fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readBody(res);
    this.onRequest({
      method: "POST", url: this.tokenUrl, status: res.status, ms: Date.now() - t0,
      note: `grant_type=${body.grant_type}`, data,
    });
    if (!res.ok || !data?.access_token) {
      throw new Error(`токен не выдан: HTTP ${res.status} ${redact(data)}`);
    }
    const tokens = {
      ...data,
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
      obtainedAt: Date.now(),
    };
    // Refresh-токен сервер может не прислать при продлении — старый живёт.
    if (!tokens.refresh_token) {
      tokens.refresh_token = (await this.store.get(SECRET_API))?.refresh_token ?? null;
    }
    await this.store.set(SECRET_API, tokens);
    return tokens;
  }

  /** Токен доступа, продлённый при необходимости. */
  async accessToken() {
    const t = await this.store.get(SECRET_API);
    if (!t?.access_token) throw new Error("нужен вход в TrueConf");
    if (t.expires_at && t.expires_at - REFRESH_MARGIN_MS < Date.now()) {
      return (await this.refresh()).access_token;
    }
    return t.access_token;
  }

  /**
   * GET к Server API. 401 — один раз продлеваем токен и повторяем.
   *
   * @param {string} path  относительно /api/<версия>/, например «me/token»
   * @param {object} query параметры строки запроса
   * @returns {{ status: number, ms: number, data: any }}
   */
  async get(path, query = {}) {
    const url = new URL(`${apiBase(this.cfg)}/${String(path).replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }

    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const t0 = Date.now();
      const res = await this.fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const data = await readBody(res);
      const out = { status: res.status, ms: Date.now() - t0, data };
      this.onRequest({ method: "GET", url: url.toString(), ...out });
      if (res.status === 401 && attempt === 0) {
        await this.refresh();
        continue;
      }
      return out;
    }
  }

  // Запросы, которые проверяем. Пути — по спецификации Server API v4.1.
  me() { return this.get("me/token"); }
  conferences(query = {}) { return this.get("conferences", { page: 1, page_size: 20, ...query }); }
  conference(id) { return this.get(`conferences/${encodeURIComponent(id)}`); }
  conferenceMessages(id, query = {}) {
    return this.get(`conferences/${encodeURIComponent(id)}/messages`, { page: 1, page_size: 50, ...query });
  }
  participantsLog(id, query = {}) {
    return this.get(`logs/conferences/${encodeURIComponent(id)}/participants`, query);
  }
  callsLog(query = {}) { return this.get("logs/calls", { page: 1, page_size: 20, ...query }); }
}

// --- беседы: Chatbot Connector --------------------------------------------

/**
 * Токен бесед по логину и паролю. Пароль уходит только на сервер TrueConf и
 * нигде не сохраняется; токен живёт месяц.
 */
export async function chatToken({ cfg, store, username, password, fetch = (...a) => globalThis.fetch(...a), onRequest = () => {} }) {
  const url = `${serverBase(cfg.server)}/bridge/api/client/v1/oauth/token`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "chat_bot", grant_type: "password", username, password }),
  });
  const data = await readBody(res);
  onRequest({ method: "POST", url, status: res.status, ms: Date.now() - t0, note: "grant_type=password", data });
  if (!res.ok || !data?.access_token) {
    throw new Error(`токен бесед не выдан: HTTP ${res.status} ${redact(data)}`);
  }
  const token = {
    access_token: data.access_token,
    token_type: data.token_type ?? "JWT",
    expires_at: data.expires_at ? data.expires_at * 1000 : null,
    obtainedAt: Date.now(),
  };
  await store.set(SECRET_CHAT, token);
  return token;
}

/**
 * Соединение с Chatbot Connector. Запрос — { type: 1, id, method, payload },
 * ответ — { type: 2, id, payload } с тем же id. Сервер и сам шлёт запросы
 * (новое сообщение — `sendMessage`); на них отвечаем { type: 2, id }, иначе
 * он будет их повторять.
 */
export class ChatSocket {
  #ws = null;
  #id = 0;
  #pending = new Map();

  constructor({ url, WebSocketImpl = globalThis.WebSocket, onLog = () => {}, timeoutMs = SOCKET_TIMEOUT_MS }) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.onLog = onLog;
    this.timeoutMs = timeoutMs;
    this.events = [];
  }

  /** Открывает сокет и авторизуется. Возвращает ответ на auth. */
  async connect(token, tokenType = "JWT") {
    await new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url);
      this.#ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`WebSocket ${this.url} не открылся`));
      ws.onclose = (e) => {
        for (const p of this.#pending.values()) p.reject(new Error(`соединение закрыто (${e?.code ?? "?"})`));
        this.#pending.clear();
      };
      ws.onmessage = (e) => this.#onMessage(e.data);
    });
    return this.call("auth", { token, tokenType, receiveUnread: false });
  }

  call(method, payload = {}) {
    const id = ++this.#id;
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: нет ответа за ${this.timeoutMs} мс`));
      }, this.timeoutMs);
      this.#pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          this.onLog({ method: "WS", url: method, status: msg.payload?.errorCode ? "ошибка" : "ok",
            ms: Date.now() - t0, data: msg.payload });
          if (msg.payload?.errorCode) {
            reject(new Error(`${method}: ${msg.payload.errorCode} ${msg.payload.errorDescription ?? ""}`));
          } else {
            resolve(msg.payload);
          }
        },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#ws.send(JSON.stringify({ type: 1, id, method, payload }));
    });
  }

  getChats(page = 1, count = 50) { return this.call("getChats", { count, page }); }
  getChatHistory(chatId, count = 50, fromMessageId) {
    const payload = { chatId, count };
    if (fromMessageId) payload.fromMessageId = fromMessageId;
    return this.call("getChatHistory", payload);
  }

  close() { this.#ws?.close(); }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 2) {
      this.#pending.get(msg.id)?.resolve(msg);
      this.#pending.delete(msg.id);
      return;
    }
    if (msg.type === 1) {
      // Запрос сервера: подтверждаем получение и запоминаем событие.
      this.#ws.send(JSON.stringify({ type: 2, id: msg.id }));
      this.events.push({ method: msg.method, at: Date.now() });
      this.onLog({ method: "WS←", url: msg.method, status: "событие", ms: 0, data: msg.payload });
    }
  }
}
