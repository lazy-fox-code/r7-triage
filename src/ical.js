// Разбор iCalendar (RFC 5545) ровно в том объёме, который нужен, чтобы
// связать письмо со встречей или задачей. Это не календарный движок:
// повторения не разворачиваются, часовые пояса не пересчитываются.
//
// Зачем это делу. Встречи и задачи из календаря расширению в 115 напрямую
// недоступны: календарного API в MailExtensions 115 нет. Зато
// каждая встреча, о которой человеку писали, оставила в ящике письмо с
// частью text/calendar: приглашение, перенос, ответ участника, отмена.
// Все они несут один и тот же UID; у Exchange это GlobalObjectId, общий для
// всех участников. По нему письма о встрече собираются вместе, даже когда
// лежат в разных ветках: ответ «Принято» — не ответ на письмо, у него своя
// тема и нет References.
//
// Задачи Exchange, назначенные письмом, приходят тем же путём, только
// компонентом VTODO вместо VEVENT.

import { normalizeAddress } from "./keys.js";

const KINDS = { VEVENT: "meeting", VTODO: "task" };

/** Продолженные строки начинаются с пробела или табуляции — склеиваем. */
function unfold(text) {
  return String(text).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

/** Разрез по разделителю вне кавычек: в CN бывают «;» и «:». */
function splitOutsideQuotes(s, sep) {
  const out = [];
  let quoted = false;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') quoted = !quoted;
    else if (s[i] === sep && !quoted) {
      out.push(s.slice(from, i));
      from = i + 1;
      if (sep === ":") break;
    }
  }
  out.push(s.slice(from));
  return out;
}

/** NAME;P1=a;P2="b:c":значение → { name, params, value } */
function parseLine(line) {
  const [head, ...rest] = splitOutsideQuotes(line, ":");
  if (!rest.length) return null;
  const [name, ...params] = splitOutsideQuotes(head, ";");
  const p = {};
  for (const kv of params) {
    const eq = kv.indexOf("=");
    if (eq > 0) p[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).replace(/^"(.*)"$/, "$1");
  }
  return { name: name.trim().toUpperCase(), params: p, value: rest.join(":") };
}

function unescapeText(v) {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

/**
 * Время. Точным оно получается только для UTC (суффикс Z). Для TZID и
 * «плавающего» времени мс посчитаны так, будто это UTC, — ошибка в пределах
 * суток. Для порядка событий в деле этого хватает, а исходная запись
 * сохраняется рядом.
 */
function parseTime(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return { raw: value.trim(), ms: null, tzid: params.TZID ?? null };
  const [, y, mo, d, h = "0", mi = "0", s = "0", z] = m;
  return {
    raw: value.trim(),
    ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s),
    tzid: z ? "UTC" : params.TZID ?? null,
  };
}

/**
 * @param {string} text содержимое части text/calendar
 * @returns {{ method: string|null, items: object[] }}
 */
export function parseCalendar(text) {
  let method = null;
  const items = [];
  const stack = [];
  let cur = null;

  for (const line of unfold(text)) {
    if (!line.trim()) continue;
    const p = parseLine(line);
    if (!p) continue;

    if (p.name === "BEGIN") {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      // Вложенные VALARM и прочее не порождают отдельных записей.
      if (KINDS[comp] && stack.filter((c) => KINDS[c]).length === 1) {
        cur = { kind: KINDS[comp], attendees: [] };
      }
      continue;
    }
    if (p.name === "END") {
      const comp = stack.pop();
      if (KINDS[comp] && cur && !stack.some((c) => KINDS[c])) {
        if (cur.uid) items.push(cur);
        cur = null;
      }
      continue;
    }

    const top = stack[stack.length - 1];
    if (top === "VCALENDAR" && p.name === "METHOD") {
      method = p.value.trim().toUpperCase();
      continue;
    }
    // Свойства вложенных компонентов (VALARM) встречу не описывают.
    if (!cur || !KINDS[top]) continue;

    switch (p.name) {
      case "UID": cur.uid = p.value.trim(); break;
      case "SEQUENCE": cur.sequence = Number(p.value) || 0; break;
      case "RECURRENCE-ID": cur.recurrenceId = p.value.trim(); break;
      case "SUMMARY": cur.summary = unescapeText(p.value); break;
      case "LOCATION": cur.location = unescapeText(p.value); break;
      case "DESCRIPTION": cur.description = unescapeText(p.value); break;
      case "STATUS": cur.status = p.value.trim().toUpperCase(); break;
      case "DTSTART": cur.start = parseTime(p.value, p.params); break;
      case "DTEND": cur.end = parseTime(p.value, p.params); break;
      case "DUE": cur.due = parseTime(p.value, p.params); break;
      case "ORGANIZER": cur.organizer = normalizeAddress(p.value); break;
      case "ATTENDEE": {
        const email = normalizeAddress(p.value);
        if (email) {
          const a = { email };
          if (p.params.PARTSTAT) a.partstat = p.params.PARTSTAT.toUpperCase();
          cur.attendees.push(a);
        }
        break;
      }
      default: break;
    }
  }
  return { method, items };
}
