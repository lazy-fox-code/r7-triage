// Проход обогащения (T2): полные заголовки для писем, которые проход по
// ящику записал только по MessageHeader.
//
// Почему отдельный проход
// -----------------------
// References, In-Reply-To, List-*, Precedence, вложения и части письма в
// MessageHeader не приходят. В Thunderbird 115 их отдаёт только
// `messages.getFull`, а он устроен так (ext-messages.js, comm-esr115):
//
//     MsgHdrToMimeMessage(msgHdr, null, cb, /* allowDownload */ true,
//                         { examineEncryptedParts: true })
//
// То есть письмо читается целиком и разбирается как MIME, а если тела нет в
// офлайн-хранилище — скачивается с сервера. Заголовков без тела в 115 не
// получить ничем: `messages.getHeaders` появился только в TB 147, а фильтр
// `attachment` в `messages.query` тоже разбирает MIME каждого письма. Поэтому
// полное чтение — отдельный проход, который идёт от свежих писем к старым,
// уступает место проходу по ящику и останавливается, когда пользователь
// вернулся к клиенту.
//
// Что извлекаем
// -------------
// Всё, что нужно дешёвым признакам и связям дела, за одно чтение, чтобы
// второй раз письмо не читать:
//
//   thread        ветка: корень и родитель по References / In-Reply-To;
//                 у писем Exchange ещё корень Thread-Index — Outlook ведёт
//                 беседу по нему, и References у таких писем бывают неполны;
//   bulk          признаки рассылки и автоматики — значения заголовков,
//                 а не готовые выводы: правила гейта уточняются без
//                 повторного чтения, и значение же служит цитатой вердикта;
//   attachments   имена, типы и размеры вложений (не тела);
//   calendar      встречи и задачи из text/calendar: UID, метод, время,
//                 организатор, участники — ключ связи письма со встречей;
//   conferences   ссылки на конференции TrueConf с темой — ключ связи
//                 с ВКС (номер + тема: номера на сервере обнуляют).
//
// Тело письма не сохраняется: оно лежит в офлайн-хранилище Thunderbird.
// Из текста берутся только ссылки на конференции.
//
// Сервер Exchange
// ---------------
// При хранении всех сообщений офлайн `getFull` читает архив с диска и к
// серверу не обращается. Исключение — свежее письмо, у которого клиент
// успел получить только заголовки: тогда `getFull` скачает тело сам, раньше
// клиента. Поэтому письма моложе `freshDelayMinutes` проход не трогает —
// к этому времени клиент сохраняет их офлайн своим обычным порядком.
// Долгие чтения (`slowReadMs`) считаются отдельно: на живом ящике по ним
// видно, ходил ли `getFull` на сервер.
//
// Позиция и возобновление
// -----------------------
// Позиция прохода — в самих письмах: `enriched` переходит из 0 в итоговое
// состояние сразу после обработки письма, а очередь выбирается составным
// индексом [enriched, date] от свежих к старым. После перезапуска клиента
// проход берёт следующую пачку с того же места без отдельного курсора.
// В `meta` лежит только статистика и причина последней остановки.
//
// Номер письма для getFull — номер текущей сессии: он не переживает
// перезапуск. Поэтому перед чтением пачка сопоставляется с письмами
// Thunderbird заново, одним запросом по папке и диапазону дат, и сверка идёт
// по устойчивому ключу (keys.js). Запрос `headerMessageId` на каждое письмо
// здесь хуже: в 115 любой `messages.query` перебирает папку целиком.

import { messageKey, parseFolderKey } from "./keys.js";
import { ENRICH } from "./db.js";
import { parseCalendar } from "./ical.js";
import { conferenceRefs, conferenceKey } from "./trueconf.js";

const DAY = 86400000;
const STATE_KEY = "enrich";
const STATE_VERSION = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (s, n) => (s ? String(s).slice(0, n) : null);

