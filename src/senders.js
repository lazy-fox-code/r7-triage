// Профиль отправителя: кто пишет и как — из самих писем, без их тел.
//
// Зачем
// -----
// Отсев без модели задуман на заголовках рассылок (`List-Id`,
// `List-Unsubscribe`, `Precedence`, `Auto-Submitted`). На живом ящике
// 22.09.2026 их нет ни у одного из 15 245 дочитанных писем: в закрытом
// периметре внутренние системы их не ставят, а почта приходит через шлюз
// Exchange. Отсев на них дал 5 % при цели 60-80 %.
//
// Признак, который в периметре всё-таки есть, — поведение отправителя.
// Система уведомлений и живой коллега различаются не заголовком, а тем, как
// они пишут:
//
//   · система шлёт много писем и никогда не отвечает в ветке;
//   · вы ей не отвечали и не писали сами;
//   · её темы повторяются с точностью до номера и статуса
//     («Инцидент INC-1 назначен», «Инцидент INC-2 назначен»);
//   · рассылка отдела — то же самое, но с большим числом получателей.
//
// Это считается по полям, которые проход уже записал: отправитель, дата,
// тема, списки получателей, ветка. Тел писем и обращений к каталогу не
// требуется.
//
// Чего профиль НЕ решает
// ----------------------
// Класс письма. «Вам назначен инцидент» от системы — поручение, и уровень
// отправителя на факт классификации не влияет (правило 3 в CLAUDE.md).
// Профиль отвечает только на вопрос «нужна ли модель»: письма-уведомления
// без признаков действия становятся информированием без модели, всё
// остальное идёт дальше по конвейеру.
//
// Где живёт
// ---------
// Профили пишутся в `people` (ключ — адрес) и переживают перезапуск. Считает
// их один проход по `messages` — `profileSenders`. Он же нужен замеру
// отсева, поэтому замер сам его и запускает.

import { normalizeSubject } from "./keys.js";
import { ENRICH } from "./db.js";

// Больше стольких разных шаблонов тем от одного отправителя не храним:
// доля повторов к этому моменту уже понятна, а память на большом ящике
// расти не должна.
const MAX_TEMPLATES = 500;

/**
 * Совпадает ли адрес с образцом из настроек: адрес целиком, `@домен`
 * (вместе с поддоменами) или имя до `@` — точно либо с продолжением через
 * `-._+` или цифру. «noreply» узнаёт `noreply@` и `noreply-jira@`, но не
 * `noreplyer@`.
 *
 * @returns {string|null} сработавший образец — он же объяснение решения
 */
export function matchSystemAddress(email, patterns = []) {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  const local = at < 0 ? email : email.slice(0, at);
  const domain = at < 0 ? "" : email.slice(at + 1);
  for (const raw of patterns) {
    const p = String(raw ?? "").trim().toLowerCase();
    if (!p) continue;
    if (p.startsWith("@")) {
      const d = p.slice(1);
      if (d && (domain === d || domain.endsWith(`.${d}`))) return p;
    } else if (p.includes("@")) {
      if (email === p) return p;
    } else if (local === p || (local.startsWith(p) && /[-._+\d]/.test(local[p.length] ?? ""))) {
      return p;
    }
  }
  return null;
}

