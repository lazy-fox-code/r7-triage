// Дела из писем — без модели.
//
// Пока классификации нет, делом считается связная группа писем: одна ветка
// (корень и родитель по References), одна беседа Outlook (Thread-Index),
// всё, что касается одной встречи или задачи (UID из text/calendar), и
// письма информационной системы об одном объекте — по номеру инцидента или
// заявки в теме, а без номера по теме с точностью до чисел.
// Конференция TrueConf дела не склеивает — одна постоянная комната отдела
// служит многим делам, — а только связывает их на графе. Так же связаны
// между собой дела одной системы: на графе у них общий узел, но каждый
// инцидент остаётся отдельным делом со своей историей.
//
// Период (настройки → `cases.periodDays`) выбирает, какие дела показывать —
// те, в которых было движение, — но не то, где дело начинается. Дело
// собирается с первого письма: ранние письма тех же веток и объектов
// поднимаются из базы (`loadCaseRows`). Иначе переписка, начатая раньше
// периода, выглядела бы начавшейся на его границе.
//
// Поручения, сроки и состояния дел появятся поверх этого, когда подключится
// модель. До того у дела два состояния: «новое» (есть непрочитанные письма)
// и «ветка».
//
// `buildCases` чистая: на входе записи писем, на выходе дела. Считается и во
// вкладке «Дела», и в фоне для бейджа на кнопке, и в отчёте о проверке.

import { derive, gate } from "./features.js";
import { normalizeSubject } from "./keys.js";
import { DEFAULTS } from "./settings.js";
import {
  SenderProfiler, matchSystemAddress, objectId, objectKey, subjectTemplate, loadProfiles,
} from "./senders.js";

// Правила «кто такой отправитель» общие с гейтом: система, которая в
// отсеве считается информированием, и во вкладке «Дела» та же самая.
export { matchSystemAddress, objectId, objectKey, subjectTemplate };

const DAY = 86400000;

// Сколько раз подряд поднимать ранние письма. Ветка глубиной в сотни писем
// разбирается за пару кругов: каждый круг поднимает всю ветку целиком, а
// новый круг нужен только там, где References обрезаны и ветка собирается
// по одному родителю за раз.
const HISTORY_ROUNDS = 8;

// Приставки ответов и пересылок убираем из названия дела, регистр и кавычки
// оставляем: это название для человека, а не ключ.
const PREFIX = /^(?:(?:re|fwd?|aw|wg|tr|отв|ответ|пер|пересл)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*)+/i;
export const displaySubject = (s) => String(s ?? "").replace(PREFIX, "").trim() || "(без темы)";

const plural = (n, f) => {
  const m = n % 100;
  const k = n % 10;
  return f[(m > 10 && m < 20) ? 2 : k === 1 ? 0 : (k >= 2 && k <= 4) ? 1 : 2];
};

class UnionFind {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) { this.p.set(x, x); return x; }
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
    return r;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(rb, ra);
  }
}

// --- информационные системы ---------------------------------------------------

