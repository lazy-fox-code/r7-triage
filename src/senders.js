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

// Слова, после которых число — номер предмета переписки, а не дата и не
// количество. Стемы: «заявк» ловит «заявка», «заявке», «заявки».
const OBJECT_NOUNS = "заявк|инцидент|обращени|запрос|задач|тикет|договор|контракт|соглашени|" +
  "счет|счёт|акт|наряд|заказ|проект|спецификаци|позици|лот|закупк|тендер|" +
  "ticket|issue|request|incident|case|order|invoice|contract";
// Слово + номер: «Договор № 15», «Заявка 12345». Число не должно быть датой,
// поэтому после него не идёт разделитель с цифрой (15.09).
const OBJECT_NOUN_NUM = new RegExp(
  `(?<!\\p{L})((${OBJECT_NOUNS})\\p{L}*)\\s*(?:№|#|n[oº]?)?\\s*[:\\-]?\\s*(\\d{2,})(?![\\d]|[./-]\\d)`, "iu");
// Любое слово перед знаком номера: «Протокол № 3», «Ведомость #12».
const OBJECT_ANY_NUM = /(?<!\p{L})((\p{L}{3,})\p{L}*)\s*(?:№|#)\s*(\d{2,})(?![\d]|[./-]\d)/iu;

/**
 * Ключ предмета переписки из темы: по нему письма о нём собираются в одно
 * дело, даже если ветки разные и писали разные люди. Номер без слова
 * («№ 15») ключом не считается — он ничей и склеил бы разное.
 *
 * @returns {{key: string, label: string}|null}
 */
export function objectKey(subject) {
  const s = String(subject ?? "");
  const code = OBJECT_CODE.exec(s);
  if (code) {
    const digits = code[2].replace(/^0+(?=\d)/, "");
    return { key: `${code[1].toLowerCase()}-${digits}`, label: `${code[1].toUpperCase()}-${code[2]}` };
  }
  const noun = OBJECT_NOUN_NUM.exec(s) ?? OBJECT_ANY_NUM.exec(s);
  if (noun) {
    // Ключ — по основе слова: «договору 15» и «договор № 15» об одном.
    const stem = noun[2].toLowerCase().replace(/ё/g, "е");
    const digits = noun[3].replace(/^0+(?=\d)/, "");
    return { key: `${stem}-${digits}`, label: `${noun[1]} № ${noun[3]}` };
  }
  return null;
}

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

// Обработка встреч в этой почте приходит обычными письмами: приглашений с
// text/calendar через шлюз Exchange нет вовсе (на живом ящике 0 из 20 061),
// а ответы участников и переносы узнаются только по приставке в теме.
const MEETING_PREFIX = [
  ["response", /^(?:принято|отклонено|предварительно|под\s*вопросом|accepted|declined|tentative)\s*:/i],
  ["cancel", /^(?:отменено|отмена|canceled|cancelled)\s*:/i],
  ["update", /^(?:новое\s*время|перенесено|обновлено|обновлённое\s*приглашение|обновленное\s*приглашение|updated(?:\s*invitation)?)\s*:/i],
  ["invite", /^(?:приглашение|invitation)\s*:/i],
];

/**
 * Письмо про встречу и какое именно: ответ участника, отмена, перенос,
 * приглашение. null — обычное письмо.
 */
export function meetingKind(subject) {
  const s = String(subject ?? "").trim();
  for (const [kind, re] of MEETING_PREFIX) if (re.test(s)) return kind;
  return null;
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
    // Кому адресована почта, приходящая в ящик. Самые частые адреса, кроме
    // своих, — это списки рассылки, в которых состоит пользователь: без них
    // «мне в Кому» и «я в копии» считаются неверно.
    this.recipients = new Map();
    // Кто вообще когда-либо писал: адрес, который только получает и никогда
    // не пишет, — это список рассылки или общий ящик, а не человек.
    this.senders = new Set();
    // Когда я в последний раз писал в этой ветке. Письмо ветки старше этого
    // момента уже отвечено — модели там делать нечего.
    this.myLastInThread = new Map();
    // Мои письма вне папки «Отправленные» — признак того, что отправитель
    // писем определяется неверно (проверка доли «моих» писем).
    this.mine = { total: 0, outsideSent: 0 };
  }

  add(row) {
    if (!row?.fromId) return;
    if (this.me.has(row.fromId)) {
      for (const a of [...(row.to ?? []), ...(row.cc ?? []), ...(row.bcc ?? [])]) this.wroteTo.add(a);
      if (row.threadId) this.myThreads.add(row.threadId);
      if (row.thread?.root) this.myThreads.add(row.thread.root);
      this.mine.total++;
      const sent = (row.locations ?? []).some((l) => /sent|отправ/i.test(l));
      if (!sent) this.mine.outsideSent++;
      for (const key of [row.threadId, row.thread?.root, row.id]) {
        if (!key) continue;
        const prev = this.myLastInThread.get(key) ?? 0;
        if (row.date > prev) this.myLastInThread.set(key, row.date);
      }
      return;
    }
    this.senders.add(row.fromId);
    for (const a of [...(row.to ?? []), ...(row.cc ?? [])]) {
      if (!a || this.me.has(a)) continue;
      if (this.recipients.size < 20000 || this.recipients.has(a)) {
        this.recipients.set(a, (this.recipients.get(a) ?? 0) + 1);
      }
    }
    let s = this.stat.get(row.fromId);
    if (!s) {
      s = {
        email: row.fromId, name: "", letters: 0, enriched: 0, replies: 0,
        namedToMe: 0, recipients: 0, withAttachments: 0, threads: new Set(),
        firstAt: row.date, lastAt: row.date, templates: new Map(),
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
    // Ветка письма: у системы каждое уведомление — своя ветка, у человека
    // переписка одна на много писем.
    const thread = row.threadId ?? row.id;
    s.threads.add(thread);

    const t = subjectTemplate(row.subject);
    if (!t) return;
    // Тема считается повторяющейся, если встретилась в разных переписках.
    // Иначе любая ветка из трёх писем с одной темой выглядела бы бланком:
    // «Договор» и два ответа «RE: Договор» — это разговор, а не шаблон.
    let threads = s.templates.get(t);
    if (!threads) {
      if (s.templates.size >= MAX_TEMPLATES) return;
      threads = new Set();
      s.templates.set(t, threads);
    }
    threads.add(thread);
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
      // Доля переписок, чья тема повторяется у этого же отправителя: у
      // системы тема — бланк на каждое уведомление, у человека — разговор.
      let repeated = 0;
      let topTemplate = 0;
      for (const threads of s.templates.values()) {
        if (threads.size > 1) repeated += threads.size;
        if (threads.size > topTemplate) topTemplate = threads.size;
      }
      const templateShare = s.threads.size ? repeated / s.threads.size : 0;
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
        // В скольких разных переписках повторился самый частый бланк. У
        // системы это десятки, у человека — две-три похожие темы за год.
        topTemplateThreads: topTemplate,
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
  const named = cfg.namedShare ?? 0.2;

  const pattern = matchSystemAddress(p.email, patterns);
  if (pattern) {
    return {
      kind: "system",
      why: `служебный адрес: «${pattern}» в списке систем`,
      features: ["sender-address"],
    };
  }

  // Главный признак — переписка, а не то, отвечает ли отправитель себе сам.
  // Система заявок, которая связывает свои уведомления в ветку, раньше не
  // узнавалась именно из-за этого. Переписка видна по вашим письмам: вы
  // писали на этот адрес или отвечали в его ветках.
  if (!minLetters || p.letters < minLetters) {
    return { kind: "person", why: "обычный отправитель", features: [] };
  }
  if (p.iWrote || p.dialogThreads > 0) {
    return { kind: "person", why: "с этим адресом у вас переписка", features: [] };
  }

  const base = `писем ${p.letters}, вы этому адресу не писали и в его ветках не отвечали`;
  const minThreads = cfg.templateMinThreads ?? 3;
  if (p.templateShare >= share && (p.topTemplateThreads ?? 0) >= minThreads) {
    return {
      kind: "system",
      why: `${base}, одна и та же тема в ${p.topTemplateThreads} переписках ` +
        `(${Math.round(p.templateShare * 100)} % писем по шаблону)`,
      features: ["sender-one-way", "sender-templated"],
    };
  }
  if (crowd > 0 && p.avgRecipients >= crowd) {
    return {
      kind: "broadcast",
      why: `${base}, получателей в среднем ${p.avgRecipients}`,
      features: ["sender-one-way", "sender-crowd"],
    };
  }
  // Лично к вам он тоже не обращается: вы в копии или среди многих.
  if (p.namedShare <= named) {
    return {
      kind: "broadcast",
      why: `${base}, лично к вам не обращался`,
      features: ["sender-one-way", "sender-not-named"],
    };
  }
  return { kind: "person", why: "обычный отправитель", features: [] };
}

// Статус объекта в теме письма системы: «Инцидент INC-1 решён» → «решён».
// Список правится в настройках: у каждой системы свои слова.
export function statusOf(subject, words = []) {
  const s = normalizeSubject(subject);
  for (const raw of words) {
    const w = String(raw ?? "").trim().toLowerCase().replace(/ё/g, "е");
    if (w && s.includes(w)) return w;
  }
  return "";
}

/**
 * Категория письма системы: тема без номера и статуса — её бланк.
 * «Инцидент INC001 решён» → «инцидент».
 */
export function categoryOf(subject, statusWords = []) {
  let s = String(subject ?? "");
  // Код объекта вырезаем целиком: иначе от INC001 остаётся «inc».
  const code = OBJECT_CODE.exec(s);
  if (code) s = s.replace(code[0], " ");
  let t = subjectTemplate(s).replace(/#/g, " ");
  for (const raw of statusWords) {
    const w = String(raw ?? "").trim().toLowerCase().replace(/ё/g, "е");
    if (w && t.includes(w)) t = t.replace(w, " ");
  }
  return t.replace(/[\s:;,.\-№#]+/g, " ").trim();
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
  const counts = {
    total: profiles.size, system: 0, broadcast: 0, person: 0, letters: seen,
    mine: profiler.mine.total, mineOutsideSent: profiler.mine.outsideSent,
  };
  const records = [];
  for (const p of profiles.values()) {
    counts[p.kind]++;
    // Имя и адрес отправителя — те же данные, что уже лежат в письмах.
    // `people` живёт в той же базе и попадает в выгрузку состояния.
    records.push(p);
  }
  await db.putMany("people", records);
  // Частые адресаты входящей почты — кандидаты в «свои адреса»: списки
  // рассылки отдела приходят не на личный адрес, и без них адресация
  // считается неверно.
  const topRecipients = [...profiler.recipients]
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([email, letters]) => ({
      email, letters,
      // Адрес, который только получает и никогда не пишет, — почти наверняка
      // список рассылки или общий ящик, а не человек.
      neverWrites: !profiler.senders.has(email),
    }));
  counts.aliasCandidates = topRecipients.filter(
    (r) => r.neverWrites && r.letters >= (cfg.aliasHintLetters ?? 20)).length;
  return { profiles, counts, topRecipients, threads: profiler.myLastInThread };
}

/** Профили из `people` — для путей, которые их не считают сами. */
export async function loadProfiles(db) {
  const rows = await db.getAll("people");
  return new Map(rows.filter((r) => r?.email).map((r) => [r.email, r]));
}
