// Клиент локальной модели. OpenAI-совместимый /v1/chat/completions.
//
// Два требования, нарушение которых ломает проект:
//   1. Формат ответа фиксируется схемой — `response_format: json_schema`,
//      как у OpenAI: так её понимают и vLLM, и SGLang, и сервер llama.cpp.
//      Парсить свободный текст от модели 7-14B нельзя.
//   2. Модель не рассуждающая. R1-дистилляты выдают длинный блок
//      рассуждений перед ответом, на тысячах писем это неприемлемо.

import { VERDICT_SCHEMA, buildPrompt } from "./prompts/classify.js";

export class LlmClient {
  constructor({ endpoint, model, apiKey = "", concurrency = 3, timeoutMs = 60000,
    fetch = (...a) => globalThis.fetch(...a) }) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetch;
    this.sem = new Semaphore(concurrency);
  }

  async classify(letter) {
    const { verdict, error } = await this.classifyDetailed(letter);
    if (error) throw error;
    return verdict;
  }

  /**
   * То же с подробностями для проверки модели: сырой ответ, время, признак
   * рассуждающей модели. Ошибка разбора не бросается, а возвращается.
   */
  async classifyDetailed({ subject, from, senderLevel, body, features }) {
    return this.sem.run(async () => {
      const t0 = Date.now();
      const res = await this.#post({
        model: this.model,
        temperature: 0,
        max_tokens: 400,
        messages: buildPrompt({ subject, from, senderLevel, body, features }),
        // Схема ответа по стандарту OpenAI: её понимают vLLM, SGLang и
        // сервер llama.cpp. Прежний `guided_json` — расширение vLLM, и на
        // свежих сборках он молча игнорируется: запрос проходит, ответ
        // приходит в произвольном виде. Проверка модели 22.09.2026 поймала
        // это ровно так — JSON 6 из 6, по схеме 0 из 6.
        response_format: {
          type: "json_schema",
          json_schema: { name: "verdict", schema: VERDICT_SCHEMA },
        },
      });
      const message = res.choices?.[0]?.message ?? {};
      const content = message.content ?? "";
      // Рассуждающие модели выдают блок рассуждений перед ответом — в тексте
      // или отдельным полем. На батче это недопустимо, поэтому отмечаем.
      const reasoning = /<think>/i.test(content) || Boolean(message.reasoning_content);
      let verdict = null;
      let error = null;
      try { verdict = JSON.parse(content); } catch (e) { error = e; }
      return { verdict, error, content, reasoning, ms: Date.now() - t0 };
    });
  }

  async #post(payload) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await this.fetch(`${this.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`);
      return r.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Ограничение одновременных запросов. Освободившийся слот передаётся
 * ждущему напрямую, без возврата в счётчик. Прежний вариант возвращал слот в
 * счётчик и будил ждущего: пока тот просыпался, слот успевал занять
 * пришедший следом, и запросов шло больше, чем задано.
 */
export class Semaphore {
  constructor(n) { this.free = n; this.queue = []; }
  async run(fn) {
    if (this.free > 0) this.free--;
    else await new Promise((r) => this.queue.push(r));
    try { return await fn(); }
    finally {
      const next = this.queue.shift();
      if (next) next(); else this.free++;
    }
  }
}
