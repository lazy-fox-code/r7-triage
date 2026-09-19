// Дешёвые признаки из заголовков. Считаются без обращения к телу письма
// и без вызова модели. Задача — снять 60-80 % писем до инференса.

const BULK_HEADERS = [
  "list-unsubscribe",
  "list-id",
  "precedence",
  "auto-submitted",
  "x-auto-response-suppress",
];

/**
 * @param {object} hdr   результат browser.messages.get / query
 * @param {object} full  результат browser.messages.getFull
 * @param {string} meId  нормализованный адрес пользователя
 */
export function extract(hdr, full, meId) {
  const headers = full?.headers ?? {};
  const has = (name) => Boolean(headers[name]?.length);

  const to = (hdr.recipients ?? []).map(normalize);
  const cc = (hdr.ccList ?? []).map(normalize);

  const inTo = to.includes(meId);
  const inCc = cc.includes(meId);

  return {
    fromId: normalize(hdr.author),
    date: hdr.date instanceof Date ? hdr.date.getTime() : Date.parse(hdr.date),
    sizeBytes: hdr.size ?? 0,
    subject: hdr.subject ?? "",

    // Автоматика. Самый дешёвый и самый надёжный отсев.
    isBulk: BULK_HEADERS.some(has),
    isAutoReply: /^(auto|automatic)/i.test(headers["auto-submitted"]?.[0] ?? ""),

    // Адресация. To против CC — сильнейший дешёвый признак поручения.
    inTo,
    inCc,
    recipientCount: to.length + cc.length,
    isNamedRecipient: inTo && to.length <= 3,

    // Тред.
    threadId: headers["references"]?.[0]?.split(/\s+/)[0]
      ?? headers["in-reply-to"]?.[0]
      ?? headers["message-id"]?.[0]
      ?? String(hdr.id),
    isThreadStart: !has("in-reply-to"),

    hasAttachments: Boolean(hdr.attachments?.length),
  };
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

export function normalize(addr) {
  if (!addr) return "";
  const m = /<([^>]+)>/.exec(addr);
  return (m ? m[1] : addr).trim().toLowerCase();
}
