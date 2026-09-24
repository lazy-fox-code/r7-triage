// Граф дел на Canvas. Перенесён из прототипа дизайнера (холст «Дела —
// R7 Triage»): те же фигуры, значки, стили связей, раскладка фокуса и
// физика обзора. Данные — настоящие дела из cases.js.
//
// Рисуется на Canvas, а не элементами страницы: на графе до нескольких
// сотен дел и их элементов. Все цвета — из CSS-переменных страницы, так что
// светлая и тёмная темы задаются только в cases.css.

const STATES = {
  new: { c: "--st-new", name: "Новое", act: 1, glyph: "neu" },
  branch: { c: "--st-stale", name: "Ветка", act: 0.8, glyph: null },
  // Состояния, которые появятся с моделью (утверждены заказчиком).
  work: { c: "--st-work", name: "В работе", act: 0.88, glyph: "work" },
  wait: { c: "--st-wait", name: "Жду ответа", act: 0.72, glyph: "wait" },
  over: { c: "--st-over", name: "Просрочено", act: 1, glyph: "over" },
  done: { c: "--st-done", name: "Готово", act: 0.32, glyph: "done" },
  info: { c: "--st-info", name: "Информирование", act: 0.52, glyph: "info" },
  old: { c: "--st-stale", name: "Устарело", act: 0.24, glyph: "old" },
};
export const STATE_NAMES = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [k, v.name]));

// Монохромные глифы на сетке 24 px — те же контуры, что в SVG-спрайте.
const GLYPH = {
  mail: { w: 1.9, p: ["M2.6 6.2h18.8v11.6H2.6z", "M3 6.8 12 13.4l9-6.6"] },
  hand: { w: 1.7, p: ["M8 12.2V5.8a1.65 1.65 0 0 1 3.3 0v6.4",
    "M11.3 12.2V4.8a1.65 1.65 0 0 1 3.3 0v7.4",
    "M14.6 12.2V6.4a1.65 1.65 0 0 1 3.3 0v7.6c0 3.9-2.7 6.8-6.5 6.8-2 0-3.6-.7-4.8-2.1l-2.4-2.9a1.55 1.55 0 0 1 2.2-2.2l1.5 1.5"] },
  video: { w: 1.8, p: ["M2.6 6.4h13.2v11.2H2.6z", "m15.8 12 5.6-3.6v7.2z"] },
  alarm: { w: 1.8, p: ["M12 20.3a7 7 0 1 0 0-14 7 7 0 0 0 0 14", "M12 9.7v3.6l2.4 1.6",
    "M5.4 4.5 2.8 6.9", "M18.6 4.5l2.6 2.4", "M7 19.7l-1.5 1.9", "M17 19.7l1.5 1.9"] },
  chat: { w: 1.8, p: ["M20 12.3c0 3.5-3.6 6.3-8 6.3-.9 0-1.8-.1-2.6-.4L4.5 19.9l1.4-3.2A6.5 6.5 0 0 1 4 12.3C4 8.8 7.6 6 12 6s8 2.8 8 6.3z"] },
  clip: { w: 1.8, p: ["M19.4 11.5 12.3 18.5a4.2 4.2 0 1 1-6-6l7.2-7.1a2.75 2.75 0 0 1 3.9 3.9l-7.2 7.1a1.35 1.35 0 0 1-1.9-1.9l6.5-6.5"] },
  person: { w: 1.8, p: ["M12 11.6a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6", "M5.2 19.8c1-3.4 3.7-5.2 6.8-5.2s5.8 1.8 6.8 5.2"] },
  system: { w: 1.7, p: ["M3.6 4.8h16.8v5.4H3.6z", "M3.6 13.8h16.8v5.4H3.6z", "M6.8 7.5h3.2", "M6.8 16.5h3.2", "M17 7.5h.6", "M17 16.5h.6"] },
};

const TOKENS = ["--st-new", "--st-work", "--st-wait", "--st-over", "--st-done", "--st-info", "--st-stale",
  "--g-bg", "--g-link", "--g-link-person", "--g-label", "--g-label-2",
  "--g-node-stroke", "--g-dim", "--c-accent", "--c-text-2", "--c-surface", "--c-border-strong"];

const KIND_NAME = { deal: "Дело", branch: "Переписка", child: "Элемент", meet: "Встреча", task: "Задача",
  conf: "Конференция TrueConf", chat: "Беседа TrueConf", files: "Вложения", person: "Контакт",
  system: "Информационная система" };

export function plural(n, f) {
  const m = n % 100;
  const k = n % 10;
  return f[(m > 10 && m < 20) ? 2 : k === 1 ? 0 : (k >= 2 && k <= 4) ? 1 : 2];
}

