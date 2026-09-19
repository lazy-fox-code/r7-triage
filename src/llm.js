// Клиент локальной модели. OpenAI-совместимый /v1/chat/completions.
//
// Два требования, нарушение которых ломает проект:
//   1. Формат ответа фиксируется схемой (guided_json в vLLM, GBNF
//      в llama.cpp). Парсить свободный текст от модели 7-14B нельзя.
//   2. Модель не рассуждающая. R1-дистилляты выдают длинный блок
//      рассуждений перед ответом, на тысячах писем это неприемлемо.

import { VERDICT_SCHEMA, buildPrompt } from "./prompts/classify.js";

export class LlmClient {
  constructor({ endpoint, model, concurrency = 3, timeoutMs = 60000 }) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.sem = new Semaphore(concurrency);
  }

  async classify({ subject, from, senderLevel, body, features }) {
    return this.sem.run(async () => {
      const res = await this.#post({
        model: this.model,
        temperature: 0,
        max_tokens: 400,
        messages: buildPrompt({ subject, from, senderLevel, body, features }),
        // vLLM. Для llama.cpp заменить на { grammar: GBNF }.
        guided_json: VERDICT_SCHEMA,
      });
      const text = res.choices?.[0]?.message?.content ?? "";
      return JSON.parse(text);
    });
  }

  async #post(payload) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

class Semaphore {
  constructor(n) { this.n = n; this.queue = []; }
  async run(fn) {
    if (this.n <= 0) await new Promise((r) => this.queue.push(r));
    this.n--;
    try { return await fn(); }
    finally { this.n++; this.queue.shift()?.(); }
  }
}