/** Ключ склейки для письма системы: номер объекта, иначе шаблон темы. */
function systemKey(row, systems) {
  if (!systems.has(row.fromId)) return null;
  const object = objectId(row.subject);
  if (object) return { key: `sys:${row.fromId}|${object}`, object, email: row.fromId };
  const template = subjectTemplate(row.subject);
  // Пустая или слишком короткая тема шаблоном не считается: она склеила бы
  // всё подряд.
  if (template.replace(/[#\s]/g, "").length < 4) return null;
  return { key: `sys:${row.fromId}|t:${template}`, object: null, email: row.fromId };
}

/**
 * Какие отправители — информационные системы. Правило и пороги общие с
 * отсевом без модели (`senders.js`): система — это служебный адрес из
 * настроек или отправитель, который пишет много, никогда не отвечает в
 * ветке, вам не писал и повторяет темы.
 *
 * Это не про важность отправителя (правило 3 из CLAUDE.md), а про то, чем
 * склеивать его письма: у системы вместо ветки — номер объекта в теме.
 *
 * @returns {Map<string, object>} адрес → профиль системы
 */
export function detectSystems(rows, me = new Set(), cfg = DEFAULTS.senders) {
  const profiler = new SenderProfiler(me);
  for (const row of rows) profiler.add(row);
  const out = new Map();
  for (const [email, p] of profiler.profiles(cfg)) {
    if (p.kind === "system") out.set(email, p);
  }
  return out;
}

// --- письма для сборки --------------------------------------------------------

/**
 * Письма для сборки дел: всё за период и ранние письма тех же дел.
 *
 * Ранние письма поднимаются по ключам, которые уходят за границу периода:
 * родитель и корень ветки — по первичному ключу, остальные письма ветки —
 * по индексу `threadId`, письма системы — по индексу `fromId` с тем же
 * номером объекта или шаблоном темы. Беседы Outlook (Thread-Index) и
 * встречи вглубь пока не поднимаются: индексов по ним в базе нет, а на
 * живом ящике их ноль (отчёт о проверке 22.09.2026). Появятся — добавлять
 * индексы миграцией, не перебором ящика.
 *
 * @param {object} db модуль db.js или его подмена в тестах
 * @param {object} opts since — начало периода, мс; me — свои адреса;
 *                      cfg — ветка `cases`, sendersCfg — ветка `senders`
 * @returns {Promise<{rows: object[], systems: Map, history: object}>}
 */
export async function loadCaseRows(db, {
  since = null, me = new Set(), cfg = DEFAULTS.cases, sendersCfg = DEFAULTS.senders,
} = {}) {
  const limit = cfg.historyLimit ?? 0;
  const seeds = await db.messagesInDateRange(since, null);
  const byId = new Map(seeds.map((r) => [r.id, r]));
  const history = { added: 0, truncated: false };

  const take = (found) => {
    const fresh = [];
    for (const row of found) {
      if (!row || byId.has(row.id)) continue;
      if (history.added >= limit) { history.truncated = true; break; }
      byId.set(row.id, row);
      fresh.push(row);
      history.added++;
    }
    return fresh;
  };

  const askedIds = new Set();
  const askedThreads = new Set();
  let frontier = seeds;
  for (let round = 0; round < HISTORY_ROUNDS && frontier.length && !history.truncated; round++) {
    const ids = [];
    const threads = [];
    for (const row of frontier) {
      // Родитель есть, а в собранном его нет — ветка уходит за период.
      const parent = row.thread?.parent;
      if (!parent || byId.has(parent)) continue;
      for (const key of [parent, row.thread?.root]) {
        if (key && !byId.has(key) && !askedIds.has(key)) { askedIds.add(key); ids.push(key); }
      }
      if (row.threadId && !askedThreads.has(row.threadId)) {
        askedThreads.add(row.threadId);
        threads.push(row.threadId);
      }
    }
    if (!ids.length && !threads.length) break;
    frontier = take([
      ...await db.getMany("messages", ids),
      ...await db.getAllFromIndexMany("messages", "threadId", threads),
    ]);
  }

  // Профили по всему ящику точнее, чем по одному периоду: их считает замер
  // отсева и кладёт в `people`. Нет их — узнаём системы по поднятым письмам.
  const systems = detectSystems([...byId.values()], me, sendersCfg);
  for (const [email, p] of await loadProfiles(db)) {
    if (p.kind === "system" && !systems.has(email)) systems.set(email, p);
  }
  if (systems.size && !history.truncated) {
    // У письма системы ветки нет: раннюю историю объекта ищем по отправителю
    // и оставляем письма с тем же номером или шаблоном темы.
    const wanted = new Map();
    for (const row of seeds) {
      const key = systemKey(row, systems);
      if (!key) continue;
      if (!wanted.has(row.fromId)) wanted.set(row.fromId, new Set());
      wanted.get(row.fromId).add(key.key);
    }
    if (wanted.size) {
      const found = await db.getAllFromIndexMany("messages", "fromId", [...wanted.keys()]);
      take(found.filter((row) => wanted.get(row.fromId)?.has(systemKey(row, systems)?.key)));
    }
  }

  const merges = (await db.meta.get("cases:merges")) ?? [];
  return { rows: [...byId.values()], systems, merges, history };
}

/** Запомнить объединение дел руками. Ключи писем устойчивы. */
export async function mergeCases(db, a, b, why = "объединено вручную") {
  const merges = (await db.meta.get("cases:merges")) ?? [];
  if (merges.some((m) => (m.a === a && m.b === b) || (m.a === b && m.b === a))) return merges;
  merges.push({ a, b, at: Date.now(), why });
  await db.meta.set("cases:merges", merges);
  return merges;
}

/** Отменить объединение, в котором участвует письмо. */
export async function unmergeCase(db, letterId) {
  const merges = (await db.meta.get("cases:merges")) ?? [];
  const left = merges.filter((m) => m.a !== letterId && m.b !== letterId);
  await db.meta.set("cases:merges", left);
  return left;
}

// --- сборка ---------------------------------------------------------------------

/** Есть ли у писем общий участник, кроме меня. */
function sharePeople(a, b, me) {
  const set = new Set();
  for (const x of [a.fromId, ...(a.to ?? []), ...(a.cc ?? [])]) if (x && !me.has(x)) set.add(x);
  for (const x of [b.fromId, ...(b.to ?? []), ...(b.cc ?? [])]) if (x && !me.has(x) && set.has(x)) return true;
  return false;
}

/** Почему письмо в деле — для плашки «почему в деле». */
function whyOf(row, ctx) {
  const sys = ctx.sysKeys.get(row.id);
  const shared = sys && ctx.sharedSys.has(sys.key);

  if (row.id === ctx.startId) {
    // Родитель у письма есть, а в деле его нет: начало ветки удалено, лежит
    // за пределами поднятой истории или ещё не разобрано.
    if (row.thread?.parent) return "самое раннее найденное письмо ветки";
    const first = ctx.objKeys.get(row.id);
    if (first && ctx.sharedObjects.has(first.key)) return `первое письмо о ${first.label}`;
    if (shared) return sys.object ? `первое письмо о ${sys.object}` : "первое письмо серии";
    return "начало ветки";
  }
  for (const c of row.calendar ?? []) {
    if (ctx.sharedUids.has(c.uid)) {
      const when = c.start?.ms ? new Date(c.start.ms).toLocaleString("ru-RU",
        { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      return `та же встреча${when ? ` ${when}` : ""}`;
    }
  }
  if (row.thread?.root || row.thread?.parent) return "та же ветка";
  if (row.thread?.index) return "та же беседа Outlook";
  const obj = ctx.objKeys.get(row.id);
  if (obj && ctx.sharedObjects.has(obj.key)) return `тот же предмет: ${obj.label}`;
  if (shared) {
    const name = ctx.systemName(row.fromId);
    return sys.object ? `${name}: тот же номер ${sys.object}` : `${name}: та же тема письма системы`;
  }
  if (ctx.subjectJoined.has(row.id)) return "та же тема и общий участник";
  if (ctx.merged.has(row.id)) return "дела объединены вручную";
  return "та же ветка";
}

/**
 * @param {object[]} rows записи писем
 * @param {object} opts
 *   me        Set своих адресов
 *   gateCfg   ветка `gate` из настроек
 *   cfg       ветка `cases` из настроек
 *   sendersCfg ветка `senders` из настроек
 *   systems   готовая карта систем из loadCaseRows; нет — считается здесь
 *   since     начало периода, мс: письма старше — поднятая история дела,
 *             они не делают дело новым, и дела без движения в периоде
 *             не показываются
 *   now       мс
 * @returns {{ cases: object[], cross: object[], systems: object[] }}
 */
export function buildCases(rows, {
  me = new Set(), gateCfg = DEFAULTS.gate, cfg = DEFAULTS.cases,
  sendersCfg = DEFAULTS.senders, systems = null, merges = [], since = null, now = Date.now(),
} = {}) {
  const newDays = cfg.newDays ?? 7;
  const sys = systems ?? detectSystems(rows, me, sendersCfg);
  const systemName = (email) => {
    const s = sys.get(email);
    return `«${s?.name || email}»`;
  };

  // Рассылки, автоматика и спам делами не становятся.
  const kept = [];
  const sysKeys = new Map();
  for (const row of rows) {
    const g = gate(derive(row, me, sys), gateCfg);
    if (g.outcome === "noise") continue;
    kept.push({ row, outcome: g.outcome });
    const key = systemKey(row, sys);
    if (key) sysKeys.set(row.id, key);
  }

  const uf = new UnionFind();
  const objKeys = new Map();
  for (const { row } of kept) {
    uf.find(row.id);
    if (row.threadId) uf.union(row.id, row.threadId);
    if (row.thread?.parent) uf.union(row.id, row.thread.parent);
    if (row.thread?.index) uf.union(row.id, row.thread.index);
    for (const c of row.calendar ?? []) if (c.uid) uf.union(row.id, `cal:${c.uid}`);
    const key = sysKeys.get(row.id);
    if (key) uf.union(row.id, key.key);

    // Предмет переписки из темы: «Договор № 15», INC-0012345. Работает и
    // между разными отправителями — уведомление системы об инциденте и
    // письмо коллеги о нём же оказываются в одном деле.
    if (cfg.joinByObject) {
      const obj = objectKey(row.subject);
      if (obj) { objKeys.set(row.id, obj); uf.union(row.id, `obj:${obj.key}`); }
    }
  }

  // Одинаковая тема при общем участнике — переписка, у которой не дошли
  // References: Thread-Index в этой почте пуст, и без этого правила такие
  // письма остаются каждое своим делом.
  const subjectJoined = new Set();
  const joinDays = cfg.subjectJoinDays ?? 0;
  if (joinDays > 0) {
    const buckets = new Map();
    for (const { row } of kept) {
      const key = normalizeSubject(row.subject);
      // Короткая тема («отчёт», «вопрос») общим предметом не считается.
      if (key.length < 8) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    for (const rows of buckets.values()) {
      if (rows.length < 2) continue;
      rows.sort((a, b) => a.date - b.date);
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const row = rows[i];
        if (row.date - prev.date > joinDays * DAY) continue;
        if (!sharePeople(prev, row, me)) continue;
        uf.union(prev.id, row.id);
        subjectJoined.add(row.id);
      }
    }
  }

  // Объединения руками: пользователь свёл два дела, и это решение переживает
  // пересборку. Ключи писем устойчивы, поэтому связь не рассыпается, когда
  // дело прирастает письмами.
  const merged = new Set();
  for (const m of merges) {
    if (!uf.p.has(m.a) || !uf.p.has(m.b)) continue;
    uf.union(m.a, m.b);
    merged.add(m.a);
    merged.add(m.b);
  }

  const groups = new Map();
  for (const item of kept) {
    const root = uf.find(item.row.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  }

  const cases = [];
  const byConference = new Map();
  const bySystem = new Map();
  for (const items of groups.values()) {
    items.sort((a, b) => a.row.date - b.row.date || (a.row.id < b.row.id ? -1 : 1));
    const start = items[0].row;
    const last = items[items.length - 1].row;
    // Дело без движения в периоде показывать незачем: оно поднято как
    // история соседнего дела.
    if (since != null && last.date < since) continue;

    // Ключи, которые встретились больше одного раза, — ими дело склеено.
    const uidCount = new Map();
    const sysCount = new Map();
    const objCount = new Map();
    for (const { row } of items) {
      for (const c of row.calendar ?? []) uidCount.set(c.uid, (uidCount.get(c.uid) ?? 0) + 1);
      const key = sysKeys.get(row.id);
      if (key) sysCount.set(key.key, (sysCount.get(key.key) ?? 0) + 1);
      const obj = objKeys.get(row.id);
      if (obj) objCount.set(obj.key, (objCount.get(obj.key) ?? 0) + 1);
    }
    const sharedUids = new Set([...uidCount].filter(([, n]) => n > 1).map(([u]) => u));
    const sharedSys = new Set([...sysCount].filter(([, n]) => n > 1).map(([k]) => k));
    const sharedObjects = new Set([...objCount].filter(([, n]) => n > 1).map(([k]) => k));
    const ctx = {
      startId: start.id, sharedUids, sharedSys, sharedObjects,
      sysKeys, objKeys, subjectJoined, merged, systemName,
    };

    const meetings = new Map();
    const tasks = new Map();
    const conferences = new Map();
    const people = new Map();
    const senders = new Set();
    const files = [];
    let unread = 0;
    let fromMe = 0;
    let early = 0;
    const outcomes = { info: 0, model: 0, pending: 0, own: 0 };

    const letters = items.map(({ row, outcome }) => {
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      const mine = me.has(row.fromId);
      const isEarly = since != null && row.date < since;
      if (isEarly) early++;
      if (mine) fromMe++;
      // Непрочитанное до периода дело новым не делает: показываем его не
      // из-за него.
      else if (!row.read && !isEarly) unread++;
      if (sys.has(row.fromId)) senders.add(row.fromId);
      for (const addr of [row.fromId, ...(row.to ?? []), ...(row.cc ?? [])]) {
        if (!addr || me.has(addr)) continue;
        const p = people.get(addr) ?? { email: addr, name: "", letters: 0, wrote: 0, system: sys.has(addr) };
        p.letters++;
        if (addr === row.fromId) { p.wrote++; if (row.fromName) p.name = row.fromName; }
        people.set(addr, p);
      }
      for (const c of row.calendar ?? []) {
        const map = c.kind === "task" ? tasks : meetings;
        const prev = map.get(c.uid);
        // Последняя версия встречи — с наибольшим SEQUENCE, при равенстве — свежее.
        if (!prev || (c.sequence ?? 0) >= (prev.sequence ?? 0)) {
          map.set(c.uid, {
            uid: c.uid, summary: c.summary ?? "", start: c.start?.ms ?? null,
            organizer: c.organizer ?? null, attendees: c.attendees?.length ?? 0,
            method: c.method ?? null, sequence: c.sequence ?? 0,
            cancelled: c.method === "CANCEL" || c.status === "CANCELLED",
          });
        }
      }
      for (const ref of row.conferences ?? []) {
        if (!conferences.has(ref.key)) conferences.set(ref.key, { key: ref.key, id: ref.id, topic: ref.topic, host: ref.host });
      }
      for (const a of row.attachments ?? []) {
        if (!a.inline) files.push({ name: a.name, size: a.size, contentType: a.contentType, date: row.date, messageId: row.id });
      }
      return {
        id: row.id, date: row.date, fromId: row.fromId, fromName: row.fromName,
        subject: row.subject, read: Boolean(row.read), mine,
        attachments: (row.attachments ?? []).filter((a) => !a.inline).length,
        why: whyOf(row, ctx),
      };
    });

    const id = `c:${start.id}`;
    const isNew = unread > 0 && last.date >= now - newDays * DAY;
    const meetingList = [...meetings.values()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    // Дело начинается с первого письма или события — смотря что раньше.
    const firstAt = Math.min(start.date, ...meetingList.map((m) => m.start).filter((ms) => ms > 0));
    const joinedBySystem = items.map(({ row }) => sysKeys.get(row.id))
      .find((k) => k && sharedSys.has(k.key)) ?? null;
    const c = {
      id,
      title: displaySubject(start.subject),
      key: normalizeSubject(start.subject),
      firstAt,
      lastAt: last.date,
      startedBefore: since != null && firstAt < since,
      state: isNew ? "new" : "branch",
      unread,
      fromMe,
      early,
      outcomes,
      letters,
      meetings: meetingList,
      tasks: [...tasks.values()],
      conferences: [...conferences.values()],
      systems: [...senders],
      files,
      people: [...people.values()].sort((a, b) => b.wrote - a.wrote || b.letters - a.letters),
      // Предмет дела, если он назван в темах: номер договора, инцидента,
      // заявки. По нему дело узнаётся человеком лучше, чем по теме письма.
      object: [...items.map(({ row }) => objKeys.get(row.id))]
        .find((o) => o && sharedObjects.has(o.key))?.label
        ?? (objKeys.get(start.id)?.label ?? null),
      joinedBy: {
        thread: items.some(({ row }) => row.thread?.root || row.thread?.parent),
        outlook: items.some(({ row }) => row.thread?.index),
        meeting: sharedUids.size > 0,
        object: sharedObjects.size > 0,
        subject: items.some(({ row }) => subjectJoined.has(row.id)),
        manual: items.some(({ row }) => merged.has(row.id)),
        system: joinedBySystem
          ? { email: joinedBySystem.email, name: sys.get(joinedBySystem.email)?.name || joinedBySystem.email,
            object: joinedBySystem.object }
          : null,
      },
    };
    c.counts = {
      mail: letters.length, meet: c.meetings.length, task: c.tasks.length,
      conf: c.conferences.length, files: files.length, people: c.people.length,
    };
    // Дело системы: писали в нём только системы. Такие дела в списке и на
    // графе сворачиваются под свою систему — иначе сотня уведомлений
    // закрывает собой переписку.
    const writers = [...new Set(letters.filter((l) => !l.mine).map((l) => l.fromId))];
    c.systemOwner = writers.length > 0 && writers.every((w) => sys.has(w)) ? writers[0] : null;
    // Вес дела: по нему в списке поднимаются проекты и внедрения, а не
    // однописьменные уведомления. Письма, участники, вложения и срок жизни.
    c.weight = Math.round(
      letters.length * 2 + c.people.length * 3 + files.length
      + Math.min(30, (c.lastAt - c.firstAt) / DAY) / 2
      + (fromMe > 0 ? 6 : 0));
    cases.push(c);
    for (const conf of c.conferences) {
      if (!byConference.has(conf.key)) byConference.set(conf.key, []);
      byConference.get(conf.key).push({ caseId: id, conf });
    }
    for (const email of senders) {
      if (!bySystem.has(email)) bySystem.set(email, []);
      bySystem.get(email).push(id);
    }
  }

  cases.sort((a, b) => b.lastAt - a.lastAt);

  // Конференция на несколько дел — связь между ними, не склейка.
  const cross = [];
  for (const list of byConference.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        cross.push({
          a: list[i].caseId, b: list[j].caseId, kind: "conf",
          why: `конференция № ${list[i].conf.id}${list[i].conf.topic ? ` «${list[i].conf.topic}»` : ""}`,
        });
      }
    }
  }

  // Система — общий узел своих дел, а не склейка: инциденты остаются
  // отдельными делами, но видно, что они от одной системы.
  const systemList = [];
  for (const [email, ids] of bySystem) {
    const s = sys.get(email);
    systemList.push({
      id: `s:${email}`, email, name: s?.name || email,
      why: s?.why ?? "", cases: ids,
    });
  }
  systemList.sort((a, b) => b.cases.length - a.cases.length);

  return { cases, cross, systems: systemList };
}

/**
 * Что изменилось между двумя сборками — для ленты событий и анимации:
 * новые дела и письма, присоединившиеся к уже известным делам.
 */
export function diffCases(prev, next) {
  const before = new Map(prev.map((c) => [c.id, c]));
  const events = [];
  for (const c of next) {
    const old = before.get(c.id);
    if (!old) {
      events.push({ kind: "case", caseId: c.id, title: c.title, why: c.letters[0]?.why ?? "новая ветка" });
      continue;
    }
    if (c.letters.length === old.letters.length) continue;
    const known = new Set(old.letters.map((l) => l.id));
    for (const l of c.letters) {
      if (!known.has(l.id)) {
        events.push({ kind: "letter", caseId: c.id, title: c.title, subject: displaySubject(l.subject), why: l.why });
      }
    }
  }
  return events;
}