const shortDate = (ms) => (ms ? new Date(ms).toLocaleString("ru-RU",
  { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

export function initials(name, email) {
  const src = (name || "").replace(/["«»]/g, "").trim();
  const parts = src.split(/\s+/).filter((p) => /^[\p{L}]/u.test(p));
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return String(email || "?").slice(0, 2).toUpperCase();
}

const artifacts = (c) => c.counts.mail + c.counts.meet + c.counts.conf + c.counts.task + (c.counts.files ? 1 : 0);

// Насколько дело просит внимания. Порядок важнее точного числа: он решает,
// что окажется в центре кадра, а что по краю.
const ATTENTION = { new: 1000, over: 900, wait: 700, work: 500, done: 200, branch: 300, info: 60, old: 20 };
const DAY_MS = 86400000;
function attention(c) {
  const days = Math.max(0, (Date.now() - c.lastAt) / DAY_MS);
  return (ATTENTION[c.state] ?? 100)
    + Math.min(120, (c.weight ?? 0) * 1.5)
    + Math.max(0, 60 - days * 2)
    + (c.systemOwner ? -300 : 0);
}
// Постоянный угол по строке: узел без прежней позиции встаёт на одно и то же
// место при каждом перестроении, а не куда выпадет случайное число.
function hashAngle(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}
const centroid = (ns) => ({ x: ns.reduce((s, n) => s + n.x, 0) / ns.length, y: ns.reduce((s, n) => s + n.y, 0) / ns.length });

const dealR = (c) => Math.max(8, Math.min(24, 6.5 + 3.2 * Math.sqrt(artifacts(c))));

/** Элементы дела для раскрытия на графе. */
function elementsOf(c, allPeople) {
  const out = [];
  const why = c.joinedBy.meeting ? "письма об одной встрече"
    : c.joinedBy.outlook && !c.joinedBy.thread ? "одна беседа Outlook" : "одна ветка писем";
  out.push({ t: "branch", g: "mail", n: c.counts.mail, open: c.counts.mail > 1,
    label: `Переписка · ${c.counts.mail} ${plural(c.counts.mail, ["письмо", "письма", "писем"])}`, why });
  for (const m of c.meetings) {
    out.push({ t: "meet", g: "hand", label: m.start ? `Встреча ${shortDate(m.start)}` : `Встреча «${m.summary}»`,
      why: m.cancelled ? "приглашение отменено" : `приглашение «${m.summary}»` });
  }
  for (const t of c.tasks) out.push({ t: "task", g: "alarm", label: `Задача · ${t.summary}`, why: "задача из письма" });
  for (const f of c.conferences) {
    out.push({ t: "conf", g: "video", label: `Конференция № ${f.id}`,
      why: `номер и тема конференции${f.topic ? ` «${f.topic}»` : ""}` });
  }
  if (c.counts.files) {
    out.push({ t: "files", g: "clip", n: c.counts.files, open: true,
      label: `Вложения · ${c.counts.files} ${plural(c.counts.files, ["документ", "документа", "документов"])}`,
      why: "вложения писем дела" });
  }
  // Контакты: писавшие в деле — всегда первые трое, остальные по переключателю.
  const people = allPeople ? c.people : c.people.filter((p) => p.wrote > 0).slice(0, 3);
  for (const p of people) {
    out.push({ t: "person", g: "person", ini: initials(p.name, p.email), label: p.name || p.email,
      why: p.wrote ? `писал в деле ${p.wrote} ${plural(p.wrote, ["раз", "раза", "раз"])}` : "в получателях писем дела",
      must: p.wrote > 0 });
  }
  return out;
}

function childrenOf(el, c) {
  if (el.t === "branch") {
    return c.letters.slice(-9).map((l) => ({ g: "mail", label: l.subject || "(без темы)",
      why: l.why, sub: shortDate(l.date), letterId: l.id }));
  }
  if (el.t === "files") {
    return c.files.slice(-9).map((f) => ({ g: "clip", label: f.name || "вложение",
      why: "вложение письма дела", sub: shortDate(f.date), letterId: f.messageId }));
  }
  return [];
}

export class CaseGraph {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} hooks onSelect(caseId|null), onTip(tip|null), onZoom(k), onOpenLetter(letterId)
   */
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.hooks = hooks;
    this.view = { x: 0, y: 0, k: 1 };
    this.cam = null;
    this.cam0set = false;
    this.nodes = [];
    this.links = [];
    this.index = {};
    this.paths = {};
    this.tokens = {};
    this.hoverId = null;
    this.hoverSet = null;
    this.hoverAt = 0;
    this.dropId = null;
    // Холст перерисовывается, только когда что-то изменилось или идёт
    // анимация: в покое граф не тратит процессор.
    this.dirty = true;
    this.animUntil = 0;
    this.textCache = new Map();
    this.alpha = 1;
    this.userMoved = false;
    this.data = { cases: [], cross: [], systems: [], selected: null, scope: "all", allPeople: false, expanded: new Set() };
    this.byId = new Map();
    this.readTokens();
    this.bindEvents();
    this.media = window.matchMedia?.("(prefers-color-scheme: dark)");
    this.media?.addEventListener?.("change", () => this.readTokens());
    const loop = () => { this.frame(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() { cancelAnimationFrame(this.raf); }

  invalidate() { this.dirty = true; }
  animate(ms) { this.animUntil = Math.max(this.animUntil, performance.now() + ms); }

  readTokens() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of TOKENS) this.tokens[k] = cs.getPropertyValue(k).trim();
    this.invalidate();
  }
  col(s) { return this.tokens[STATES[s]?.c ?? "--c-text-2"] || "#888"; }
  reduced() { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; }

  /** Новые данные. Позиции известных узлов сохраняются — граф не прыгает. */
  setData(data, { initial = false } = {}) {
    this.data = { ...this.data, ...data };
    this.byId = new Map(this.data.cases.map((c) => [c.id, c]));
    this.rebuild(initial);
  }

  pulse(caseId) {
    const n = this.index[caseId];
    if (n) { n.pulse = performance.now(); this.animate(650); }
  }

  /** Наведённый узел и его соседи: остальное приглушается. */
  setHover(id) {
    if (id === this.hoverId) return;
    if (id && !this.hoverId) { this.hoverAt = performance.now(); this.animate(160); }
    this.hoverId = id;
    this.hoverSet = id ? this.neighbours(id) : null;
    this.invalidate();
  }

  neighbours(id) {
    const s = new Set([id]);
    for (const l of this.links) {
      if (l.a === id) s.add(l.b);
      else if (l.b === id) s.add(l.a);
    }
    return s;
  }

  // --- модель графа ---------------------------------------------------------

  rebuild(initial) {
    const prev = {};
    for (const n of this.nodes) prev[n.id] = n;
    const bornNow = (initial || this.reduced()) ? 0 : performance.now();
    const nodes = [];
    const links = [];
    const { cases, cross, selected, allPeople, expanded } = this.data;
    const focus = selected ? this.byId.get(selected) : null;

    // Раскладка обзора: заполнение кадра по спирали от центра. В середине —
    // то, что требует внимания: новое, где ждут вашего ответа, крупные дела.
    // Уведомления систем и остывшее уходят на периферию: они фон, а не
    // работа.
    const order = [...cases].sort((a, b) => attention(b) - attention(a)).map((c) => c.id);
    const seat = new Map(order.map((id, i) => [id, i]));
    const aspect = this.canvas
      ? Math.max(0.6, Math.min(2.2, (this.canvas.clientWidth || 1200) / (this.canvas.clientHeight || 700)))
      : 1.6;
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    const spiral = (i) => {
      const r = 118 * Math.sqrt(i + 0.6);
      const a = i * GOLDEN;
      return { x: Math.cos(a) * r * aspect, y: Math.sin(a) * r };
    };

    cases.forEach((c) => {
      const p = prev[c.id] || spiral(seat.get(c.id) ?? 0);
      nodes.push({ id: c.id, t: "deal", role: focus ? (c === focus ? "center" : "far") : "deal",
        r: dealR(c), x: p.x, y: p.y, deal: c, state: c.state, label: c.title, count: artifacts(c),
        seat: seat.get(c.id) ?? 0,
        // Узел, поставленный рукой, остаётся там, куда его поставили.
        pinned: p.pinned, born: prev[c.id] ? (prev[c.id].born || 0) : bornNow, pulse: p.pulse || 0 });
    });

    if (focus) {
      elementsOf(focus, allPeople).forEach((e, i) => {
        const id = `${focus.id}|${e.t}${i}`;
        const p = prev[id] || { x: 0, y: 0 };
        nodes.push({ id, t: e.t, role: "el", g: e.g, r: 16, x: p.x, y: p.y, label: e.label, why: e.why,
          count: e.n, host: focus.id, state: focus.state, ini: e.ini, must: e.must,
          openable: Boolean(e.open), open: expanded.has(id), born: prev[id] ? (prev[id].born || 0) : bornNow });
        links.push({ a: focus.id, b: id, kind: e.t === "person" ? "person" : "elem", why: e.why,
          born: prev[id] ? 0 : bornNow });
        if (e.open && expanded.has(id)) {
          childrenOf(e, focus).forEach((ch, j) => {
            const cid = `${id}|c${j}`;
            const cp = prev[cid] || { x: 0, y: 0 };
            nodes.push({ id: cid, t: "child", role: "child", g: ch.g, r: 11, x: cp.x, y: cp.y,
              label: ch.label, why: ch.why, sub: ch.sub, host: id, state: focus.state, letterId: ch.letterId,
              born: prev[cid] ? (prev[cid].born || 0) : bornNow });
            links.push({ a: id, b: cid, kind: "thread", why: ch.why });
          });
        }
      });
    }

    const dealAt = new Map(nodes.map((n) => [n.id, n]));
    const vis = new Set(cases.map((c) => c.id));
    for (const l of cross) {
      if (vis.has(l.a) && vis.has(l.b)) links.push({ a: l.a, b: l.b, kind: l.kind, why: l.why });
    }

    // Информационная система — общий узел своих дел. Инциденты остаются
    // разными делами, но видно, что они от одной системы, и она держит их
    // вместе на графе.
    if (!focus) {
      for (const sys of this.data.systems ?? []) {
        const ids = sys.cases.filter((id) => vis.has(id));
        // Свёрнутая система — одна фишка с числом дел: её уведомления не
        // закрывают собой переписку. Развёрнутая держит свои дела рядом.
        const shown = sys.collapsed ? [] : ids;
        if (!sys.collapsed && ids.length < 2) continue;
        const count = sys.cases.length;
        // Система — фон: её место по краю кадра, а не в середине, — со
        // стороны её дел, чтобы связи к ним были короткими.
        let p = prev[sys.id];
        if (!p) {
          const ring = 118 * Math.sqrt(cases.length + 4) * 1.15;
          let ang = hashAngle(sys.id);
          const at = ids.map((id) => dealAt.get(id)).filter(Boolean);
          if (at.length) {
            const m = centroid(at);
            if (Math.hypot(m.x / aspect, m.y) > 40) ang = Math.atan2(m.y, m.x / aspect);
          }
          p = { x: Math.cos(ang) * ring * aspect, y: Math.sin(ang) * ring };
        }
        nodes.push({ id: sys.id, t: "system", role: "system", g: "system",
          r: sys.collapsed ? 15 : 13, x: p.x, y: p.y,
          label: sys.name, email: sys.email, count: sys.collapsed ? count : 0,
          collapsed: sys.collapsed, pinned: prev[sys.id]?.pinned,
          why: `${count} ${plural(count, ["дело", "дела", "дел"])} · ${sys.why}`,
          born: prev[sys.id] ? (prev[sys.id].born || 0) : bornNow });
        for (const id of shown) links.push({ a: sys.id, b: id, kind: "system", why: "письма одной системы" });
      }
    }

    // В обзоре контакты — только по переключателю и только общие для
    // нескольких дел: иначе граф тонет в людях.
    if (!focus && allPeople) {
      const seen = new Map();
      for (const c of cases) for (const p of c.people) if (p.wrote) {
        if (!seen.has(p.email)) seen.set(p.email, { p, cases: [] });
        seen.get(p.email).cases.push(c.id);
      }
      for (const { p, cases: ids } of seen.values()) {
        if (ids.length < 2) continue;
        const pid = `p:${p.email}`;
        // Контакт встаёт между своими делами, со сдвигом по своему адресу.
        let pp = prev[pid];
        if (!pp) {
          const m = centroid(ids.map((id) => dealAt.get(id)));
          const a = hashAngle(pid);
          pp = { x: m.x + Math.cos(a) * 26, y: m.y + Math.sin(a) * 26 };
        }
        nodes.push({ id: pid, t: "person", role: "person", g: "person", r: 10, x: pp.x, y: pp.y,
          label: p.name || p.email, why: `пишет в ${ids.length} ${plural(ids.length, ["деле", "делах", "делах"])}`,
          ini: initials(p.name, p.email), born: prev[pid] ? (prev[pid].born || 0) : bornNow });
        for (const id of ids) links.push({ a: pid, b: id, kind: "person", why: "автор писем дела" });
      }
    }

    this.nodes = nodes;
    this.links = links;
    this.index = {};
    for (const n of nodes) this.index[n.id] = n;
    this.focusId = focus ? focus.id : null;
    if (this.hoverId && !this.index[this.hoverId]) { this.hoverId = null; this.hoverSet = null; }
    else if (this.hoverId) this.hoverSet = this.neighbours(this.hoverId);
    if (bornNow) this.animate(300);
    this.invalidate();
    if (focus) { this.alpha = 0; this.layoutFocus(); }
    else {
      this.alpha = initial ? 1 : Math.max(this.alpha, 0.6);
      if (initial) { for (let s = 0; s < 260; s++) this.step(0.9); this.fit(); }
    }
  }

  /** Раскладка фокуса: элементы по часовой стрелке, прочие дела по краю кадра. */
  layoutFocus() {
    const c = this.index[this.focusId];
    if (!c || !this.canvas) return;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    c.x = 0; c.y = 0; c.rBig = Math.max(26, Math.min(44, c.r * 1.7));

    const els = this.nodes.filter((n) => n.role === "el");
    const n = els.length || 1;
    const Rring = Math.max(c.rBig + 80, n * 9.4 + 42);
    const start = -Math.PI / 2 + 0.24;
    const stepA = Math.PI * 2 / n;
    els.forEach((e, i) => {
      e.ang = start + i * stepA;
      e.x = Math.cos(e.ang) * Rring; e.y = Math.sin(e.ang) * Rring;
    });

    let outer = Rring;
    const kidsOf = els.map((e) => this.nodes.filter((k) => k.host === e.id));
    // Соседний раскрытый элемент делит промежуток пополам — веера не
    // налезают друг на друга; нераскрытый сосед отдаёт почти весь.
    const side = (j) => (n > 1 && kidsOf[(j + n) % n].length ? 0.45 : 0.9) * stepA;
    for (const [i, e] of els.entries()) {
      const kids = kidsOf[i];
      if (!kids.length) continue;
      const spread = Math.min(1.5, kids.length * 0.2, 2 * Math.min(side(i - 1), side(i + 1)));
      // Узкий веер уходит дальше от центра, чтобы фишки не слипались.
      const R2 = Math.max(Rring + 74, kids.length > 1 ? (kids.length - 1) * 30 / spread : 0);
      kids.forEach((k, j) => {
        const a = e.ang - spread / 2 + (kids.length > 1 ? j * (spread / (kids.length - 1)) : 0);
        k.x = Math.cos(a) * R2; k.y = Math.sin(a) * R2;
      });
      outer = Math.max(outer, R2);
    }

    const Rc = outer + 34;
    const k = Math.max(0.35, Math.min(1.8, Math.min((W - 110) / (2 * Rc), (H - 118) / (2 * Rc))));
    this.setCam(W / 2 + 6, H / 2 - 14, k);

    const linked = {};
    for (const l of this.links) {
      if (l.kind === "elem" || l.kind === "thread" || l.kind === "person") continue;
      if (l.a === this.focusId) linked[l.b] = true;
      if (l.b === this.focusId) linked[l.a] = true;
    }
    const rx = (W / 2) / k * 0.9;
    const ry = (H / 2) / k * 0.9;
    // Прочие дела встают по краю в том же порядке по кругу, в каком стояли:
    // связи от центра не перекрещиваются, а при смене дела края почти не
    // двигаются. Поворот всего круга подобран под прежние углы.
    const far = this.nodes.filter((x) => x.role === "far")
      .map((f) => ({ f, a0: Math.atan2(f.y / ry, f.x / rx) }))
      .sort((p, q) => p.a0 - q.a0);
    const fstep = Math.PI * 2 / Math.max(1, far.length);
    let sx = 0;
    let sy = 0;
    far.forEach(({ a0 }, i) => { sx += Math.cos(a0 - i * fstep); sy += Math.sin(a0 - i * fstep); });
    const base = far.length ? Math.atan2(sy, sx) : 0;
    far.forEach(({ f }, i) => {
      const a = base + i * fstep;
      f.x = Math.cos(a) * rx; f.y = Math.sin(a) * ry;
      f.linked = Boolean(linked[f.id]);
      f.rSmall = f.r * (f.linked ? 0.72 : 0.5);
    });
  }

  setCam(x, y, k) {
    if (this.reduced() || !this.cam0set) {
      this.cam0set = true; this.view.x = x; this.view.y = y; this.view.k = k; this.cam = null;
    } else {
      this.cam = { t0: performance.now(), dur: 420, fx: this.view.x, fy: this.view.y, fk: this.view.k, x, y, k };
    }
    this.userMoved = false;
    this.invalidate();
    this.hooks.onZoom?.(k);
  }

  /** Физика обзора: дела отталкиваются, связи тянут. */
  step(a) {
    const ns = this.nodes;
    for (let i = 0; i < ns.length; i++) {
      const n1 = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const n2 = ns[j];
        const dx = n2.x - n1.x;
        const dy = n2.y - n1.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const min = n1.r + n2.r + ((n1.t === "deal" && n2.t === "deal") ? 92 : 20);
        if (d < min) {
          const f = (min - d) / d * 0.28 * a;
          if (!n1.pinned) { n1.x -= dx * f; n1.y -= dy * f; }
          if (!n2.pinned) { n2.x += dx * f; n2.y += dy * f; }
        }
      }
    }
    for (const l of this.links) {
      const n1 = this.index[l.a];
      const n2 = this.index[l.b];
      if (!n1 || !n2) continue;
      const want = (l.kind === "person" || l.kind === "system") ? 140 : 250;
      const dx = n2.x - n1.x;
      const dy = n2.y - n1.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - want) / d * 0.08 * a;
      if (!n1.pinned) { n1.x += dx * f; n1.y += dy * f; }
      if (!n2.pinned) { n2.x -= dx * f; n2.y -= dy * f; }
    }
    for (const n of ns) {
      if (n.pinned) continue;
      // Лёгкая тяга к своему месту в спирали: свежие дела держатся центра,
      // остальные заполняют кадр и не сбиваются в ком.
      if (n.t === "deal" && n.seat != null) {
        const want = 118 * Math.sqrt(n.seat + 0.6);
        const d = Math.hypot(n.x, n.y) || 0.01;
        const f = (d - want) / d * 0.03 * a;
        n.x -= n.x * f; n.y -= n.y * f;
      }
      n.x -= n.x * 0.002 * a; n.y -= n.y * 0.002 * a;
    }
  }

  frame() {
    const c = this.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      if (this.focusId) this.layoutFocus(); else if (!this.userMoved) this.fit();
      this.invalidate();
    }
    const physics = !this.focusId && this.alpha > 0.004;
    if (!this.dirty && !this.cam && !physics && performance.now() >= this.animUntil) return;
    this.dirty = false;
    if (this.cam) {
      const t = (performance.now() - this.cam.t0) / this.cam.dur;
      if (t >= 1) { this.view.x = this.cam.x; this.view.y = this.cam.y; this.view.k = this.cam.k; this.cam = null; }
      else {
        const e = 1 - Math.pow(1 - t, 3);
        const C = this.cam;
        this.view.x = C.fx + (C.x - C.fx) * e; this.view.y = C.fy + (C.y - C.fy) * e; this.view.k = C.fk + (C.k - C.fk) * e;
      }
    }
    if (physics) {
      this.step(this.alpha); this.alpha *= 0.965;
      // Раскладка успокоилась — кадр подгоняется под то, где узлы оказались,
      // если вид не двигали руками.
      if (this.alpha <= 0.004 && !this.userMoved) this.fit();
    }
    this.draw(w, h, dpr);
  }

  // --- отрисовка --------------------------------------------------------------

  draw(w, h, dpr) {
    const ctx = this.ctx;
    const v = this.view;
    const T = this.tokens;
    const now = performance.now();
    const red = this.reduced();
    const onlySel = this.data.scope === "sel";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save(); ctx.translate(v.x, v.y); ctx.scale(v.k, v.k);

    const base = (n) => {
      if (!this.focusId) return n.t === "deal" ? (STATES[n.state]?.act ?? 0.8) : 0.8;
      if (n.role === "far") return onlySel ? 0 : (n.linked ? 0.85 : 0.3);
      return 1;
    };
    // Наведённый узел и его соседи — в полную силу, остальное приглушено.
    const hs = this.hoverSet;
    const hl = red ? 1 : Math.min(1, (now - this.hoverAt) / 140);
    const dim = hs ? 1 - (1 - (parseFloat(T["--g-dim"]) || 0.15)) * hl : 1;
    const vis = (n) => (hs && !hs.has(n.id) && n.id !== this.dropId ? base(n) * dim : base(n));

    for (const l of this.links) {
      const a = this.index[l.a];
      const b = this.index[l.b];
      if (!a || !b) continue;
      const on = hs && (l.a === this.hoverId || l.b === this.hoverId);
      const al = Math.min(base(a), base(b)) * (hs && !on ? dim : 1);
      if (al <= 0.01) continue;
      const own = l.kind === "elem" || l.kind === "thread";
      ctx.globalAlpha = on ? 1 : al * (own ? 0.6 : 0.85);
      ctx.beginPath();
      ctx.setLineDash(l.kind === "meet" ? [6, 4] : l.kind === "conf" ? [0.1, 4.5]
        : l.kind === "chat" ? [7, 3, 1.5, 3] : l.kind === "system" ? [3, 3] : []);
      ctx.lineCap = l.kind === "conf" ? "round" : "butt";
      ctx.lineWidth = (l.kind === "person" ? 0.6 : l.kind === "system" ? 0.8 : l.kind === "elem" ? 1.2 : l.kind === "thread" ? 1 : 1.7)
        + (on ? 0.8 : 0);
      ctx.strokeStyle = own ? this.col(a.state || "branch")
        : (l.kind === "person" || l.kind === "system") ? T["--g-link-person"] : T["--g-link"];
      ctx.moveTo(a.x, a.y);
      if (own || l.kind === "person" || l.kind === "system") {
        const grow = (l.born && !red) ? Math.min(1, (now - l.born) / 200) : 1;
        ctx.lineTo(a.x + (b.x - a.x) * grow, a.y + (b.y - a.y) * grow);
      } else {
        // Связи между делами слегка изогнуты: параллельные не сливаются и
        // реже идут сквозь чужие узлы. Изгиб пары всегда в одну сторону;
        // у длинных хорд он ограничен, чтобы они не выгибались через кадр.
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const s = (l.a < l.b ? 1 : -1) * Math.min(0.15, 40 / (Math.hypot(dx, dy) || 1));
        ctx.quadraticCurveTo((a.x + b.x) / 2 - dy * s, (a.y + b.y) / 2 + dx * s, b.x, b.y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;

    for (const n of this.nodes) {
      const al = vis(n);
      if (al <= 0.01) continue;
      const grow = (n.born && !red) ? Math.min(1, (now - n.born) / 250) : 1;
      ctx.globalAlpha = al * grow;
      if (n.t === "deal") this.drawDeal(ctx, n, grow, now, red);
      else this.drawChip(ctx, n, grow);
      if (this.hoverId === n.id || this.dropId === n.id) {
        ctx.globalAlpha = 1; ctx.beginPath();
        ctx.arc(n.x, n.y, (n.rBig || n.rSmall || n.r) + (this.dropId === n.id ? 10 : 6), 0, Math.PI * 2);
        ctx.lineWidth = this.dropId === n.id ? 2.5 : 1.5;
        ctx.strokeStyle = T["--c-accent"];
        ctx.setLineDash(this.dropId === n.id ? [4, 3] : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    this.drawLabels(ctx, vis);
    ctx.restore(); ctx.globalAlpha = 1;
  }

  /** Насколько подпись узла важна; null — узел не подписывается. */
  labelPriority(n) {
    const near = this.hoverSet?.has(n.id) ? 1e7 : 0;
    if (n.role === "center") return 1e9;
    if (n.id === this.hoverId) return 1e8;
    if (n.t === "deal") {
      // В фокусе дальние несвязанные дела не подписаны: они фон.
      if (n.role === "far" && !n.linked && !near) return null;
      return near + (n.linked ? 1e5 : 0) + 2000 + attention(n.deal);
    }
    if (n.role === "el") return near + 1e6;
    if (n.role === "child") return near + 5e5;
    if (n.role === "system") return near + 1000 + Math.min(n.count, 500);
    // Общие контакты обзора подписываются только рядом с наведённым.
    if (n.role === "person") return near || null;
    return null;
  }

  // Подписи ставятся по важности: каждая следующая — только если не ложится
  // на уже поставленные и на чужие узлы (сначала под узлом, потом над ним).
  // Шрифт на экране не мельче base − 2 px: при отдалении подписей меньше,
  // а не мельче.
  drawLabels(ctx, vis) {
    const T = this.tokens;
    const k = this.view.k;
    const radius = (n) => n.rBig || n.rSmall || (n.t === "deal" ? n.r : n.r * 1.35);
    const cands = [];
    const obstacles = [];
    const hs = this.hoverSet;
    for (const n of this.nodes) {
      const al = vis(n);
      if (al <= 0.05) continue;
      // При наведении подписаны только подсвеченные — приглушённые им не мешают.
      if (hs && !hs.has(n.id) && n.role !== "center") continue;
      if (!(n.role === "far" && !n.linked)) obstacles.push(n);
      const pr = this.labelPriority(n);
      if (pr != null) cands.push({ n, al, pr });
    }
    cands.sort((a, b) => b.pr - a.pr);
    const placed = [];
    // Видимая часть мира: подпись не уходит за край кадра.
    const vx0 = -this.view.x / k;
    const vy0 = -this.view.y / k;
    const vx1 = vx0 + this.canvas.clientWidth / k;
    const vy1 = vy0 + this.canvas.clientHeight / k;
    const inView = (r) => r.y >= vy0 && r.y + r.h <= vy1;
    const free = (r, own) => inView(r) && placed.every((q) => r.x + r.w < q.x || q.x + q.w < r.x || r.y + r.h < q.y || q.y + q.h < r.y)
      && obstacles.every((o) => {
        if (o === own) return true;
        const R = radius(o);
        const cx = Math.max(r.x, Math.min(o.x, r.x + r.w));
        const cy = Math.max(r.y, Math.min(o.y, r.y + r.h));
        return (o.x - cx) ** 2 + (o.y - cy) ** 2 > R * R;
      });

    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const { n, al, pr } of cands) {
      const center = n.role === "center";
      const size = center ? 12 : n.t === "deal" ? 11 : n.role === "child" ? 9 : 10;
      const weight = center ? "600 " : "";
      const maxW = center ? 280 : n.role === "child" ? 140 : 175;
      const fit = this.fitText(ctx, n.label, `${weight}${size}px system-ui`, maxW);
      const fs = Math.max(size, (size - 2) / k);
      const sc = fs / size;
      const pad = 4 * sc;
      const w = fit.w * sc + pad * 2;
      const h = fs * 1.45;
      const R = radius(n);
      const x = Math.max(vx0 + 2 / k, Math.min(vx1 - w - 2 / k, n.x - w / 2));
      const below = { x, y: n.y + R + 3 * sc, w, h };
      const above = { x, y: n.y - R - 3 * sc - h, w, h };
      let r = free(below, n) ? below : free(above, n) ? above : null;
      if (!r) {
        if (pr < 1e8) continue;
        r = below;
      }
      placed.push(r);
      ctx.globalAlpha = Math.min(1, al * 1.2) * 0.8;
      ctx.fillStyle = T["--g-bg"];
      ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, 3 * sc); ctx.fill();
      ctx.globalAlpha = Math.min(1, al * 1.2);
      ctx.font = `${weight}${fs}px system-ui`;
      ctx.fillStyle = center ? T["--g-label"] : T["--g-label-2"];
      ctx.fillText(fit.text, r.x + w / 2, r.y + h / 2 + 0.5 * sc);
    }
  }

  /** Текст, урезанный с многоточием до ширины (в пикселях шрифта font). */
  fitText(ctx, s, font, maxW) {
    const key = `${font}\n${maxW}\n${s}`;
    const hit = this.textCache.get(key);
    if (hit) return hit;
    ctx.font = font;
    let text = s;
    if (ctx.measureText(s).width > maxW) {
      let lo = 0;
      let hi = s.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(`${s.slice(0, mid).trimEnd()}…`).width <= maxW) lo = mid; else hi = mid - 1;
      }
      text = `${s.slice(0, lo).trimEnd()}…`;
    }
    const out = { text, w: ctx.measureText(text).width };
    if (this.textCache.size > 3000) this.textCache.clear();
    this.textCache.set(key, out);
    return out;
  }

  drawDeal(ctx, n, grow, now, red) {
    const T = this.tokens;
    const fill = this.col(n.state);
    const r = (n.rBig || n.rSmall || n.r) * (0.6 + 0.4 * grow);
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = T["--g-node-stroke"]; ctx.stroke();
    if (n.state === "over") {
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.5, 0, Math.PI * 2);
      ctx.lineWidth = 1.6; ctx.strokeStyle = fill; ctx.stroke();
    }
    if (r >= 11) this.stateGlyph(ctx, n, r);
    if (!this.focusId && r >= 13) this.badge(ctx, n.x + r * 0.72, n.y - r * 0.72, n.count, fill);
    if (n.pulse && !red && now - n.pulse < 600) {
      const p = (now - n.pulse) / 600;
      ctx.globalAlpha *= (1 - p) * 0.6; ctx.beginPath();
      ctx.arc(n.x, n.y, r + p * 18, 0, Math.PI * 2);
      ctx.lineWidth = 2; ctx.strokeStyle = fill; ctx.stroke();
    }
  }

  drawChip(ctx, n, grow) {
    const T = this.tokens;
    const c = (n.t === "person" || n.t === "system") ? T["--c-text-2"] : this.col(n.state);
    const r = n.r * (0.6 + 0.4 * grow);
    const x = n.x;
    const y = n.y;
    const key = n.t === "child" ? ({ mail: "mail", chat: "chat", clip: "files" }[n.g] || "mail") : n.t;
    let hw = r;
    let hh = r;
    let gs = r * 1.25;
    let gy = y;

    ctx.beginPath();
    if (key === "branch" || key === "mail") {
      hw = r * 1.32; hh = r * 0.92; gs = r * 1.12;
      ctx.ellipse(x, y, hw, hh, 0, 0, Math.PI * 2);
    } else if (key === "meet") {
      hw = r * 1.34; hh = r * 1.34; gs = r * 0.98;
      ctx.moveTo(x, y - hh); ctx.lineTo(x + hw, y); ctx.lineTo(x, y + hh); ctx.lineTo(x - hw, y);
      ctx.closePath();
      hw *= 0.72; hh *= 0.72;
    } else if (key === "conf") {
      hw = r * 1.24; hh = r * 1.24; gs = r * 1.04;
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + i * Math.PI / 3;
        ctx[i ? "lineTo" : "moveTo"](x + Math.cos(a) * hw, y + Math.sin(a) * hh);
      }
      ctx.closePath();
      hw *= 0.86;
    } else if (key === "chat") {
      const bw = r * 1.34;
      const bh = r * 0.94;
      const rd = bh * 0.6;
      hw = bw; hh = bh; gs = r * 0.94; gy = y - r * 0.06;
      ctx.moveTo(x - bw + rd, y - bh);
      ctx.lineTo(x + bw - rd, y - bh);
      ctx.quadraticCurveTo(x + bw, y - bh, x + bw, y - bh + rd);
      ctx.lineTo(x + bw, y + bh - rd);
      ctx.quadraticCurveTo(x + bw, y + bh, x + bw - rd, y + bh);
      ctx.lineTo(x - bw * 0.26, y + bh);
      ctx.lineTo(x - bw * 0.50, y + bh + r * 0.58);
      ctx.lineTo(x - bw * 0.56, y + bh);
      ctx.lineTo(x - bw + rd, y + bh);
      ctx.quadraticCurveTo(x - bw, y + bh, x - bw, y + bh - rd);
      ctx.lineTo(x - bw, y - bh + rd);
      ctx.quadraticCurveTo(x - bw, y - bh, x - bw + rd, y - bh);
      ctx.closePath();
    } else if (key === "task") {
      hw = r * 1.24; hh = r * 1.16; gs = r * 0.8; gy = y + r * 0.3;
      ctx.moveTo(x, y - hh * 1.1); ctx.lineTo(x + hw, y + hh * 0.78); ctx.lineTo(x - hw, y + hh * 0.78);
      ctx.closePath();
      hw *= 0.74;
    } else if (key === "files") {
      const rd2 = r * 0.34;
      hw = r; hh = r; gs = r * 1.16;
      ctx.moveTo(x - r + rd2, y - r);
      ctx.arcTo(x + r, y - r, x + r, y + r, rd2);
      ctx.arcTo(x + r, y + r, x - r, y + r, rd2);
      ctx.arcTo(x - r, y + r, x - r, y - r, rd2);
      ctx.arcTo(x - r, y - r, x + r, y - r, rd2);
      ctx.closePath();
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = T["--c-surface"]; ctx.fill();
    ctx.lineWidth = n.must ? 2.2 : 1.6; ctx.strokeStyle = c; ctx.stroke();

    if (n.t === "person" && n.ini) {
      ctx.fillStyle = c; ctx.font = `600 ${Math.round(r * 0.78)}px system-ui`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(n.ini, x, y + 0.5);
    } else {
      this.icon(ctx, n.g, x, gy, gs, c);
    }
    if (n.count && (n.openable || n.t === "system")) this.badge(ctx, x + hw * 0.92, y - hh * 0.86, n.count, c);
    if (n.openable) {
      const px = x - hw * 0.92;
      const py = y + hh * 0.86;
      ctx.beginPath(); ctx.arc(px, py, 5.6, 0, Math.PI * 2);
      ctx.fillStyle = T["--c-surface"]; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = c; ctx.stroke();
      ctx.beginPath(); ctx.lineWidth = 1.4; ctx.strokeStyle = c; ctx.lineCap = "round";
      ctx.moveTo(px - 2.5, py); ctx.lineTo(px + 2.5, py);
      if (!n.open) { ctx.moveTo(px, py - 2.5); ctx.lineTo(px, py + 2.5); }
      ctx.stroke();
    }
  }

  badge(ctx, x, y, num, c) {
    const T = this.tokens;
    const s = String(num);
    const w = Math.max(9, 4.4 + s.length * 3.4);
    ctx.beginPath();
    ctx.moveTo(x - w + 7, y - 7); ctx.arcTo(x + w, y - 7, x + w, y + 7, 7);
    ctx.arcTo(x + w, y + 7, x - w, y + 7, 7); ctx.arcTo(x - w, y + 7, x - w, y - 7, 7);
    ctx.arcTo(x - w, y - 7, x + w, y - 7, 7); ctx.closePath();
    ctx.fillStyle = c; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = T["--g-node-stroke"]; ctx.stroke();
    ctx.fillStyle = T["--c-surface"]; ctx.font = "600 8.5px system-ui";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(s, x, y + 0.5);
  }

  icon(ctx, key, x, y, size, color) {
    const g = GLYPH[key];
    if (!g) return;
    if (!this.paths[key]) this.paths[key] = g.p.map((d) => new Path2D(d));
    const s = size / 24;
    ctx.save();
    ctx.translate(x - size / 2, y - size / 2); ctx.scale(s, s);
    ctx.strokeStyle = color; ctx.lineWidth = g.w; ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const p of this.paths[key]) ctx.stroke(p);
    ctx.restore();
  }

  stateGlyph(ctx, n, r) {
    const glyph = STATES[n.state]?.glyph;
    if (!glyph) return;
    const x = n.x;
    const y = n.y;
    const u = r * 0.42;
    ctx.save();
    ctx.strokeStyle = this.tokens["--g-node-stroke"]; ctx.fillStyle = this.tokens["--g-node-stroke"];
    ctx.lineWidth = Math.max(1.2, r * 0.15); ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    switch (glyph) {
      case "neu": ctx.arc(x, y, u * 0.62, 0, Math.PI * 2); ctx.fill(); break;
      case "work": ctx.moveTo(x - u * 0.5, y - u); ctx.lineTo(x + u * 0.9, y); ctx.lineTo(x - u * 0.5, y + u); ctx.closePath(); ctx.fill(); break;
      case "wait": ctx.moveTo(x - u, y - u); ctx.lineTo(x + u, y - u); ctx.lineTo(x - u, y + u); ctx.lineTo(x + u, y + u); ctx.stroke(); break;
      case "over": ctx.moveTo(x, y - u); ctx.lineTo(x, y + u * 0.25); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y + u * 0.8, Math.max(1, r * 0.09), 0, Math.PI * 2); ctx.fill(); break;
      case "done": ctx.moveTo(x - u * 0.8, y); ctx.lineTo(x - u * 0.1, y + u * 0.7); ctx.lineTo(x + u * 0.85, y - u * 0.7); ctx.stroke(); break;
      case "info": ctx.arc(x, y - u * 0.75, Math.max(1, r * 0.09), 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x, y - u * 0.15); ctx.lineTo(x, y + u * 0.85); ctx.stroke(); break;
      default: ctx.moveTo(x - u * 0.8, y); ctx.lineTo(x + u * 0.8, y); ctx.stroke();
    }
    ctx.restore();
  }

  // --- ввод ------------------------------------------------------------------

  bindEvents() {
    const el = this.canvas;
    // Взяли узел — тянем узел; взяли пустое место — тянем всё полотно.
    // Дело, брошенное на другое дело, предлагает их объединить.
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      const p = this.toWorld(e);
      const node = this.hit(p.x, p.y);
      drag = {
        x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y,
        node, moved: false,
        // Узел тянем за ту точку, за которую взяли, — он не прыгает под курсор.
        grab: node ? { dx: node.x - p.x, dy: node.y - p.y } : null,
      };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = node ? "grabbing" : "move";
    });
    el.addEventListener("pointermove", (e) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          drag.moved = true;
          this.cam = null;
          if (drag.node) {
            const p = this.toWorld(e);
            drag.node.x = p.x + drag.grab.dx;
            drag.node.y = p.y + drag.grab.dy;
            drag.node.pinned = true;
            // Что под курсором: цель для объединения дел.
            const over = this.hit(p.x, p.y, drag.node);
            this.dropId = (drag.node.t === "deal" && over?.t === "deal") ? over.id : null;
          } else {
            this.userMoved = true;
            this.view.x = drag.vx + dx; this.view.y = drag.vy + dy;
          }
          this.invalidate();
        }
        return;
      }
      const p = this.toWorld(e);
      const n = this.hit(p.x, p.y);
      const id = n ? n.id : null;
      el.style.cursor = n ? "grab" : "default";
      if (id !== this.hoverId) {
        this.setHover(id);
        const r = el.getBoundingClientRect();
        this.hooks.onTip?.(n ? { title: n.label, sub: this.tipSub(n),
          x: Math.min(r.width - 270, e.clientX - r.left + 14), y: e.clientY - r.top + 14 } : null);
      }
    });
    el.addEventListener("pointerup", () => {
      el.style.cursor = "default";
      if (drag && !drag.moved && drag.node) this.pickNode(drag.node);
      if (drag?.moved && drag.node && this.dropId) {
        this.hooks.onMerge?.(drag.node.id, this.dropId);
      }
      this.dropId = null;
      drag = null;
      this.invalidate();
    });
    el.addEventListener("pointerleave", () => {
      drag = null; this.dropId = null; this.setHover(null);
      el.style.cursor = "default";
      this.hooks.onTip?.(null);
    });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const k = Math.max(0.3, Math.min(3.2, this.view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
      this.cam = null;
      this.view.x = mx - (mx - this.view.x) * (k / this.view.k);
      this.view.y = my - (my - this.view.y) * (k / this.view.k);
      this.view.k = k; this.userMoved = true; this.invalidate(); this.hooks.onZoom?.(k);
    }, { passive: false });
    el.addEventListener("keydown", (e) => this.onKey(e));
  }

  toWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    const v = this.view;
    return { x: (e.clientX - r.left - v.x) / v.k, y: (e.clientY - r.top - v.y) / v.k };
  }

  hit(x, y, except = null) {
    let best = null;
    let bd = 1e9;
    for (const n of this.nodes) {
      if (n === except) continue;
      const R = (n.rBig || n.rSmall || (n.t === "deal" ? n.r : n.r * 1.3)) + 6;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < R && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  tipSub(n) {
    const kind = KIND_NAME[n.t] || "Элемент";
    if (n.t === "system") return `${kind} · ${n.why} · нажмите, чтобы открыть таблицу`;
    if (n.t === "deal") {
      const c = n.deal;
      return `${kind} · ${STATES[n.state]?.name ?? ""} · ${c.counts.mail} ${plural(c.counts.mail, ["письмо", "письма", "писем"])}` +
        (c.counts.meet ? ` · встреч ${c.counts.meet}` : "") + (c.counts.conf ? ` · конференций ${c.counts.conf}` : "") +
        (c.object ? ` · ${c.object}` : "") + " · перетащите на другое дело, чтобы объединить";
    }
    return kind + (n.why ? ` · почему в деле: ${n.why}` : "") + (n.sub ? ` · ${n.sub}` : "") +
      (n.openable ? " · нажмите, чтобы развернуть" : "") + (n.letterId ? " · нажмите, чтобы открыть письмо" : "");
  }

  pickNode(n) {
    if (n.t === "deal") { this.hooks.onSelect?.(n.id); return; }
    if (n.t === "system") { this.hooks.onPickSystem?.(n.email); return; }
    if (n.letterId) { this.hooks.onOpenLetter?.(n.letterId); return; }
    if (n.openable) {
      const ex = new Set(this.data.expanded);
      if (ex.has(n.id)) ex.delete(n.id); else ex.add(n.id);
      this.setData({ expanded: ex });
    }
  }

  fit() {
    if (!this.nodes.length) return;
    if (this.focusId) { this.layoutFocus(); return; }
    let x0 = 1e9; let y0 = 1e9; let x1 = -1e9; let y1 = -1e9;
    for (const n of this.nodes) {
      const R = n.rBig || n.rSmall || n.r;
      x0 = Math.min(x0, n.x - R); y0 = Math.min(y0, n.y - R); x1 = Math.max(x1, n.x + R); y1 = Math.max(y1, n.y + R);
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const k = Math.max(0.3, Math.min(2, Math.min((w - 90) / (x1 - x0 || 1), (h - 90) / (y1 - y0 || 1))));
    this.setCam(w / 2 - (x0 + x1) / 2 * k, h / 2 - (y0 + y1) / 2 * k, k);
  }

  zoomBy(f) {
    const v = this.view;
    const w = this.canvas.clientWidth / 2;
    const h = this.canvas.clientHeight / 2;
    const k = Math.max(0.3, Math.min(3.2, v.k * f));
    this.cam = null;
    v.x = w - (w - v.x) * (k / v.k); v.y = h - (h - v.y) * (k / v.k); v.k = k;
    this.userMoved = true; this.invalidate(); this.hooks.onZoom?.(k);
  }

  onKey(e) {
    const k = e.key;
    if (k === "+" || k === "=") { e.preventDefault(); this.zoomBy(1.15); }
    else if (k === "-") { e.preventDefault(); this.zoomBy(0.87); }
    else if (k === "Escape") { this.hooks.onSelect?.(null); }
    else if (k === "Enter") {
      e.preventDefault();
      const n = this.index[this.hoverId];
      if (n) this.pickNode(n);
    } else if (k.startsWith("Arrow")) {
      e.preventDefault();
      const cur = this.index[this.data.selected] || this.nodes.find((n) => n.t === "deal");
      if (!cur) return;
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
      let best = null;
      let bs = -1e9;
      for (const n of this.nodes) {
        if (n === cur || n.t !== "deal") continue;
        const dx = n.x - cur.x;
        const dy = n.y - cur.y;
        const len = Math.hypot(dx, dy) || 1;
        const dot = (dx * dir[0] + dy * dir[1]) / len;
        if (dot < 0.5) continue;
        const score = dot * 400 - len * 0.4;
        if (score > bs) { bs = score; best = n; }
      }
      if (best) this.hooks.onSelect?.(best.id);
    }
  }
}
