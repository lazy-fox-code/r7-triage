// Дешёвые признаки и гейт. Задача — снять 60-80 % писем до инференса (T2).
//
// Признаки выводятся при чтении из записи письма и нигде не сохраняются.
// Запись несёт факты: списки адресатов (проход по ящику) и значения
// заголовков, ветку, вложения, календарь (проход обогащения, enrich.js).
// Выводы из них — здесь. Так уточнение правил или набора своих адресов
// (алиасы, делегированные ящики, списки рассылки) не требует повторного
// прохода по ящику, а на новом правиле сразу пересчитывается замер гейта.

import { normalizeAddress } from "./keys.js";
import { ENRICH } from "./db.js";

export { normalizeAddress as normalize };

/**
 * @param {object} row запись из хранилища `messages`
 * @param {Set<string>} me нормализованные адреса пользователя
 */
export function derive(row, me) {
  const to = row.to ?? [];
  const inTo = to.some((a) => me.has(a));
  const inCc = (row.cc ?? []).some((a) => me.has(a));
  const enriched = row.enriched ?? ENRICH.PENDING;
  const cal = row.calendar?.[0] ?? null;

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
    flagged: Boolean(row.flagged),
    junk: Boolean(row.junk),
    junkScore: row.junkScore ?? null,

    // Из полных заголовков. До обогащения их нет, и это не «нет», а
    // «не знаем»: гейт такие письма в модель не пускает.
    enriched,
    bulk: row.bulk ?? null,
    threadId: row.threadId ?? null,
    isThreadStart: enriched === ENRICH.DONE ? !row.thread?.parent : null,
    hasAttachments: row.hasAttachments ?? null,
    calendarMethod: cal?.method ?? null,
    calendarKind: cal?.kind ?? null,
  };
}

const decided = (outcome, confidence, reason, features, quote) =>
  ({ outcome, label: outcome, confidence, reason, features, quote });

/**
 * Гейт: нужна ли письму модель.
 *
 * outcome:
 *   noise | info  — решено без модели; label, confidence, признаки и цитата
 *                   (заголовок письма) — правило 4: у вердикта есть «почему»;
 *   model         — кандидат, идёт в очередь инференса;
 *   pending       — полные заголовки ещё не прочитаны, решать рано;
 *   own           — моё письмо: не классифицируется, но нужно графу.
 *
 * Уровень отправителя здесь не участвует и участвовать не должен: он влияет
 * на приоритет и срок, не на класс.
 *
 * @param {object} f  признаки из derive
 * @param {object} cfg ветка `gate` из настроек
 */
export function gate(f, cfg) {
  if (f.fromMe) return { outcome: "own", reason: "моё письмо" };

  if (f.junk) {
    return decided("noise", 0.95, "помечено клиентом как спам", ["junk"],
      `junkScore: ${f.junkScore ?? "?"}`);
  }

  const b = f.bulk;
  if (b?.autoSubmitted && b.autoSubmitted !== "no") {
    return decided("noise", 0.99, "автоматическое письмо", ["auto-submitted"],
      `Auto-Submitted: ${b.autoSubmitted}`);
  }
  if (b?.listId) {
    return decided("noise", 0.97, "рассылка", ["list-id"], `List-Id: ${b.listId}`);
  }
  if (b?.listUnsubscribe) {
    return decided("noise", 0.97, "рассылка", ["list-unsubscribe"],
      "List-Unsubscribe: присутствует");
  }
  if (b?.precedence && /^(bulk|list|junk)$/.test(b.precedence)) {
    return decided("noise", 0.95, "массовая отправка", ["precedence"],
      `Precedence: ${b.precedence}`);
  }
  if (b?.autoResponseSuppress) {
    return decided("noise", 0.9, "служебная отправка", ["x-auto-response-suppress"],
      `X-Auto-Response-Suppress: ${b.autoResponseSuppress}`);
  }

  // Ответ участника на приглашение пишет клиент, а не человек.
  if (f.calendarMethod === "REPLY") {
    return decided("noise", 0.95, "ответ на приглашение", ["calendar-reply"],
      "METHOD:REPLY");
  }
  if (f.calendarMethod === "CANCEL") {
    return decided("info", 0.95, "отмена встречи", ["calendar-cancel"], "METHOD:CANCEL");
  }

  if (f.inCc && !f.inTo && f.recipientCount > cfg.massCcRecipients) {
    return decided("info", 0.8, "копия массовой рассылки", ["cc-only", "recipient-count"],
      `Копия, получателей: ${f.recipientCount}`);
  }

  if (f.enriched === ENRICH.PENDING) {
    return { outcome: "pending", reason: "полные заголовки ещё не прочитаны" };
  }
  return { outcome: "model", reason: null };
}
