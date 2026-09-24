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
  "--g-node-stroke", "--c-accent", "--c-text-2", "--c-surface", "--c-border-strong"];

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
    this.dropId = null;
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

  readTokens() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of TOKENS) this.tokens[k] = cs.getPropertyValue(k).trim();
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
    if (n) n.pulse = performance.now();
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

    // Раскладка обзора: не кольцо, а заполнение кадра по спирали от центра,
    // и самые свежие дела — в середине. Так видно то, что происходит сейчас,
    // а не то, что первым попало в список.
    const order = [...cases].sort((a, b) => b.lastAt - a.lastAt).map((c) => c.id);
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
        const p = prev[sys.id] || { x: (Math.random() - 0.5) * 420, y: (Math.random() - 0.5) * 420 };
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
        const pp = prev[pid] || { x: (Math.random() - 0.5) * 420, y: (Math.random() - 0.5) * 420 };
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
    for (const e of els) {
      const kids = this.nodes.filter((k) => k.host === e.id);
      if (!kids.length) continue;
      const R2 = Rring + 74;
      const spread = Math.min(1.5, kids.length * 0.2);
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
    const far = this.nodes.filter((x) => x.role === "far");
    far.sort((a, b) => (linked[b.id] ? 1 : 0) - (linked[a.id] ? 1 : 0));
    const rx = (W / 2) / k * 0.9;
    const ry = (H / 2) / k * 0.9;
    far.forEach((f, i) => {
      const a = -Math.PI / 2 + (i + 0.5) * (Math.PI * 2 / Math.max(1, far.length));
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
    }
    if (this.cam) {
      const t = (performance.now() - this.cam.t0) / this.cam.dur;
      if (t >= 1) { this.view.x = this.cam.x; this.view.y = this.cam.y; this.view.k = this.cam.k; this.cam = null; }
      else {
        const e = 1 - Math.pow(1 - t, 3);
        const C = this.cam;
        this.view.x = C.fx + (C.x - C.fx) * e; this.view.y = C.fy + (C.y - C.fy) * e; this.view.k = C.fk + (C.k - C.fk) * e;
      }
    }
    if (!this.focusId && this.alpha > 0.004) { this.step(this.alpha); this.alpha *= 0.965; }
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

    const vis = (n) => {
      if (!this.focusId) return n.t === "deal" ? (STATES[n.state]?.act ?? 0.8) : 0.8;
      if (n.role === "far") return onlySel ? 0 : (n.linked ? 0.85 : 0.3);
      return 1;
    };

    for (const l of this.links) {
      const a = this.index[l.a];
      const b = this.index[l.b];
      if (!a || !b) continue;
      const al = Math.min(vis(a), vis(b));
      if (al <= 0.01) continue;
      ctx.globalAlpha = al * (l.kind === "elem" || l.kind === "thread" ? 0.6 : 0.85);
      ctx.beginPath();
      ctx.setLineDash(l.kind === "meet" ? [6, 4] : l.kind === "conf" ? [0.1, 4.5]
        : l.kind === "chat" ? [7, 3, 1.5, 3] : l.kind === "system" ? [3, 3] : []);
      ctx.lineCap = l.kind === "conf" ? "round" : "butt";
      ctx.lineWidth = l.kind === "person" ? 0.6 : l.kind === "system" ? 0.8 : l.kind === "elem" ? 1.2 : l.kind === "thread" ? 1 : 1.7;
      ctx.strokeStyle = (l.kind === "elem" || l.kind === "thread") ? this.col(a.state || "branch")
        : (l.kind === "person" || l.kind === "system") ? T["--g-link-person"] : T["--g-link"];
      const grow = (l.born && !red) ? Math.min(1, (now - l.born) / 200) : 1;
      ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + (b.x - a.x) * grow, a.y + (b.y - a.y) * grow);
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

    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const n of this.nodes) {
      const al = vis(n);
      if (al <= 0.05) continue;
      ctx.globalAlpha = Math.min(1, al * 1.2);
      if (n.t === "deal") {
        const R = n.rBig || n.rSmall || n.r;
        // В фокусе подписаны только связанные с выбранным делом — иначе
        // подписи дальних дел ложатся друг на друга.
        const big = n.role === "center" || n.linked || (n.role !== "far" && (n.r >= 15 || v.k > 1.3));
        if (!big) continue;
        const text = cut(n.label, n.role === "center" ? 40 : 26);
        ctx.font = (n.role === "center" ? "600 12px " : "11px ") + "system-ui";
        if (n.role === "center") {
          // Подложка: подпись выбранного дела читается поверх связей и фишек.
          const tw = ctx.measureText(text).width;
          ctx.save();
          ctx.globalAlpha *= 0.88;
          ctx.fillStyle = T["--g-bg"];
          ctx.fillRect(n.x - tw / 2 - 6, n.y + R + 4, tw + 12, 20);
          ctx.restore();
        }
        ctx.fillStyle = n.role === "center" ? T["--g-label"] : T["--g-label-2"];
        ctx.fillText(text, n.x, n.y + R + 7);
      } else if (n.role === "system") {
        ctx.font = "10px system-ui";
        ctx.fillStyle = T["--g-label-2"];
        ctx.fillText(cut(n.label, 26), n.x, n.y + n.r + 7);
      } else if (n.role === "el" || n.role === "child") {
        ctx.font = (n.role === "el" ? "10px " : "9px ") + "system-ui";
        ctx.fillStyle = T["--g-label-2"];
        ctx.fillText(cut(n.label, n.role === "el" ? 28 : 22), n.x, n.y + n.r + 6);
      }
    }
    ctx.restore(); ctx.globalAlpha = 1;
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
        }
        return;
      }
      const p = this.toWorld(e);
      const n = this.hit(p.x, p.y);
      const id = n ? n.id : null;
      el.style.cursor = n ? "grab" : "default";
      if (id !== this.hoverId) {
        this.hoverId = id;
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
    });
    el.addEventListener("pointerleave", () => {
      drag = null; this.dropId = null; this.hoverId = null;
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
      this.view.k = k; this.userMoved = true; this.hooks.onZoom?.(k);
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
    this.userMoved = true; this.hooks.onZoom?.(k);
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

function cut(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