// Номер объекта в теме: INC0012345, SD-1234, ЗНО-5678, «Заявка № 12345»,
// «#12345». Не меньше трёх цифр: «Шаг 2» и «Отчёт за 3 квартал» — не номера.
// Границы слова заданы явно: \b в JS считает словом только латиницу и цифры,
// на кириллице он не работает.
const OBJECT_WORD = /(?<!\p{L})(?:заявк|инцидент|обращени|запрос|задач|тикет|ticket|issue|request|incident|case)\p{L}*\s*(?:№|#|n)?\s*[:-]?\s*(\d{3,})(?!\d)/iu;
const OBJECT_CODE = /(?<![\p{L}\d])(\p{L}{2,10})-?(\d{3,})(?![\p{L}\d])/u;
const OBJECT_SIGN = /(?:№|#)\s?(\d{3,})(?!\d)/u;

/** Номер объекта в теме письма или null. */
export function objectId(subject) {
  const s = String(subject ?? "");
  const word = OBJECT_WORD.exec(s);
  if (word) return `№ ${word[1]}`;
  const code = OBJECT_CODE.exec(s);
  if (code) return `${code[1].toUpperCase()}-${code[2]}`;
  const sign = OBJECT_SIGN.exec(s);
  return sign ? `№ ${sign[1]}` : null;
}

/**
 * Тема с точностью до чисел и дат: «Отчёт о доступности за 21.09.2026» и
 * «Отчёт о доступности за 22.09.2026» дают один шаблон.
 */
export function subjectTemplate(subject) {
  return normalizeSubject(subject)
    .replace(/\d+(?:[.:/-]\d+)*/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** Есть ли в теме признак того, что от вас ждут действия. */
export function actionHint(subject, words = []) {
  const s = normalizeSubject(subject);
  for (const raw of words) {
    const w = String(raw ?? "").trim().toLowerCase().replace(/ё/g, "е");
    if (w && s.includes(w)) return w;
  }
  return null;
}

/**
 * Накопитель профилей. Письма скармливаются по одному — и из выборки в
 * памяти (вкладка «Дела»), и постранично из базы (замер отсева), поэтому
 * весь ящик в память не поднимается.
 */
export class SenderProfiler {
  /** @param {Set<string>} me свои адреса */
  constructor(me = new Set()) {
    this.me = me;
    this.stat = new Map();
    // Ветки, в которых писал я: если я отвечал, это переписка, а не вещание.
    this.myThreads = new Set();
    this.wroteTo = new Set();
  }

  add(row) {
    if (!row?.fromId) return;
    if (this.me.has(row.fromId)) {
      for (const a of [...(row.to ?? []), ...(row.cc ?? []), ...(row.bcc ?? [])]) this.wroteTo.add(a);
      if (row.threadId) this.myThreads.add(row.threadId);
      if (row.thread?.root) this.myThreads.add(row.thread.root);
      return;
    }
    let s = this.stat.get(row.fromId);
    if (!s) {
      s = {
        email: row.fromId, name: "", letters: 0, enriched: 0, replies: 0,
        namedToMe: 0, recipients: 0, withAttachments: 0, threads: new Set(),
        firstAt: row.date, lastAt: row.date, templates: new Map(), templateHits: 0,
      };
      this.stat.set(row.fromId, s);
    }
    s.letters++;
    if (row.fromName && !s.name) s.name = row.fromName;
    if (row.date < s.firstAt) s.firstAt = row.date;
    if (row.date > s.lastAt) s.lastAt = row.date;
    s.recipients += row.recipientCount ?? ((row.to?.length ?? 0) + (row.cc?.length ?? 0));
    if ((row.to ?? []).some((a) => this.me.has(a)) && (row.to?.length ?? 0) <= 3) s.namedToMe++;
    if (row.hasAttachments) s.withAttachments++;
    if (row.enriched === ENRICH.DONE) {
      s.enriched++;
      if (row.thread?.parent) s.replies++;
    }
    if (row.threadId) s.threads.add(row.threadId);

    const t = subjectTemplate(row.subject);
    if (!t) return;
    const seen = s.templates.get(t);
    if (seen !== undefined) { s.templates.set(t, seen + 1); s.templateHits++; }
    else if (s.templates.size < MAX_TEMPLATES) s.templates.set(t, 1);
  }

  /**
   * Готовые профили.
   *
   * @param {object} cfg ветка `senders` настроек
   * @returns {Map<string, object>} адрес → профиль
   */
  profiles(cfg) {
    const out = new Map();
    for (const [email, s] of this.stat) {
      // Доля писем, чья тема повторяется у этого же отправителя: у системы
      // тема — бланк, у человека — разговор.
      let repeated = 0;
      for (const n of s.templates.values()) if (n > 1) repeated += n;
      const templateShare = s.letters ? repeated / s.letters : 0;
      // Ваши письма — половина картины: по ним видно, был разговор или
      // вещание. Доля веток отправителя, в которых писали вы, — та же
      // величина, на которой потом строятся рёбра графа и делегирование.
      let dialog = 0;
      for (const t of s.threads) if (this.myThreads.has(t)) dialog++;
      const myThread = dialog > 0;
      const profile = {
        id: email,
        email,
        name: s.name,
        letters: s.letters,
        enriched: s.enriched,
        replies: s.replies,
        firstAt: s.firstAt,
        lastAt: s.lastAt,
        avgRecipients: s.letters ? Math.round(s.recipients / s.letters) : 0,
        namedShare: s.letters ? s.namedToMe / s.letters : 0,
        attachShare: s.letters ? s.withAttachments / s.letters : 0,
        templateShare,
        threads: s.threads.size,
        dialogThreads: dialog,
        dialogShare: s.threads.size ? dialog / s.threads.size : 0,
        iWrote: this.wroteTo.has(email),
        myThread,
        profiledAt: Date.now(),
      };
      out.set(email, { ...profile, ...classifyKind(profile, cfg) });
    }
    return out;
  }
}

/**
 * Кто это: система уведомлений, вещание на многих или живой человек.
 * Решение объяснимо: `why` и `features` уходят в вердикт и в отчёт.
 *
 * @param {object} p профиль без вида
 * @param {object} cfg ветка `senders` настроек
 */
export function classifyKind(p, cfg = {}) {
  const patterns = cfg.systemSenders ?? [];
  const minLetters = cfg.minLetters ?? 0;
  const share = cfg.templateShare ?? 0.5;
  const crowd = cfg.broadcastRecipients ?? 0;

  const pattern = matchSystemAddress(p.email, patterns);
  if (pattern) {
    return {
      kind: "system",
      why: `служебный адрес: «${pattern}» в списке систем`,
      features: ["sender-address"],
    };
  }
  // Переписка есть — дальше не гадаем: живой человек, с которым вы говорите.
  const oneWay = minLetters > 0 && p.enriched >= minLetters && p.replies === 0
    && !p.iWrote && !p.myThread;
  if (oneWay && p.templateShare >= share) {
    return {
      kind: "system",
      why: `писем ${p.letters}, ни одного ответа в переписке, вы не отвечали и не писали, ` +
        `темы повторяются (${Math.round(p.templateShare * 100)} %)`,
      features: ["sender-one-way", "sender-templated"],
    };
  }
  if (oneWay && crowd > 0 && p.avgRecipients >= crowd) {
    return {
      kind: "broadcast",
      why: `писем ${p.letters}, получателей в среднем ${p.avgRecipients}, ` +
        "переписки с вами не было",
      features: ["sender-one-way", "sender-crowd"],
    };
  }
  return { kind: "person", why: "обычный отправитель", features: [] };
}

/**
 * Профили по всему ящику. Читает `messages` постранично и пишет `people`:
 * после этого гейт отвечает на «нужна ли модель» без повторного обхода.
 *
 * @param {object} deps.db модуль хранилища
 * @param {Set<string>} deps.me свои адреса
 * @param {object} deps.cfg ветка `senders` настроек
 * @returns {Promise<{profiles: Map, counts: object}>}
 */
export async function profileSenders({ db, me, cfg, batch = 2000, onProgress = () => {} }) {
  const profiler = new SenderProfiler(me);
  let seen = 0;
  await db.pages("messages", batch, (rows) => {
    for (const row of rows) profiler.add(row);
    seen += rows.length;
    onProgress(seen);
  });

  const profiles = profiler.profiles(cfg);
  const counts = { total: profiles.size, system: 0, broadcast: 0, person: 0, letters: seen };
  const records = [];
  for (const p of profiles.values()) {
    counts[p.kind]++;
    // Имя и адрес отправителя — те же данные, что уже лежат в письмах.
    // `people` живёт в той же базе и попадает в выгрузку состояния.
    records.push(p);
  }
  await db.putMany("people", records);
  return { profiles, counts };
}

/** Профили из `people` — для путей, которые их не считают сами. */
export async function loadProfiles(db) {
  const rows = await db.getAll("people");
  return new Map(rows.filter((r) => r?.email).map((r) => [r.email, r]));
}
