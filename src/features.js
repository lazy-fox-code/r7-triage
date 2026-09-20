// Дешёвые признаки. Задача — снять 60-80 % писем до инференса (T2).
//
// Признаки разделены по цене получения, и это разделение принципиально:
//
//   derive(row, me)  — из того, что уже лежит в IndexedDB после прохода T1.
//                      Бесплатно, ничего не читает.
//   enrich(full)     — из полных заголовков. Требует `messages.getFull`,
//                      а он читает письмо целиком и, если тела нет в
//                      офлайн-хранилище, тянет его с сервера.
//
// Поэтому List-Unsubscribe, Precedence и цепочка References не заполняются
// проходом по ящику: MessageHeader их не отдаёт, а платить за них полным
// чтением каждого из десятков тысяч писем нельзя.

import { normalizeAddress } from "./keys.js";

export { normalizeAddress as normalize };

const BULK_HEADERS = [
  "list-unsubscribe",
  "list-id",
  "precedence",
  "auto-submitted",
  "x-auto-response-suppress",
];

/**
 * Признаки из записи, сделанной проходом T1. Набор своих адресов передаётся
 * снаружи и не сохраняется в записи: алиасы, делегированные ящики и списки
 * рассылки уточняются со временем, и уточнение не должно требовать
 * повторного прохода по ящику.
 *
 * @param {object} row запись из хранилища `messages`
 * @param {Set<string>} me нормализованные адреса пользователя
 */
export function derive(row, me) {
  const inTo = (row.to ?? []).some((a) => me.has(a));
  const inCc = (row.cc ?? []).some((a) => me.has(a));
  const to = row.to ?? [];

  return {
    fromId: row.fromId,
    date: row.date,
    sizeBytes: row.sizeBytes,
    subject: row.subject,

    // Адресация. To против CC — сильнейший дешёвый признак поручения.
    inTo,
    inCc,
    recipientCount: row.recipientCount ?? to.length + (row.cc?.length ?? 0),
    isNamedRecipient: inTo && to.length <= 3,

    fromMe: me.has(row.fromId),
    flagged: row.flagged,
  };
}

/**
 * Признаки из полных заголовков. Вызывается только после `messages.getFull`.
 *
 * @param {object} full MessagePart
 */
export function enrich(full) {
  const headers = full?.headers ?? {};
  const has = (name) => Boolean(headers[name]?.length);
  const first = (name) => headers[name]?.[0] ?? "";

  return {
    // Автоматика. Самый дешёвый и самый надёжный отсев.
    isBulk: BULK_HEADERS.some(has),
    isAutoReply: /^(auto|automatic)/i.test(first("auto-submitted")),

    // Тред. References упорядочен от корня к последнему ответу, поэтому
    // корень ветки — первый идентификатор в списке.
    threadId: threadRoot(headers),
    isThreadStart: !has("in-reply-to") && !has("references"),

    // Вложения. В MessageHeader их нет вовсе — раньше здесь читалось
    // несуществующее поле `hdr.attachments`, и признак всегда был ложным.
    // Это исключение из-под правила об устаревшем информировании (T6),
    // так что ошибка тут дороже обычной.
    hasAttachments: hasAttachments(full),
  };
}

function threadRoot(headers) {
  const refs = (headers.references?.[0] ?? "").trim();
  const raw = refs ? refs.split(/\s+/)[0]
    : headers["in-reply-to"]?.[0] ?? headers["message-id"]?.[0] ?? "";
  const m = /<([^>]*)>/.exec(raw ?? "");
  const id = (m ? m[1] : raw ?? "").trim().toLowerCase();
  return id ? `m:${id}` : null;
}

function hasAttachments(part) {
  if (!part) return false;
  const disposition = String(part.contentDisposition ?? "");
  if (disposition.startsWith("attachment")) return true;
  if (part.name && !String(part.contentType ?? "").startsWith("text/")) return true;
  return (part.parts ?? []).some(hasAttachments);
}

/**
 * Гейт: нужна ли модель. Возвращает готовый вердикт (модель не нужна)
 * либо null (письмо идёт в очередь инференса).
 */
export function gate(f) {
  if (f.isBulk || f.isAutoReply) {
    return { label: "noise", confidence: 0.99, reason: "служебные заголовки" };
  }
  if (f.inCc && !f.inTo && f.recipientCount > 8) {
    return { label: "info", confidence: 0.8, reason: "копия массовой рассылки" };
  }
  return null;
}
