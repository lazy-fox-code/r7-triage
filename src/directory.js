// Каталог организации через адресные книги клиента (T5).
//
// Источник уровня отправителя — должность и подразделение из GAL. Решение о
// собственной таблице адресатов (выгрузка из AD) отложено 22.09.2026:
// пока собираем через GAL, разбор развилки — в `docs/directory.md`.
//
// Правила обращения к каталогу (architecture.md, «Каталог AD/GAL»):
//
//   · на горячем пути — только локальные книги (`includeRemote: false`);
//   · в GAL ходим за незнакомыми адресами и только по делу: очередь
//     последовательная, с паузой между запросами и потолком на сеанс.
//     Контроллеры домена перегружены, и уровень отправителя — уточняющий
//     признак: он терпит задержку;
//   · найденное кэшируется в `people` надолго — должность и подразделение
//     меняются редко, а ненайденное кэшируется ненадолго, чтобы каждый
//     внешний адрес не превращался в запрос к домену;
//   · руководителя книга не отдаёт (проверка 22.09.2026, поля `manager` в
//     карточках нет) — поле остаётся пустым, иерархия берётся из графа.
//
// Уровень влияет на приоритет и срок поручения, но не на факт
// классификации (правило 3 в CLAUDE.md), поэтому отсутствие каталога
// ничего не ломает: без него просто нет приоритета.

import { normalizeAddress } from "./keys.js";

const DAY = 86400000;

/** Свойства карточки, из которых берётся уровень. */
const FIELDS = {
  title: ["JobTitle", "Title"],
  department: ["Department"],
  company: ["Company"],
  manager: ["Manager", "X-MANAGER"],
  name: ["DisplayName", "FN"],
};

/** Строки vCard: TITLE, ORG (компания;подразделение), FN. */
function fromVCard(vcard) {
  const out = {};
  if (typeof vcard !== "string") return out;
  // Продолжения длинных строк в vCard начинаются с пробела.
  const text = vcard.replace(/\r?\n[ \t]/g, "");
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9-]*)(;[^:]*)?:(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].toUpperCase();
    const value = m[3].replace(/\\([,;\\])/g, "$1").trim();
    if (!value) continue;
    if (name === "TITLE" && !out.title) out.title = value;
    else if (name === "FN" && !out.name) out.name = value;
    else if (name === "ORG" && !out.company) {
      const parts = value.split(/(?<!\\);/).map((p) => p.trim()).filter(Boolean);
      out.company = parts[0] ?? "";
      if (parts[1] && !out.department) out.department = parts[1];
    }
  }
  return out;
}

/** Адреса карточки — чтобы не принять однофамильца за искомого человека. */
export function contactEmails(contact) {
  const props = contact?.properties ?? {};
  const out = new Set();
  for (const key of ["PrimaryEmail", "SecondEmail", "EMAIL", "mail"]) {
    const v = props[key];
    if (typeof v === "string" && v.includes("@")) out.add(normalizeAddress(v));
  }
  const vcard = props.vCard ?? props.vcard;
  if (typeof vcard === "string") {
    for (const line of vcard.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
      const m = /^EMAIL(?:;[^:]*)?:(.+)$/i.exec(line);
      if (m) out.add(normalizeAddress(m[1]));
    }
  }
  out.delete("");
  return out;
}

/** Уровень из карточки: сначала свойства, затем vCard. */
export function levelOf(contact) {
  const props = contact?.properties ?? {};
  const out = {};
  for (const [key, names] of Object.entries(FIELDS)) {
    for (const n of names) {
      const v = props[n];
      if (typeof v === "string" && v.trim()) { out[key] = v.trim(); break; }
    }
  }
  const vcard = fromVCard(props.vCard ?? props.vcard);
  for (const [key, value] of Object.entries(vcard)) {
    if (!out[key] && value) out[key] = value;
  }
  return out;
}

/**
 * Очередь запросов к каталогу. Последовательная и с паузой: несколько
 * карточек дела, открытых подряд, не должны превращаться в залп к
 * контроллеру домена.
 */
export class DirectoryLookup {
  /**
   * @param {object} deps.browser WebExtension API (разрешение addressBooks)
   * @param {object} deps.db      модуль хранилища
   * @param {object} deps.cfg     ветка `directory` настроек
   * @param {Function} deps.now   для тестов
   */
  constructor({ browser, db, cfg, now = () => Date.now() }) {
    this.browser = browser;
    this.db = db;
    this.cfg = cfg;
    this.now = now;
    this.chain = Promise.resolve();
    this.remoteCalls = 0;
    this.memory = new Map();
  }

  /**
   * Уровень отправителя: из кэша, из локальных книг, из GAL.
   *
   * @param {string} email нормализованный адрес
   * @returns {Promise<object|null>} { title, department, company, manager,
   *   source, at, found } или null, если каталог выключен
   */
  async level(email) {
    if (!this.cfg.enabled || !email) return null;
    const cached = this.memory.get(email) ?? (await this.db.get("people", email))?.directory;
    if (cached && this.#fresh(cached)) {
      this.memory.set(email, cached);
      return cached;
    }
    // Запросы идут по одному: очередь — это и есть пауза между обращениями.
    const result = await (this.chain = this.chain.then(() => this.#lookup(email)).catch(() => null));
    return result;
  }

  #fresh(entry) {
    const days = entry.found ? this.cfg.cacheDays : this.cfg.missTtlDays;
    return entry.at && this.now() - entry.at < days * DAY;
  }

  async #lookup(email) {
    // Пока письмо ждало очереди, адрес мог приехать из соседнего запроса.
    const known = this.memory.get(email);
    if (known && this.#fresh(known)) return known;

    let entry = await this.#search(email, false);
    if (!entry && this.cfg.includeRemote && this.remoteCalls < this.cfg.maxPerSession) {
      if (this.remoteCalls > 0) await this.#pause();
      this.remoteCalls++;
      entry = await this.#search(email, true);
    }
    const result = entry ?? { found: false, source: "none", at: this.now() };
    this.memory.set(email, result);
    await this.#store(email, result);
    return result;
  }

  #pause() {
    return new Promise((r) => setTimeout(r, this.cfg.pauseMs));
  }

  async #search(email, remote) {
    let found = [];
    try {
      found = await this.browser.contacts.quickSearch({
        searchString: email, includeLocal: !remote, includeRemote: remote,
      });
    } catch {
      return null;
    }
    for (const contact of found ?? []) {
      if (!contactEmails(contact).has(email)) continue;
      const level = levelOf(contact);
      if (!level.title && !level.department && !level.company && !level.name) continue;
      return { ...level, found: true, source: remote ? "remote" : "local", at: this.now() };
    }
    return null;
  }

  /** Кэш живёт рядом с профилем отправителя — в одной записи `people`. */
  async #store(email, directory) {
    const row = await this.db.get("people", email);
    await this.db.put("people", { ...(row ?? { id: email, email }), directory });
  }
}
