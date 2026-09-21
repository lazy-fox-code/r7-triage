// Промпт классификации. Версионируется: при изменении поднять PROMPT_VERSION
// и записать его в вердикт, иначе метрики качества станут несопоставимыми.

export const PROMPT_VERSION = 1;

export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "confidence", "reason"],
  properties: {
    label: { type: "string", enum: ["task", "info", "noise"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    // Цитата из письма, на которой основано решение. Обязательна:
    // пользователь должен иметь возможность спросить "почему".
    reason: { type: "string", maxLength: 300 },
    task: {
      type: "object",
      additionalProperties: false,
      properties: {
        what: { type: "string", maxLength: 300 },
        dueDate: { type: "string" },
        // Кому адресовано, как названо в письме.
        assignee: { type: "string" },
      },
    },
    // Срок жизни информирования в днях. Только для label = info.
    staleDays: { type: "integer", minimum: 1, maximum: 3650 },
  },
};

const SYSTEM = `Ты классифицируешь деловую переписку. Отвечай только JSON.

Классы:
- task — от получателя ждут действия: есть просьба, распоряжение, вопрос,
  требующий ответа по существу, или срок.
- info — сообщают сведения, действие не требуется.
- noise — автоматика, реклама, уведомления систем.

Правила:
- Уровень отправителя влияет на срочность, но НЕ на класс. Просьба от
  рядового коллеги — это task.
- Вежливая формулировка не отменяет поручение.
- Пересылка «для сведения» без просьбы — info.
- В reason приведи короткую цитату из письма, на которой основано решение.
- Для info оцени staleDays: через сколько дней сведения потеряют ценность.`;

export function buildPrompt({ subject, from, senderLevel, body, features }) {
  const ctx = [
    `Отправитель: ${from}`,
    senderLevel ? `Уровень отправителя: ${senderLevel}` : null,
    `Адресация: ${features.inTo ? "в поле Кому" : "в копии"}, ` +
      `всего получателей ${features.recipientCount}`,
    // null — заголовки ветки не прочитаны; гадать за модель не будем.
    features.isThreadStart == null ? null
      : features.isThreadStart ? "Начало переписки" : "Ответ в переписке",
    `Тема: ${subject}`,
  ].filter(Boolean).join("\n");

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${ctx}\n\nТекст письма:\n${body}` },
  ];
}