// --- извлечение ----------------------------------------------------------

const firstHeader = (headers, name) => String(headers?.[name]?.[0] ?? "").trim();
const allHeaders = (headers, name) => (headers?.[name] ?? []).join(" ");

/** Идентификаторы писем из References / In-Reply-To в виде ключей keys.js. */
function messageIds(value) {
  const s = String(value ?? "");
  const bracketed = [...s.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
  // Встречаются клиенты, которые пишут идентификаторы без угловых скобок.
  const ids = bracketed.length ? bracketed : s.split(/[\s,]+/).filter((x) => x.includes("@"));
  return ids.map((id) => `m:${id.trim().toLowerCase()}`);
}

/**
 * Корень беседы Outlook. Thread-Index — base64: 22 байта заголовка беседы
 * и по 5 байт на каждый ответ. Заголовок общий у всей беседы.
 */
export function threadIndexRoot(value) {
  const v = String(value ?? "").replace(/\s+/g, "");
  if (!v) return null;
  let bin;
  try { bin = atob(v); } catch { return null; }
  if (bin.length < 22) return null;
  let hex = "";
  for (let i = 0; i < 22; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return { root: `ti:${hex}`, depth: Math.floor((bin.length - 22) / 5) };
}

function threadFacts(headers, ownKey) {
  const refs = messageIds(allHeaders(headers, "references"));
  const inReplyTo = messageIds(firstHeader(headers, "in-reply-to"))[0] ?? null;
  const root = refs[0] ?? inReplyTo;
  const parent = inReplyTo ?? refs[refs.length - 1] ?? null;
  const ti = threadIndexRoot(firstHeader(headers, "thread-index"));

  return {
    // Лучшая оценка ветки по одному письму. Корень References общий у всех
    // ответов; письмо без References само является корнем, и его ключ
    // совпадает с корнем у ответов на него. Цепочки из одних In-Reply-To
    // здесь не склеиваются — это делает граф по `thread.parent` (T4).
    threadId: root ?? ownKey,
    thread: {
      root,
      parent,
      depth: Math.max(refs.length, ti?.depth ?? 0, parent ? 1 : 0),
      index: ti?.root ?? null,
      topic: cut(firstHeader(headers, "thread-topic"), 200),
    },
  };
}

function bulkFacts(headers) {
  const out = {};
  const listId = firstHeader(headers, "list-id");
  if (listId) out.listId = cut(listId, 200);
  if (firstHeader(headers, "list-unsubscribe")) out.listUnsubscribe = true;
  const precedence = firstHeader(headers, "precedence").toLowerCase();
  if (precedence) out.precedence = cut(precedence, 40);
  const auto = firstHeader(headers, "auto-submitted").toLowerCase();
  if (auto) out.autoSubmitted = cut(auto, 60);
  const suppress = firstHeader(headers, "x-auto-response-suppress");
  if (suppress) out.autoResponseSuppress = cut(suppress, 60);
  return Object.keys(out).length ? out : null;
}

const isCalendarPart = (ct, name) =>
  ct.startsWith("text/calendar") || ct === "application/ics" || /\.ics$/i.test(name);

const isEncrypted = (ct) =>
  ct.startsWith("multipart/encrypted") || ct.includes("pkcs7-mime");

/**
 * Обход дерева частей. В 115 у MessagePart нет contentDisposition: его
 * приходится брать из заголовков части.
 */
export function readParts(full) {
  const out = { attachments: [], calendars: [], texts: [], encrypted: false, empty: false };
  // Письмо, скачанное без тела (POP, «только заголовки»): getFull в 115
  // отдаёт такое с пустым списком частей.
  if (!full?.parts?.length) { out.empty = true; return out; }

  const walk = (part) => {
    const ct = String(part.contentType ?? "").toLowerCase();
    const name = String(part.name ?? "");
    const disposition = firstHeader(part.headers, "content-disposition").toLowerCase();

    if (isEncrypted(ct)) out.encrypted = true;

    if (isCalendarPart(ct, name)) {
      out.calendars.push({
        partName: part.partName ?? null,
        body: typeof part.body === "string" ? part.body : null,
        size: part.size ?? 0,
      });
    } else if (typeof part.body === "string" && ct.startsWith("text/")) {
      out.texts.push(part.body);
    }

    const container = ct.startsWith("multipart/");
    const attached = disposition.startsWith("attachment")
      || (name && !container && !(ct.startsWith("text/") && !disposition));
    if (attached && !isCalendarPart(ct, name)) {
      out.attachments.push({
        name: cut(name, 200) ?? "",
        contentType: ct.split(";")[0],
        size: part.size ?? 0,
        partName: part.partName ?? null,
        // Картинки подписи и прочие cid:-вложения — не «письмо с
        // вложением». Для исключений устаревшего информирования (T6) это
        // разница между правилом, которое работает, и правилом, под которое
        // попадает каждое письмо из Outlook.
        inline: !disposition.startsWith("attachment")
          && (disposition.startsWith("inline") || Boolean(firstHeader(part.headers, "content-id"))),
      });
    }
    for (const p of part.parts ?? []) walk(p);
  };
  walk(full);
  return out;
}

/**
 * Итоговые поля записи письма.
 *
 * @param {object} full     MessagePart из getFull
 * @param {object} parts    результат readParts, с дочитанными календарями
 * @param {string} ownKey   устойчивый ключ этого письма
 * @param {object} opts     { hosts, maxScanChars }
 */
export function buildFacts(full, parts, ownKey, { hosts = [], maxScanChars = 200000 } = {}) {
  const headers = full?.headers ?? {};
  const { threadId, thread } = threadFacts(headers, ownKey);

  const calendar = [];
  // Где искать ссылки на конференции и какой темой их называть.
  const scanned = [];
  for (const c of parts.calendars) {
    if (!c.body) continue;
    const { method, items } = parseCalendar(c.body);
    for (const it of items) {
      calendar.push({
        kind: it.kind,
        method,
        uid: it.uid,
        sequence: it.sequence ?? 0,
        recurrenceId: it.recurrenceId ?? null,
        summary: cut(it.summary, 300),
        location: cut(it.location, 300),
        status: it.status ?? null,
        start: it.start ?? null,
        end: it.end ?? it.due ?? null,
        organizer: it.organizer ?? null,
        attendees: it.attendees,
      });
      // Ссылка на ВКС чаще всего живёт в месте и описании встречи, и тема
      // встречи точнее темы письма: у ответа это «RE: …», у пересылки «FW: …».
      const topic = it.summary ?? firstHeader(headers, "subject");
      scanned.push({ text: it.location ?? "", topic, at: it.start?.ms ?? null });
      scanned.push({ text: it.description ?? "", topic, at: it.start?.ms ?? null });
    }
  }
  // Текст письма-приглашения описывает ту же встречу, что его .ics: ссылка
  // из тела получает тему встречи. В обычном письме — тему письма.
  const meeting = calendar.find((c) => c.summary);
  for (const t of parts.texts) {
    scanned.push({
      text: t.slice(0, maxScanChars),
      topic: meeting?.summary ?? firstHeader(headers, "subject"),
      at: meeting?.start?.ms ?? null,
    });
  }

  // Одна конференция в письме встречается и в приглашении, и в тексте;
  // приглашение идёт первым, и его тема побеждает.
  const conferences = [];
  const seen = new Set();
  for (const { text, topic, at } of scanned) {
    for (const ref of conferenceRefs(text, hosts)) {
      const k = `${ref.host ?? ""}|${ref.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      conferences.push({ ...ref, topic: cut(topic, 300), key: conferenceKey(ref, topic), at });
    }
  }

  // Про вложения честно: у пустого или зашифрованного письма их состав
  // неизвестен, и null здесь значит «не знаем», а не «нет». Исключение T6
  // обязано трактовать неизвестность как наличие.
  const known = !parts.empty && !parts.encrypted;

  return {
    threadId,
    thread,
    bulk: bulkFacts(headers),
    attachments: parts.attachments,
    hasAttachments: known ? parts.attachments.some((a) => !a.inline) : null,
    calendar,
    conferences,
  };
}

// --- проход --------------------------------------------------------------

function freshState() {
  return {
    v: STATE_VERSION,
    startedAt: Date.now(),
    since: null,
    done: false,
    error: null,
    cursorDate: null,
    stats: {
      enriched: 0, skipped: 0, failed: 0, notFound: 0, requeued: 0,
      fullReads: 0, slowReads: 0, calendarReads: 0, queries: 0,
      meetings: 0, tasks: 0, conferences: 0,
    },
  };
}

export class Enricher {
  #running = false;
  #stopped = false;
  #state = null;
  #startedAt = 0;
  #progress = null;
  #processed = 0;

  /**
   * @param {object}   deps.browser     WebExtension API
   * @param {object}   deps.db          модуль хранилища
   * @param {object}   deps.config      ветка `enrich` из настроек
   * @param {string[]} deps.hosts       серверы TrueConf для распознавания ссылок
   * @param {number}   deps.overlapDays запас по дате при поиске письма в папке
   */
  constructor({ browser, db, config, hosts = [], overlapDays = 1, onProgress = () => {} }) {
    this.browser = browser;
    this.db = db;
    this.cfg = config;
    this.hosts = hosts;
    this.padMs = Math.max(overlapDays, 1) * DAY;
    this.onProgress = onProgress;
  }

  get running() { return this.#running; }

  /** Остановка без потерь: обработанное уже записано в письма. */
  stop() { this.#stopped = true; }

  status() {
    return {
      running: this.#running,
      stopping: this.#running && this.#stopped,
      progress: this.#progress,
    };
  }

  /**
   * @param {number|null} since  мс; письма старше не трогать (свежий проход)
   * @param {boolean}     requeue вернуть в очередь письма, не прочитанные
   *                              раньше, если с тех пор прошло `retryAfterDays`
   */
  async run({ since = null, requeue = false } = {}) {
    if (this.#running) return this.status();
    this.#running = true;
    this.#stopped = false;
    this.#startedAt = Date.now();
    this.#processed = 0;

    try {
      const saved = await this.db.meta.get(STATE_KEY);
      const state = saved?.v === STATE_VERSION ? saved : freshState();
      this.#state = state;
      Object.assign(state, { since, done: false, error: null, resumedAt: Date.now() });
      state.stats.slowReads ??= 0;
      // Свежие письма ждут, пока клиент сохранит их офлайн сам.
      const until = this.cfg.freshDelayMinutes
        ? Date.now() - this.cfg.freshDelayMinutes * 60000 : null;

      if (requeue) state.stats.requeued += await this.#requeueFailed();

      // Письма, на которых подряд не удалось чтение. Серия означает беду
      // окружения (сеть, сервер Exchange), а не писем, и тогда эти письма
      // возвращаются в очередь, а проход останавливается.
      let streak = [];

      while (!this.#stopped) {
        const batch = await this.db.enrichQueue({ since, until, limit: this.cfg.batchSize });
        if (!batch.length) {
          state.done = true;
          state.finishedAt = Date.now();
          break;
        }

        const found = await this.#resolve(batch, state);

        for (const row of batch) {
          if (this.#stopped) break;
          const hdr = found.get(row.id);
          const result = hdr
            ? await this.#one(row, hdr, state)
            : await this.#finish(row.id, ENRICH.FAILED, { enrichError: "not-found" }, state);

          if (result === "error") {
            streak.push(row.id);
            if (streak.length >= this.cfg.maxConsecutiveErrors) {
              for (const key of streak) await this.#putBack(key, state);
              state.error = `${streak.length} писем подряд не читаются — ` +
                "похоже на недоступность сервера. Проход остановлен, письма возвращены в очередь.";
              this.#stopped = true;
              break;
            }
          } else if (result !== "not-found") {
            streak = [];
          }
          this.#processed++;
          this.#emit();
        }

        state.cursorDate = batch[batch.length - 1].date;
        await this.#save(state);
      }

      await this.#save(state);
      return this.status();
    } finally {
      this.#running = false;
      this.#emit();
    }
  }

  // --- сопоставление с письмами текущей сессии ---------------------------

  /**
   * Ключ → MessageHeader текущей сессии. Письмо ищется в первом месте
   * хранения, не нашлось — в следующем: его могли перенести после прохода
   * по ящику.
   */
  async #resolve(batch, state) {
    const found = new Map();
    let pending = batch.map((row) => ({ row, locs: [...(row.locations ?? [])] }));

    while (pending.length && !this.#stopped) {
      const groups = new Map();
      for (const p of pending) {
        const loc = p.locs.shift();
        if (!loc) continue;        // мест больше нет — письмо не найдено
        if (!groups.has(loc)) groups.set(loc, []);
        groups.get(loc).push(p);
      }
      pending = [];
      for (const [loc, items] of groups) {
        const hdrs = await this.#lookup(loc, items.map((p) => p.row), state);
        for (const p of items) {
          if (hdrs.has(p.row.id)) found.set(p.row.id, hdrs.get(p.row.id));
          else pending.push(p);
        }
      }
    }
    return found;
  }

  /** Один запрос по папке и диапазону дат пачки. */
  async #lookup(fkey, rows, state) {
    const out = new Map();
    const wanted = new Set(rows.map((r) => r.id));
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) { min = Math.min(min, r.date); max = Math.max(max, r.date); }

    try {
      // `folder` объектом: `folderId` в queryInfo появился только в TB 121.
      let page = await this.browser.messages.query({
        folder: parseFolderKey(fkey),
        fromDate: new Date(min - this.padMs),
        toDate: new Date(max + this.padMs),
      });
      state.stats.queries++;
      while (page) {
        for (const hdr of page.messages ?? []) {
          const key = messageKey(hdr);
          if (wanted.has(key)) out.set(key, hdr);
        }
        // Всё нашли — дальше не листаем. Брошенный список в 115 отменить
        // нечем (`abortList` — с TB 120), он отмирает сам.
        if (out.size === wanted.size || !page.id || this.#stopped) break;
        page = await this.browser.messages.continueList(page.id);
      }
    } catch (e) {
      // Папку удалили или переименовали — письма поищем в других местах.
      console.warn("r7-triage: папка недоступна для обогащения", fkey, e);
    }
    return out;
  }

  // --- одно письмо -------------------------------------------------------

  async #one(row, hdr, state) {
    const size = hdr.size ?? row.sizeBytes ?? 0;
    if (this.cfg.maxSizeBytes && size > this.cfg.maxSizeBytes) {
      // Заголовков отдельно от тела в 115 не получить, а тянуть с сервера
      // десятки мегабайт ради них — не та цена. Состав вложений неизвестен.
      return this.#finish(row.id, ENRICH.SKIPPED,
        { enrichError: "size", hasAttachments: null }, state);
    }

    let full;
    try {
      const t0 = Date.now();
      full = await this.browser.messages.getFull(hdr.id);
      state.stats.fullReads++;
      // С диска письмо читается за миллисекунды; секунда и дольше — почти
      // наверняка скачивание с сервера.
      if (this.cfg.slowReadMs && Date.now() - t0 >= this.cfg.slowReadMs) state.stats.slowReads++;
    } catch (e) {
      await this.#finish(row.id, ENRICH.FAILED,
        { enrichError: String(e?.message ?? e).slice(0, 300) }, state);
      return "error";
    }

    const parts = readParts(full);
    for (const c of parts.calendars) {
      if (c.body != null || !c.partName) continue;
      if (c.size > this.cfg.maxCalendarBytes) continue;
      // Приглашение, приложенное файлом invite.ics, тела в getFull не имеет.
      try {
        const file = await this.browser.messages.getAttachmentFile(hdr.id, c.partName);
        c.body = await file.text();
        state.stats.calendarReads++;
      } catch (e) {
        console.warn("r7-triage: приглашение не прочитано", row.id, e);
      }
    }

    const facts = buildFacts(full, parts, row.id, {
      hosts: this.hosts, maxScanChars: this.cfg.maxScanChars });
    state.stats.meetings += facts.calendar.filter((c) => c.kind === "meeting").length;
    state.stats.tasks += facts.calendar.filter((c) => c.kind === "task").length;
    state.stats.conferences += facts.conferences.length;

    await this.#finish(row.id, ENRICH.DONE, facts, state);
    if (this.cfg.throttleMs) await sleep(this.cfg.throttleMs);
    return "ok";
  }

  /** Итог по письму — одной транзакцией поверх свежей записи. */
  async #finish(key, enriched, fields, state) {
    const failed = enriched === ENRICH.FAILED;
    await this.db.patch("messages", key, (row) => {
      const next = { ...row, ...fields, enriched, enrichedAt: Date.now() };
      if (failed) next.enrichAttempts = (row.enrichAttempts ?? 0) + 1;
      if (enriched === ENRICH.DONE) delete next.enrichError;
      return next;
    });

    if (enriched === ENRICH.DONE) state.stats.enriched++;
    else if (enriched === ENRICH.SKIPPED) state.stats.skipped++;
    else if (fields.enrichError === "not-found") state.stats.notFound++;
    else state.stats.failed++;
    return fields.enrichError === "not-found" ? "not-found" : failed ? "error" : "ok";
  }

  /** Вернуть письмо в очередь, не засчитав попытку. */
  async #putBack(key, state) {
    await this.db.patch("messages", key, (row) => ({
      ...row,
      enriched: ENRICH.PENDING,
      enrichAttempts: Math.max(0, (row.enrichAttempts ?? 1) - 1),
    }));
    state.stats.failed--;
  }

  /**
   * Неудачи не вечны: письмо могли перенести (проход по ящику допишет новое
   * место), сервер мог лежать. Повторяем не чаще раза в `retryAfterDays` и не
   * больше `maxAttempts` раз.
   */
  async #requeueFailed() {
    const failed = await this.db.enrichQueue({ state: ENRICH.FAILED, limit: Infinity });
    const before = Date.now() - this.cfg.retryAfterDays * DAY;
    let n = 0;
    for (const row of failed) {
      if ((row.enrichAttempts ?? 0) >= this.cfg.maxAttempts) continue;
      if ((row.enrichedAt ?? 0) > before) continue;
      await this.db.patch("messages", row.id, (r) => ({ ...r, enriched: ENRICH.PENDING }));
      n++;
    }
    return n;
  }

  // --- служебное ---------------------------------------------------------

  async #save(state) {
    state.savedAt = Date.now();
    await this.db.meta.set(STATE_KEY, state);
  }

  #emit() {
    const s = this.#state;
    if (!s) return;
    const elapsedMs = Date.now() - this.#startedAt;
    this.#progress = {
      running: this.#running,
      stopping: this.#stopped,
      done: Boolean(s.done),
      since: s.since,
      cursorDate: s.cursorDate,
      stats: { ...s.stats },
      error: s.error,
      elapsedMs,
      rate: elapsedMs > 0 ? Math.round(this.#processed / (elapsedMs / 1000)) : 0,
    };
    try { this.onProgress(this.#progress); } catch { /* панель закрыта */ }
  }
}
