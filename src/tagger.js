// Метки на письмах: вердикты расширения, видные в самом клиенте.
//
// Зачем метки, если есть вкладка «Дела»
// -------------------------------------
// Метка — машинный интерфейс решения (`docs/lifecycle.md`). Её видят и
// пользователь в списке писем, и его собственные фильтры Thunderbird, и
// наши последующие проходы. Вкладка показывает дела, метка отвечает на
// вопрос «что это за письмо» там, где человек и так читает почту.
//
// Что ставим сегодня
// ------------------
//   r7t-info      отсев решил «информирование» — действий не требуется;
//   r7t-noise     отсев решил «шум» — автоматика, ответы на приглашения;
//   r7t-awaiting  последнее письмо дела, где ждут вашего ответа;
//   r7t-archived  письмо перенесено в архив расширением (ставит background).
//
// `r7t-task` и состояния поручения появятся вместе с моделью: врать метками
// нельзя, а без классификации «поручение» мы не знаем.
//
// Как проход устроен
// ------------------
// Номер письма в клиенте живёт одну сессию, поэтому метку нельзя поставить
// по ключу из базы. Проход идёт по папкам: на папку — один запрос (в 115 он
// всё равно перебирает её целиком), из него строится соответствие
// «устойчивый ключ → номер сессии», и метки ставятся только там, где они
// отличаются от уже стоящих. Позиция — список разобранных папок в
// чекпойнте, поэтому проход переживает закрытие клиента.
//
// Обратимость: «снять все метки» убирает только свои ключи `r7t-*`, чужие
// метки не трогает.

import { derive, gate } from "./features.js";
import { messageKey, parseFolderKey, folderKey } from "./keys.js";

export const TAGS = {
  task: { key: "r7t-task", tag: "Поручение", color: "#C4314B" },
  info: { key: "r7t-info", tag: "Информирование", color: "#6E7B8B" },
  noise: { key: "r7t-noise", tag: "Шум", color: "#8A9096" },
  awaiting: { key: "r7t-awaiting", tag: "Жду ответа", color: "#6B4FBB" },
  archived: { key: "r7t-archived", tag: "В архиве", color: "#157F3F" },
};

export const OUR_KEYS = new Set(Object.values(TAGS).map((t) => t.key));

/** Метки заводятся один раз: в 115 это `messages.createTag`. */
export async function ensureTags(browser) {
  const existing = await browser.messages.listTags();
  for (const t of Object.values(TAGS)) {
    if (!existing.some((e) => e.key === t.key)) {
      await browser.messages.createTag(t.key, t.tag, t.color);
    }
  }
}

/**
 * Какие метки положены письму. Возвращает только наши ключи — чужие метки
 * письма к этому решению отношения не имеют.
 *
 * @param {object} row     запись письма
 * @param {object} verdict решение отсева (`features.gate`)
 * @param {Set<string>} awaiting ключи писем, которых ждёт ответа
 * @param {object} cfg     ветка `tags` настроек
 */
export function tagsFor(row, verdict, awaiting, cfg) {
  const out = [];
  if (cfg.info !== false && verdict?.outcome === "info") out.push(TAGS.info.key);
  if (cfg.noise !== false && verdict?.outcome === "noise") out.push(TAGS.noise.key);
  if (cfg.awaiting !== false && awaiting.has(row.id)) out.push(TAGS.awaiting.key);
  if (row.movedAt) out.push(TAGS.archived.key);
  return out;
}

const STATE_KEY = "tagger";
const STATE_VERSION = 1;

export class Tagger {
  #running = false;
  #stopped = false;
  #state = null;

  /**
   * @param {object} deps.browser WebExtension API
   * @param {object} deps.db      модуль хранилища
   * @param {object} deps.cfg     ветка `tags` настроек
   * @param {Function} deps.onProgress
   */
  constructor({ browser, db, cfg, onProgress = () => {} }) {
    this.browser = browser;
    this.db = db;
    this.cfg = cfg;
    this.onProgress = onProgress;
  }

