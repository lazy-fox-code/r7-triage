// Проверка подключённой модели (T3) без реальной почты.
//
// Шесть выдуманных писем с известным ответом — по два на класс. Этого мало
// для оценки качества (для неё нужна размеченная выборка на 300 писем), но
// достаточно, чтобы в первый же день увидеть главное: модель отвечает, ответ
// разбирается как JSON по схеме, это не рассуждающая модель, русский она
// понимает на очевидных примерах, и сколько стоит одно письмо.

import { LlmClient } from "./llm.js";

// Вежливая просьба и поручение от рядового коллеги — намеренно: класс не
// зависит ни от тона, ни от уровня отправителя.
export const SAMPLES = [
  {
    expect: "task",
    subject: "Справка по договору № 15",
    from: "Петрова Анна <petrova@example.ru>",
    body: "Коллеги, прошу до пятницы, 26 сентября, подготовить справку о ходе " +
      "исполнения договора № 15 и направить мне. Спасибо.",
    features: { inTo: true, recipientCount: 1, isThreadStart: true },
  },
  {
    expect: "task",
    subject: "Смета на ремонт",
    from: "Сидоров Олег <sidorov@example.ru>",
    body: "Добрый день! Не могли бы вы посмотреть смету во вложении и прислать " +
      "замечания до среды? Без них не можем согласовать бюджет.",
    features: { inTo: true, recipientCount: 2, isThreadStart: true },
  },
  {
    expect: "info",
    subject: "Для сведения: новый порядок пропуска",
    from: "Служба безопасности <security@example.ru>",
    body: "Информируем, что с 1 октября вход в здание — только по электронным " +
      "пропускам. Действий от вас не требуется, пропуска уже перевыпущены.",
    features: { inTo: false, recipientCount: 40, isThreadStart: true },
  },
  {
    expect: "info",
    subject: "Протокол совещания 18.09",
    from: "Кузнецов Игорь <kuznecov@example.ru>",
    body: "Направляю протокол совещания. Решений по вашему направлению нет, " +
      "протокол — для сведения.",
    features: { inTo: true, recipientCount: 12, isThreadStart: false },
  },
  {
    expect: "noise",
    subject: "Срок действия пароля истекает",
    from: "Система учёта <no-reply@example.ru>",
    body: "Это автоматическое уведомление. Срок действия вашего пароля истекает " +
      "через 5 дней. Не отвечайте на это письмо.",
    features: { inTo: true, recipientCount: 1, isThreadStart: true },
  },
  {
    expect: "noise",
    subject: "Дайджест портала за неделю",
    from: "Корпоративный портал <portal@example.ru>",
    body: "Самое интересное за неделю: 12 новых статей, 3 опроса и конкурс " +
      "фотографий. Отписаться от рассылки можно в профиле.",
    features: { inTo: false, recipientCount: 300, isThreadStart: true },
  },
];

const LABELS = ["task", "info", "noise"];

function schemaOk(v) {
  return v && LABELS.includes(v.label)
    && typeof v.confidence === "number" && v.confidence >= 0 && v.confidence <= 1
    && typeof v.reason === "string" && v.reason.trim().length > 0;
}

/**
 * @param {object} deps.llm     ветка `llm` из настроек
 * @param {Function} deps.fetch для тестов
 * @returns сводка без текстов писем и ответов — только числа и метки
 */
export async function checkModel({ llm, fetch, samples = SAMPLES }) {
  const at = Date.now();
  if (!llm.endpoint || !llm.model) {
    return { at, configured: false, error: "не задан эндпоинт или имя модели" };
  }

  const client = new LlmClient(fetch ? { ...llm, fetch } : llm);

  const t0 = Date.now();
  const results = await Promise.all(samples.map(async (s) => {
    try {
      const r = await client.classifyDetailed(s);
      return {
        expect: s.expect,
        label: r.verdict?.label ?? null,
        json: !r.error,
        schema: schemaOk(r.verdict),
        // Имена полей ответа — чтобы по отчёту было видно, отвечает ли
        // модель по нашей схеме или по своей. Выдуманные письма, значений
        // в отчёте нет, только названия.
        keys: r.verdict && typeof r.verdict === "object" ? Object.keys(r.verdict).slice(0, 12) : [],
        reasoning: r.reasoning,
        ms: r.ms,
      };
    } catch (e) {
      return { expect: s.expect, error: String(e?.message ?? e).slice(0, 200) };
    }
  }));
  const wallMs = Date.now() - t0;

  const answered = results.filter((r) => !r.error);
  const times = answered.map((r) => r.ms).sort((a, b) => a - b);
  return {
    at,
    configured: true,
    model: llm.model,
    concurrency: llm.concurrency,
    total: results.length,
    answered: answered.length,
    validJson: answered.filter((r) => r.json).length,
    schemaOk: answered.filter((r) => r.schema).length,
    correct: answered.filter((r) => r.label === r.expect).length,
    reasoningDetected: answered.some((r) => r.reasoning),
    answerFields: [...new Set(answered.flatMap((r) => r.keys ?? []))].sort(),
    latencyMs: times.length ? {
      min: times[0],
      median: times[Math.floor(times.length / 2)],
      max: times[times.length - 1],
    } : null,
    // Писем в минуту при заданной конкурентности — оценка на шести письмах.
    perMinute: wallMs > 0 ? Math.round((answered.length / wallMs) * 60000) : null,
    confusion: results.map((r) => ({ expect: r.expect, got: r.label ?? (r.error ? "ошибка" : null) })),
    errors: [...new Set(results.filter((r) => r.error).map((r) => r.error))],
  };
}
