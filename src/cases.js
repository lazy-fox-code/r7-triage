// Дела из писем — без модели.
//
// Пока классификации нет, делом считается связная группа писем: одна ветка
// (корень и родитель по References), одна беседа Outlook (Thread-Index) и
// всё, что касается одной встречи или задачи (UID из text/calendar).
// Конференция TrueConf дела не склеивает — одна постоянная комната отдела
// служит многим делам, — а только связывает их на графе.
//
// Поручения, сроки и состояния дел появятся поверх этого, когда подключится
// модель. До того у дела два состояния: «новое» (есть непрочитанные письма)
// и «ветка».
//
// Модуль чистый: на входе записи писем, на выходе дела. Считается и во
// вкладке «Дела», и в фоне для бейджа на кнопке.

import { derive, gate } from "./features.js";
import { normalizeSubject } from "./keys.js";

const DAY = 86400000;

// Приставки ответов и пересылок убираем из названия дела, регистр и кавычки
// оставляем: это название для человека, а не ключ.
const PREFIX = /^(?:(?:re|fwd?|aw|wg|tr|отв|ответ|пер|пересл)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*)+/i;
export const displaySubject = (s) => String(s ?? "").replace(PREFIX, "").trim() || "(без темы)";

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

/** Почему письмо в деле — для плашки «почему в деле». */
function whyOf(row, ctx) {
  if (row.id === ctx.startId) return "начало ветки";
  for (const c of row.calendar ?? []) {
    if (ctx.sharedUids.has(c.uid)) {
      const when = c.start?.ms ? new Date(c.start.ms).toLocaleString("ru-RU",
        { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      return `та же встреча${when ? ` ${when}` : ""}`;
    }
  }
  if (row.thread?.root || row.thread?.parent) return "та же ветка";
  if (row.thread?.index) return "та же беседа Outlook";
  return "та же ветка";
}

/**
 * @param {object[]} rows записи писем
 * @param {object} opts
 *   me        Set своих адресов
 *   gateCfg   ветка `gate` из настроек
 *   now       мс
 *   newDays   сколько дней непрочитанное считается новым
 * @returns {{ cases: object[], cross: object[] }}
 */
export function buildCases(rows, { me = new Set(), gateCfg = { massCcRecipients: 8 }, now = Date.now(), newDays = 7 } = {}) {
  // Рассылки, автоматика и спам делами не становятся.
  const kept = [];
  for (const row of rows) {
    const g = gate(derive(row, me), gateCfg);
    if (g.outcome === "noise") continue;
    kept.push({ row, outcome: g.outcome });
  }

  const uf = new UnionFind();
  for (const { row } of kept) {
    uf.find(row.id);
    if (row.threadId) uf.union(row.id, row.threadId);
    if (row.thread?.parent) uf.union(row.id, row.thread.parent);
    if (row.thread?.index) uf.union(row.id, row.thread.index);
    for (const c of row.calendar ?? []) if (c.uid) uf.union(row.id, `cal:${c.uid}`);
  }

  const groups = new Map();
  for (const item of kept) {
    const root = uf.find(item.row.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  }

  const cases = [];
  const byConference = new Map();
  for (const items of groups.values()) {
    items.sort((a, b) => a.row.date - b.row.date || (a.row.id < b.row.id ? -1 : 1));
    const start = items[0].row;
    const last = items[items.length - 1].row;

    // UID встреч, которые встретились больше одного раза, — ими дело склеено.
    const uidCount = new Map();
    for (const { row } of items) {
      for (const c of row.calendar ?? []) uidCount.set(c.uid, (uidCount.get(c.uid) ?? 0) + 1);
    }
    const sharedUids = new Set([...uidCount].filter(([, n]) => n > 1).map(([u]) => u));
    const ctx = { startId: start.id, sharedUids };

    const meetings = new Map();
    const tasks = new Map();
    const conferences = new Map();
    const people = new Map();
    const files = [];
    let unread = 0;
    let fromMe = 0;
    const outcomes = { info: 0, model: 0, pending: 0, own: 0 };

    const letters = items.map(({ row, outcome }) => {
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      const mine = me.has(row.fromId);
      if (mine) fromMe++;
      else if (!row.read) unread++;
      for (const addr of [row.fromId, ...(row.to ?? []), ...(row.cc ?? [])]) {
        if (!addr || me.has(addr)) continue;
        const p = people.get(addr) ?? { email: addr, name: "", letters: 0, wrote: 0 };
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
    const c = {
      id,
      title: displaySubject(start.subject),
      key: normalizeSubject(start.subject),
      firstAt: start.date,
      lastAt: last.date,
      state: isNew ? "new" : "branch",
      unread,
      fromMe,
      outcomes,
      letters,
      meetings: [...meetings.values()].sort((a, b) => (b.start ?? 0) - (a.start ?? 0)),
      tasks: [...tasks.values()],
      conferences: [...conferences.values()],
      files,
      people: [...people.values()].sort((a, b) => b.wrote - a.wrote || b.letters - a.letters),
      joinedBy: {
        thread: items.some(({ row }) => row.thread?.root || row.thread?.parent),
        outlook: items.some(({ row }) => row.thread?.index),
        meeting: sharedUids.size > 0,
      },
    };
    c.counts = {
      mail: letters.length, meet: c.meetings.length, task: c.tasks.length,
      conf: c.conferences.length, files: files.length, people: c.people.length,
    };
    cases.push(c);
    for (const conf of c.conferences) {
      if (!byConference.has(conf.key)) byConference.set(conf.key, []);
      byConference.get(conf.key).push({ caseId: id, conf });
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
  return { cases, cross };
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
