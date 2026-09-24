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
import { actionHint, statusOf, meetingKind } from "./senders.js";

export { normalizeAddress as normalize };

/**
 * @param {object} row запись из хранилища `messages`
 * @param {Set<string>} me нормализованные адреса пользователя
 * @param {Map|object|null} index разбор ящика из `senders.js`: карта
 *   профилей отправителей либо `{ senders, threads }`, где threads — когда
 *   вы последний раз писали в каждой ветке. Ничего не передали — правила по
 *   отправителю и по ответу не работают, остальные работают как прежде.
 */
export function derive(row, me, index = null) {
  const senders = index instanceof Map ? index : index?.senders ?? null;
  const threads = index instanceof Map ? null : index?.threads ?? null;
  const teamThreads = index instanceof Map ? null : index?.teamThreads ?? null;
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

    // Кто пишет: профиль отправителя из его же писем. Считается отдельным
    // проходом и живёт в `people`; здесь только читается.
    sender: senders?.get(row.fromId) ?? null,

    // Когда я последний раз писал в этой ветке. Письмо старше — на него уже
    // ответили.
    myReplyAt: threads
      ? Math.max(threads.get(row.threadId) ?? 0, threads.get(row.thread?.root) ?? 0,
        threads.get(row.id) ?? 0) || null
      : null,

    // Когда в этой ветке за меня ответил сотрудник. Обращались ко мне, я
    // промолчал, вопрос закрыл коллега — для меня это уже информирование.
    teamReplyAt: teamThreads
      ? Math.max(teamThreads.get(row.threadId) ?? 0, teamThreads.get(row.thread?.root) ?? 0,
        teamThreads.get(row.id) ?? 0) || null
      : null,

    // Обработка встречи приходит обычным письмом: приставка в теме — всё,
    // что от неё остаётся после шлюза Exchange.
    meeting: meetingKind(row.subject),
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
/**
 * Чем письмо оказалось в очереди к модели — подпись из дешёвых признаков.
 * Замер складывает такие подписи в гистограмму: по ней видно, где лежит
 * масса писем, которые отсев не снял, и какое правило писать следующим.
 */
export function modelSignature(f) {
  const addressing = f.inTo
    ? (f.isNamedRecipient ? "лично в «Кому»" : "в «Кому» среди многих")
    : f.inCc ? "в копии" : "не в адресатах";
  const sender = f.sender
    ? (f.sender.kind === "person"
      ? (f.sender.iWrote || f.sender.dialogThreads > 0 ? "переписка есть" : "переписки нет")
      : f.sender.kind)
    : "отправитель не разобран";
  const thread = f.isThreadStart == null ? "ветка неизвестна"
    : f.isThreadStart ? "начало ветки" : "ответ в ветке";
  const mine = f.myReplyAt ? " · вы писали в ветке раньше"
    : f.teamReplyAt ? " · в ветке отвечал сотрудник" : "";
  return `${addressing} · ${sender} · ${thread}${mine}`;
}

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
  // То же, но без text/calendar: через шлюз Exchange от встречи остаётся
  // только приставка в теме.
  if (f.meeting === "response") {
    return decided("noise", 0.9, "ответ на приглашение", ["meeting-subject"],
      `Тема: ${f.subject}`);
  }
  if (f.meeting === "cancel" || f.meeting === "update") {
    return decided("info", 0.85, f.meeting === "cancel" ? "отмена встречи" : "перенос встречи",
      ["meeting-subject"], `Тема: ${f.subject}`);
  }

  // На это письмо вы уже ответили: в той же переписке есть ваше письмо
  // позже. Что бы в нём ни просили, действие уже сделано — модели там
  // делать нечего. Признак дешёвый и честный: он из ваших же писем.
  if (f.myReplyAt && f.date < f.myReplyAt) {
    return decided("info", 0.85, "вы уже ответили в этой переписке", ["answered"],
      `Ваш ответ в ветке: ${new Date(f.myReplyAt).toLocaleDateString("ru-RU")}`);
  }
  // За вас ответил сотрудник: обращались к вам, вы промолчали, вопрос закрыл
  // коллега. Кто ваши сотрудники, видно по почте — в ветках, обращённых к
  // вам, отвечают они (`senders.js`, team).
  if (cfg.teamAnswerIsInfo !== false && f.teamReplyAt && f.date < f.teamReplyAt) {
    return decided("info", 0.75, "за вас ответил сотрудник", ["team-answered"],
      `Ответ коллеги в ветке: ${new Date(f.teamReplyAt).toLocaleDateString("ru-RU")}`);
  }

  // Тема служебного письма, в котором нет содержания.
  const noise = statusOf(f.subject, cfg.noiseSubjects);
  if (noise) {
    return decided("noise", 0.9, "служебное письмо", ["subject-service"],
      `Тема: ${f.subject}`);
  }

  if (f.inCc && !f.inTo && f.recipientCount > cfg.massCcRecipients) {
    return decided("info", 0.8, "копия массовой рассылки", ["cc-only", "recipient-count"],
      `Копия, получателей: ${f.recipientCount}`);
  }

  // Отправитель. В закрытом периметре заголовков рассылки у писем нет
  // (замер 22.09.2026), и единственный дешёвый признак — поведение
  // отправителя: кто пишет, отвечает ли, повторяются ли темы. Профиль
  // считается по самим письмам, см. `senders.js`.
  //
  // Признак действия в теме возвращает письмо модели: «вам назначен
  // инцидент» — поручение, кем бы оно ни было отправлено. Отправитель
  // решает, нужна ли модель, но не решает класс письма.
  const s = f.sender;
  if (s && (s.kind === "system" || s.kind === "broadcast")) {
    // Признак действия в теме возвращает письмо модели — но только если
    // система обратилась лично к вам. «Назначен» в рассылке на весь отдел
    // означает, что назначили кого-то другого.
    const hint = f.isNamedRecipient ? actionHint(f.subject, cfg.actionWords) : null;
    if (hint) {
      return { outcome: "model", reason: `от вас могут ждать действия: «${hint}» в теме` };
    }
    const noun = s.kind === "system" ? "уведомление информационной системы" : "вещание на многих";
    return decided("info", s.kind === "system" ? 0.85 : 0.8, noun,
      ["sender-kind", ...(s.features ?? [])],
      `Тема: ${f.subject || "(без темы)"} · отправитель: ${s.why}`);
  }

  // Адресация. Обращение — это «Кому»: в копии сообщают, а не просят. Копия
  // на весь отдел разобрана выше, здесь — любая копия.
  if (cfg.ccOnlyIsInfo && f.inCc && !f.inTo) {
    return decided("info", 0.7, "я в копии, а не в адресатах", ["cc-only"],
      `Копия, получателей: ${f.recipientCount}`);
  }
  // Меня нет ни в «Кому», ни в копии: письмо пришло на список рассылки или
  // в общий ящик. Если переписка с отправителем есть — решает модель: это
  // может быть обращение, просто через список.
  if (cfg.unaddressedIsInfo && !f.inTo && !f.inCc && !(s?.iWrote || s?.dialogThreads > 0)) {
    return decided("info", 0.65, "я не в адресатах письма", ["not-addressed"],
      `Получателей: ${f.recipientCount}, ваших адресов среди них нет`);
  }

  if (f.enriched === ENRICH.PENDING) {
    return { outcome: "pending", reason: "полные заголовки ещё не прочитаны" };
  }
  return { outcome: "model", reason: null };
}
