// Поддельный Thunderbird 115. Воспроизводит те свойства API, из-за которых
// проход и пишется именно так:
//
//   · `MessageHeader.id` выдаётся на сессию — `restart()` раздаёт письмам
//     другие номера, как настоящий клиент после перезапуска;
//   · `continueList(id)` работает только с идентификатором живой сессии;
//   · сравнение дат в запросе — строгое с обеих сторон. Это худший из
//     возможных вариантов семантики, и проход обязан его переживать
//     (настоящий 115 сравнивает включительно, с точностью до секунды);
//   · страница MessageList фиксированная, `messagesPerPage` в 115 ещё нет;
//   · `getFull` работает только с номером живой сессии и отдаёт дерево
//     частей без contentDisposition — его, как в 115, надо брать из
//     заголовков части; тело приложенного .ics — только через
//     `getAttachmentFile`.

const PAGE_SIZE = 100;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FakeThunderbird {
  constructor() {
    this.accounts = [];
    this.folders = [];          // {accountId, path, name, type, messages: []}
    this.lists = new Map();
    this.idBase = 1000;
    this.uid = 0;
    this.queries = 0;
    this.pages = 0;
    this.onPage = null;         // хук для тестов: обрыв посреди прохода
    this.failFolders = new Set();
    this.fullReads = 0;
    this.fullLog = [];          // даты прочитанных getFull писем, по порядку
    this.onFull = null;         // хук: обрыв посреди обогащения
    this.failFull = null;       // (m) => true — сервер не отдаёт письмо
  }

  addAccount(id, name = id, identities = []) {
    this.accounts.push({ id, name, type: "imap",
      identities: identities.map((email) => ({ email })) });
    return this;
  }

  /** Письмо удалено или перенесено: из папки пропадает, номер умирает. */
  removeMessage(folder, m) {
    folder.messages = folder.messages.filter((x) => x !== m);
    m.removed = true;
  }

  addFolder(accountId, path, { name, type } = {}) {
    const f = {
      accountId, path,
      name: name ?? path.split("/").filter(Boolean).pop() ?? path,
      type: type ?? undefined,
      messages: [],
    };
    this.folders.push(f);
    return f;
  }

  addMessage(folder, rec) {
    const m = { uid: ++this.uid, ...rec };
    folder.messages.push(m);
    return m;
  }

  /** Перезапуск клиента: номера писем другие, списки страниц мертвы. */
  restart() {
    this.lists.clear();
    this.idBase += 1_000_000;
    this.shuffleSeed = (this.shuffleSeed ?? 1) + 1;
    this.#ids = null;
    this.#byId = null;
    return this;
  }

  #ids = null;
  #byId = null;

  #idOf(m) {
    if (!this.#ids) {
      // Номера раздаются в порядке, не совпадающем с прошлой сессией.
      const all = this.folders.flatMap((f) => f.messages);
      const rnd = mulberry32(this.shuffleSeed ?? 1);
      const order = all.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]);
      this.#ids = new Map();
      this.#byId = new Map();
      order.forEach(([, x], i) => {
        this.#ids.set(x.uid, this.idBase + i);
        this.#byId.set(this.idBase + i, x);
      });
    }
    return this.#ids.get(m.uid);
  }

  #byNumber(id) {
    if (!this.#byId) this.#idOf({ uid: -1 });
    return this.#byId.get(id);
  }

  /** MessagePart, как его отдаёт getFull в 115. */
  #full(m) {
    const headers = {
      "message-id": m.mid ? [m.mid] : [],
      from: [m.author ?? ""],
      subject: [m.subject ?? ""],
      date: [new Date(m.date).toUTCString()],
    };
    for (const [k, v] of Object.entries(m.headers ?? {})) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v : [v];
    }
    const strip = (p) => {
      // Содержимое файла вложения в getFull не приходит.
      const { content, ...rest } = p;
      if (rest.parts) rest.parts = rest.parts.map(strip);
      return rest;
    };
    const parts = m.parts ?? [{
      contentType: "text/plain", partName: "1", headers: {},
      body: m.body ?? "", size: (m.body ?? "").length,
    }];
    return {
      contentType: "message/rfc822", partName: "", size: m.size ?? 0,
      headers, parts: m.headersOnly ? [] : parts.map(strip),
    };
  }

  #part(parts, partName) {
    for (const p of parts ?? []) {
      if (p.partName === partName) return p;
      const inner = this.#part(p.parts, partName);
      if (inner) return inner;
    }
    return null;
  }

  #folder(spec) {
    return this.folders.find(
      (f) => f.accountId === spec.accountId && f.path === spec.path);
  }

  #header(m, f) {
    return {
      id: this.#idOf(m),
      headerMessageId: m.mid ?? undefined,
      date: new Date(m.date),
      author: m.author ?? "",
      recipients: m.recipients ?? [],
      ccList: m.ccList ?? [],
      bccList: m.bccList ?? [],
      subject: m.subject ?? "",
      size: m.size ?? 0,
      flagged: Boolean(m.flagged),
      read: Boolean(m.read),
      junk: Boolean(m.junk),
      junkScore: m.junkScore ?? 0,
      tags: m.tags ?? [],
      folder: { accountId: f.accountId, path: f.path, name: f.name, type: f.type },
    };
  }

  #page(rest) {
    this.pages++;
    const chunk = rest.splice(0, PAGE_SIZE);
    let id = null;
    if (rest.length) {
      id = `list-${this.idBase}-${this.lists.size + 1}`;
      this.lists.set(id, rest);
    }
    if (this.onPage) this.onPage(this);
    return { id, messages: chunk };
  }

  /** Дерево папок, как его отдаёт accounts.list в 115: вложенным. */
  #tree(accountId) {
    const own = this.folders.filter((f) => f.accountId === accountId)
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    const nodes = new Map();
    const roots = [];
    for (const f of own) {
      const node = { accountId, path: f.path, name: f.name, type: f.type, subFolders: [] };
      nodes.set(f.path, node);
      const parent = f.path.slice(0, f.path.lastIndexOf("/"));
      const p = parent && nodes.get(parent);
      if (p) p.subFolders.push(node); else roots.push(node);
    }
    return roots;
  }

  get api() {
    const tb = this;
    return {
      accounts: {
        async list(_includeFolders = true) {
          return tb.accounts.map((a) => ({ ...a, folders: tb.#tree(a.id) }));
        },
      },
      folders: {
        async getSubFolders(folder) { return tb.#tree(folder.accountId); },
        async getFolderInfo(folder) {
          const f = tb.#folder(folder);
          if (!f) throw new Error("NotFoundError");
          return { totalMessageCount: f.messages.length, unreadMessageCount: 0 };
        },
      },
      messages: {
        async query(queryInfo) {
          tb.queries++;
          const f = tb.#folder(queryInfo.folder ?? {});
          if (!f) throw new Error(`NotFoundError: ${JSON.stringify(queryInfo.folder)}`);
          if (tb.failFolders.has(`${f.accountId}|${f.path}`)) {
            throw new Error("папка недоступна");
          }

          const from = queryInfo.fromDate ? queryInfo.fromDate.getTime() : null;
          const to = queryInfo.toDate ? queryInfo.toDate.getTime() : null;

          // Строго с обеих сторон — намеренно пессимистичный вариант.
          const hit = f.messages.filter((m) =>
            (from == null || m.date > from) && (to == null || m.date < to));

          return tb.#page(hit.map((m) => tb.#header(m, f)));
        },
        async continueList(listId) {
          const rest = tb.lists.get(listId);
          if (!rest) throw new Error(`NotFoundError: список ${listId} недействителен`);
          tb.lists.delete(listId);
          return tb.#page(rest);
        },
        async getFull(id) {
          const m = tb.#byNumber(id);
          if (!m || m.removed) throw new Error(`Message not found: ${id}`);
          if (tb.failFull?.(m)) throw new Error("Сервер не отдал письмо");
          tb.fullReads++;
          tb.fullLog.push(m.date);
          tb.onFull?.(tb, m);
          return JSON.parse(JSON.stringify(tb.#full(m)));
        },
        async getAttachmentFile(id, partName) {
          const m = tb.#byNumber(id);
          const p = m && !m.removed ? tb.#part(m.parts, partName) : null;
          if (!p) throw new Error(`Part not found: ${partName}`);
          // File в 115; здесь достаточно его метода text().
          const text = p.content ?? p.body ?? "";
          return { name: p.name ?? "", type: p.contentType, size: text.length,
            text: async () => text };
        },
      },
    };
  }
}

/** Ящик с равномерно размазанной по годам перепиской. */
export function generate(tb, {
  accounts = 1, foldersPerAccount = 4, messages = 1000,
  spanDays = 1200, seed = 42, noMessageIdShare = 0, now = Date.now(),
} = {}) {
  const rnd = mulberry32(seed);
  const people = ["ivanov", "petrova", "sidorov", "kuznecov", "orlova"];
  const folders = [];

  for (let a = 0; a < accounts; a++) {
    const id = `account${a + 1}`;
    tb.addAccount(id, `Ящик ${a + 1}`, ["me@example.ru"]);
    folders.push(tb.addFolder(id, "/INBOX", { name: "Входящие", type: "inbox" }));
    for (let i = 1; i < foldersPerAccount; i++) {
      folders.push(tb.addFolder(id, `/INBOX/Проект${i}`, { name: `Проект ${i}` }));
    }
  }

  let n = 0;
  while (n < messages) {
    const f = folders[Math.floor(rnd() * folders.length)];
    const age = Math.floor(rnd() * spanDays * 86400000);
    const withoutMid = rnd() < noMessageIdShare;
    n++;
    tb.addMessage(f, {
      mid: withoutMid ? null : `<${n}.${seed}@example.ru>`,
      date: now - age,
      author: `${people[n % people.length]}@example.ru`,
      recipients: ["me@example.ru"],
      ccList: n % 5 === 0 ? ["team@example.ru"] : [],
      subject: `Тема ${n}`,
      size: 1000 + (n % 900),
    });
  }
  return tb;
}