  stop() { this.#stopped = true; }

  status() {
    return { running: this.#running, ...(this.#state ?? {}) };
  }

  /**
   * Проход по папкам: расставить метки.
   *
   * @param {object} opts me — свои адреса, gateCfg — ветка `gate`,
   *   index — профили отправителей и ветки (`senders.js`),
   *   awaiting — ключи писем, где ждут вашего ответа,
   *   clear — снять наши метки вместо расстановки
   */
  async run({ me, gateCfg, index = null, awaiting = new Set(), clear = false } = {}) {
    if (this.#running) return this.status();
    this.#running = true;
    this.#stopped = false;

    try {
      if (!clear) await ensureTags(this.browser);
      const saved = await this.db.meta.get(STATE_KEY);
      const state = saved?.v === STATE_VERSION && !saved.done && saved.clear === clear
        ? saved
        : { v: STATE_VERSION, clear, startedAt: Date.now(), doneFolders: [], tagged: 0, cleared: 0, seen: 0, done: false };
      this.#state = state;

      const done = new Set(state.doneFolders);
      for (const key of await this.#folders()) {
        if (this.#stopped) break;
        if (done.has(key)) continue;
        await this.#folder(key, { me, gateCfg, index, awaiting, clear, state });
        if (this.#stopped) break;
        done.add(key);
        state.doneFolders = [...done];
        await this.db.meta.set(STATE_KEY, state);
      }

      state.done = !this.#stopped;
      if (state.done) state.finishedAt = Date.now();
      await this.db.meta.set(STATE_KEY, state);
      return this.status();
    } finally {
      this.#running = false;
    }
  }

  /** Папки, в которых лежат разобранные письма. Пустые обходить незачем. */
  async #folders() {
    const keys = new Set();
    await this.db.pages("messages", 2000, (rows) => {
      for (const row of rows) for (const loc of row.locations ?? []) keys.add(loc);
    });
    return [...keys];
  }

  async #folder(key, { me, gateCfg, index, awaiting, clear, state }) {
    const rows = await this.db.messagesInFolder(key);
    if (!rows.length) return;
    const byKey = new Map(rows.map((r) => [r.id, r]));

    // Один запрос на папку: в 115 он перебирает её целиком в любом случае.
    let page;
    try {
      page = await this.browser.messages.query({ folder: parseFolderKey(key) });
    } catch {
      return;   // папку удалили или она недоступна — не повод ронять проход
    }

    while (page) {
      for (const hdr of page.messages ?? []) {
        if (this.#stopped) return;
        const row = byKey.get(messageKey(hdr));
        if (!row) continue;
        state.seen++;

        const current = hdr.tags ?? [];
        const mine = current.filter((t) => OUR_KEYS.has(t));
        const want = clear
          ? []
          : tagsFor(row, gate(derive(row, me, index), gateCfg), awaiting, this.cfg);

        if (mine.length === want.length && mine.every((t) => want.includes(t))) continue;
        const next = [...current.filter((t) => !OUR_KEYS.has(t)), ...want];
        try {
          await this.browser.messages.update(hdr.id, { tags: next });
          if (clear) state.cleared += mine.length;
          else state.tagged++;
        } catch {
          // Письмо могли удалить между запросом и обновлением.
        }
      }
      this.onProgress(state);
      if (!page.id) break;
      page = await this.browser.messages.continueList(page.id).catch(() => null);
    }
  }
}

/** Письма, которых ждут ответа: последнее письмо каждого дела в «Жду ответа». */
export function awaitingKeys(cases) {
  const out = new Set();
  for (const c of cases) {
    if (c.state !== "wait") continue;
    const last = c.letters[c.letters.length - 1];
    if (last) out.add(last.id);
  }
  return out;
}

export { folderKey };
