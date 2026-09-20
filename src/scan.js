// Проход по ящику. Основа всего остального: пока он не переживает закрытие
// клиента без потерь и дублей, классификацию включать нельзя.
//
// Устройство курсора
// ------------------
// Готового курсора, который переживает перезапуск, в API нет. `messages.query`
// отдаёт MessageList, страницы которого листаются через `continueList(id)`, но
// этот id живёт внутри сессии: после перезапуска клиента он недействителен.
// Класть его в чекпойнт бессмысленно.
//
// Поэтому возобновляемая позиция выражена не через id страницы, а через дату.
// Папка разбирается окнами по дате, от свежих писем к старым; в чекпойнт
// пишется верхняя граница ещё не разобранной части. После перезапуска проход
// повторяет запрос от этой границы. Всё, что старше `floorYear`, забирается
// одним финальным запросом без нижней границы, так что письма с пустой или
// битой датой (они приходят как 1970 год) не теряются.
//
// Повторная обработка внутри одного окна безопасна и почти бесплатна: перед
// окном из IndexedDB одной выборкой по индексу `date` поднимается множество
// уже разобранных ключей, и сверка идёт в памяти, а не запросом на письмо.
//
// Перекрытие окон
// ---------------
// Соседние окна перекрываются на `overlapDays`. Причина: строгость сравнения
// дат в поиске Thunderbird документацией не зафиксирована, а исторически поиск
// по дате в Thunderbird работал с точностью до суток. При строгом сравнении
// письмо, попавшее ровно на границу окна, не вернул бы ни один из двух
// запросов — и потерялось бы молча. Сутки перекрытия закрывают оба варианта
// семантики; лишние письма отсекает дедупликация, она уже есть.
//
// Размер окна подстраивается под плотность переписки. Это влияет только на
// число запросов, не на полноту: окно любого размера обрабатывается целиком.
//
// Порядок разбора
// ---------------
// Внутри папки письма разбираются от свежих к старым, и проход можно
// ограничить снизу датой. На этом построены два независимых прохода:
//
//   recent  — последние `recentDays` суток во всех папках. Запускается при
//             старте клиента и на приход новой почты, занимает секунды.
//   archive — всё, что старше. Идёт только в простое и уступает дорогу
//             свежему проходу.
//
// Папки упорядочены так, что «Входящие» разбираются первыми: смысл свежего
// прохода в том, чтобы новое было размечено сразу после открытия клиента.

import {
  folderKey, parseFolderKey, messageKey, messageDate,
  normalizeAddress, displayName,
} from "./keys.js";

const DAY = 86400000;
const CHECKPOINT_VERSION = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

// Чем раньше разобрана папка, тем раньше пользователь видит результат.
const FOLDER_RANK = { inbox: 0, sent: 1, drafts: 3, archives: 4 };
const rank = (f) => FOLDER_RANK[f.type] ?? 2;

export class Scanner {
  #running = false;
  #stopped = false;
  #state = null;
  #startedAt = 0;
  #progress = null;

  /**
   * @param {object}   deps.browser  WebExtension API (внедряется ради тестов)
   * @param {object}   deps.db       модуль хранилища
   * @param {object}   deps.config   ветка `scan` из настроек
   * @param {Function} deps.onProgress
   */
  constructor({ browser, db, config, onProgress = () => {} }) {
    this.browser = browser;
    this.db = db;
    this.cfg = config;
    this.onProgress = onProgress;
  }

  get running() { return this.#running; }

  /** Просит проход остановиться. Чекпойнт уже на диске, потерь нет. */
  stop() { this.#stopped = true; }

  status() {
    return {
      running: this.#running,
      stopping: this.#running && this.#stopped,
      progress: this.#progress,
    };
  }

  /**
   * Полный проход. scanId позволяет держать несколько независимых проходов
   * (первичная индексация и инкрементальная доиндексация).
   */
  async run(scanId = "full", bounds = {}) {
    if (this.#running) return this.status();
    this.#running = true;
    this.#stopped = false;
    this.#startedAt = Date.now();

    try {
      let state = await this.db.checkpoint.load(scanId);
      if (!state || state.v !== CHECKPOINT_VERSION || state.done) {
        state = await this.#plan(scanId, bounds);
      }
      this.#state = state;
      state.resumedAt = Date.now();

      const done = new Set(state.doneFolders);
      for (const f of state.folders) {
        if (this.#stopped) break;
        if (done.has(f.key)) continue;

        try {
          await this.#scanFolder(f, state);
        } catch (e) {
          // Папку могли удалить или переименовать посреди многочасового
          // прохода, сетевая папка могла стать недоступной. Это не повод
          // ронять проход целиком — но и разобранной такая папка не стала,
          // поэтому в doneFolders она не попадает и будет повторена.
          state.errors.push({ folder: f.key, message: String(e?.message ?? e) });
          console.warn("r7-triage: папка пропущена", f.key, e);
          state.current = null;
          await this.#save(state);
          continue;
        }
        if (this.#stopped) break;

        done.add(f.key);
        state.doneFolders = [...done];
        state.current = null;
        await this.#save(state);
      }

      state.done = !this.#stopped && state.doneFolders.length === state.folders.length;
      if (state.done) state.finishedAt = Date.now();
      await this.#save(state);
      return this.status();
    } finally {
      this.#running = false;
      this.#emit();
    }
  }

  // --- план прохода ------------------------------------------------------

  async #plan(scanId, bounds = {}) {
    const startedAt = Date.now();
    const state = {
      v: CHECKPOINT_VERSION,
      scanId,
      // Верхняя граница первого окна. Письма, пришедшие позже, заберёт
      // следующий проход — отсюда же он и начнёт.
      startedAt,
      // Границы прохода по дате. `until` — откуда начинать спуск,
      // `since` — где остановиться; null означает «до самых старых».
      until: bounds.until ?? startedAt,
      since: bounds.since ?? null,
      folders: await this.#listFolders(),
      doneFolders: [],
      current: null,
      errors: [],
      stats: { headers: 0, stored: 0, merged: 0, duplicates: 0, queries: 0, pages: 0 },
      done: false,
    };
    await this.#save(state);
    return state;
  }

  /**
   * Папки всех учётных записей, в устойчивом порядке: индекс в чекпойнте
   * должен означать то же самое и после перезапуска.
   *
   * В Thunderbird 115 у MailFolder нет `id`, а `folders.query` появился
   * только в 121, поэтому обход идёт по дереву `account.folders`.
   */
  async #listFolders() {
    const accounts = await this.browser.accounts.list();
    const exclude = new Set(this.cfg.excludeFolderTypes ?? []);
    const seen = new Set();
    const out = [];

    const walk = (folders, account) => {
      for (const f of folders ?? []) {
        const key = folderKey({ accountId: f.accountId ?? account.id, path: f.path });
        // Корень учётной записи писем не содержит — запрос к нему пустой.
        if (!seen.has(key) && f.path && f.path !== "/" && !exclude.has(f.type)) {
          seen.add(key);
          out.push({
            key,
            name: f.name ?? f.path,
            path: f.path,
            type: f.type ?? null,
            account: account.name ?? account.id,
          });
        }
        if (f.subFolders?.length) walk(f.subFolders, account);
      }
    };

    for (const account of accounts) {
      let roots = account.folders;
      if (!roots?.length) {
        // Запасной путь на случай, если учётная запись отдала дерево пустым.
        try {
          roots = await this.browser.folders.getSubFolders(
            { accountId: account.id, path: "/" }, true);
        } catch { roots = []; }
      }
      walk(roots, account);
    }

    // Порядок устойчив (он же порядок возобновления) и при этом ставит
    // «Входящие» вперёд: свежий проход должен разметить новое сразу, а не
    // после того, как дойдёт до папок по алфавиту.
    out.sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  // --- папка -------------------------------------------------------------

  async #scanFolder(f, state) {
    const folder = parseFolderKey(f.key);
    const cfg = this.cfg;

    const cur = state.current?.key === f.key ? state.current : {
      key: f.key,
      cursorTo: state.until ?? state.startedAt,
      windowDays: cfg.initialWindowDays,
      covered: 0,
      total: null,
    };
    state.current = cur;

    if (cur.total == null) cur.total = await this.#folderTotal(folder);

    const floor = Date.UTC(cfg.floorYear, 0, 1);
    // Нижняя граница прохода. Для архивного прохода её нет, и последнее окно
    // уходит запросом без нижней границы — иначе письма с пустой или битой
    // датой (они приходят как 1970 год) не нашлись бы.
    const bottom = state.since == null ? floor : Math.max(state.since, floor);
    const openEnded = state.since == null;

    while (!this.#stopped && cur.cursorTo != null) {
      const to = cur.cursorTo;
      const rawFrom = to - cur.windowDays * DAY;
      const last = rawFrom <= bottom;
      const from = last ? (openEnded ? null : bottom) : rawFrom;

      const seen = await this.#window(folder, f, from, to, state, cur);

      // Курсор сдвигается только после того, как окно отработано целиком.
      // Остановку посреди окна нельзя принимать за пройденное окно: его
      // недочитанные страницы больше никто не запросит, и письма пропадут
      // молча. Прерванное окно повторяется целиком — это дёшево, потому что
      // уже записанное отсекается по множеству известных ключей.
      if (this.#stopped) break;

      cur.cursorTo = last ? null : from;
      cur.windowDays = this.#nextWindow(cur.windowDays, seen);
      await this.#save(state);
    }
  }

  /** Окно шире — меньше запросов; уже — меньше повторной работы при обрыве. */
  #nextWindow(days, seenCount) {
    const { targetPerWindow, minWindowDays, maxWindowDays } = this.cfg;
    if (seenCount > targetPerWindow) {
      return Math.max(minWindowDays, Math.round(days / 4));
    }
    if (seenCount < targetPerWindow / 4) {
      return Math.min(maxWindowDays, days * 4);
    }
    return days;
  }

  async #folderTotal(folder) {
    try {
      const info = await this.browser.folders.getFolderInfo(folder);
      return info?.totalMessageCount ?? null;
    } catch {
      return null;   // только для отображения прогресса, на полноту не влияет
    }
  }

  // --- окно --------------------------------------------------------------

  /** @returns {number} сколько заголовков вернул запрос (для подбора окна) */
  async #window(folder, f, from, to, state, cur) {
    const overlap = (this.cfg.overlapDays ?? 1) * DAY;
    const qFrom = from == null ? null : from - overlap;
    const qTo = to == null ? null : to + overlap;

    // Что из этого диапазона уже разобрано. Одна выборка по индексу вместо
    // запроса на каждое письмо — именно это делает повтор окна дешёвым.
    const known = new Map();
    for (const row of await this.db.messagesInDateRange(qFrom, qTo)) {
      known.set(row.id, row.locations ?? []);
    }

    // `folder` объектом, а не folderId: поля `folderId` в queryInfo
    // Thunderbird 115 ещё нет, оно появилось в 121.
    const query = { folder };
    if (qFrom != null) query.fromDate = new Date(qFrom);
    if (qTo != null) query.toDate = new Date(qTo);

    let page = await this.browser.messages.query(query);
    state.stats.queries++;

    let headers = 0;
    while (page) {
      const list = page.messages ?? [];
      headers += list.length;
      cur.covered += await this.#page(list, f.key, known, state);
      state.stats.pages++;

      // Чекпойнт после каждой страницы: он фиксирует прогресс и статистику.
      // Точка возобновления при этом — граница окна, поэтому обрыв посреди
      // окна стоит не больше одного повторного запроса.
      await this.#save(state);
      this.#emit(f);

      if (this.#stopped || !page.id) break;
      page = await this.browser.messages.continueList(page.id);
      if (this.cfg.throttleMs) await sleep(this.cfg.throttleMs);
    }
    return headers;
  }

  /** @returns {number} сколько писем этой папки закрыто страницей */
  async #page(list, fkey, known, state) {
    const rows = [];
    let covered = 0;

    for (const hdr of list) {
      const key = messageKey(hdr);
      const locs = known.get(key);

      if (locs) {
        if (locs.includes(fkey)) {
          state.stats.duplicates++;   // перекрытие окон или повтор после обрыва
          continue;
        }
        // Та же самая почта, но найденная ещё и в другой папке: копия в папке
        // проекта, виртуальная или объединённая папка. Вторая запись о письме
        // удвоила бы метрики графа, поэтому дописываем место хранения.
        const stored = await this.db.get("messages", key);
        if (stored) {
          stored.locations = uniq([...(stored.locations ?? []), fkey]);
          rows.push(stored);
          locs.push(fkey);
          state.stats.merged++;
          covered++;
          continue;
        }
        // Ключ известен, а записи нет — рассогласование. Пишем заново.
      }

      const row = this.#row(hdr, key, fkey, state.scanId);
      rows.push(row);
      known.set(key, row.locations);
      state.stats.stored++;
      covered++;
    }

    state.stats.headers += list.length;
    // Страница пишется одной транзакцией: либо она в базе целиком, либо нет.
    if (rows.length) await this.db.putMany("messages", rows);
    return covered;
  }

  /**
   * Запись о письме из одного лишь MessageHeader — без чтения тела.
   *
   * Сознательно не заполнены `threadId` и признаки автоматики: References,
   * In-Reply-To и List-* в MessageHeader не приходят, за ними нужен
   * `getFull`, а он читает письмо целиком и, если тела нет в офлайн-хранилище,
   * тянет его с сервера. Пятьдесят тысяч таких обращений — это не проход по
   * ящику, это выкачивание ящика. Их берёт на себя отдельный проход обогащения.
   */
  #row(hdr, key, fkey, scanId) {
    const to = uniq((hdr.recipients ?? []).map(normalizeAddress));
    const cc = uniq((hdr.ccList ?? []).map(normalizeAddress));
    const bcc = uniq((hdr.bccList ?? []).map(normalizeAddress));

    return {
      id: key,
      headerMessageId: hdr.headerMessageId ?? null,
      date: messageDate(hdr),
      subject: hdr.subject ?? "",
      sizeBytes: hdr.size ?? 0,

      fromId: normalizeAddress(hdr.author),
      fromName: displayName(hdr.author),

      // Списки храним как есть. Принадлежность к «Кому»/«Копия» для себя
      // не выводим здесь намеренно: набор своих адресов (алиасы,
      // делегированные ящики, списки рассылки) — отдельный вопрос T2,
      // и он не должен требовать повторного прохода по ящику.
      to, cc, bcc,
      recipientCount: to.length + cc.length,

      flagged: Boolean(hdr.flagged),
      read: Boolean(hdr.read),
      junk: Boolean(hdr.junk),
      junkScore: hdr.junkScore ?? null,
      tags: hdr.tags ?? [],

      locations: [fkey],

      threadId: null,
      // Число, а не булево: булевы значения не являются допустимыми ключами
      // IndexedDB, и по индексу такие записи просто не нашлись бы.
      enriched: 0,

      scanId,
      seenAt: Date.now(),
    };
  }

  // --- служебное ---------------------------------------------------------

  async #save(state) {
    await this.db.checkpoint.save(state.scanId, state);
  }

  #emit(folder = null) {
    const s = this.#state;
    if (!s) return;
    const elapsedMs = Date.now() - this.#startedAt;
    this.#progress = {
      scanId: s.scanId,
      running: this.#running,
      stopping: this.#stopped,
      done: Boolean(s.done),
      foldersDone: s.doneFolders.length,
      foldersTotal: s.folders.length,
      folder: folder ? `${folder.account} / ${folder.name}` : null,
      folderCovered: s.current?.covered ?? null,
      folderTotal: s.current?.total ?? null,
      stats: { ...s.stats },
      errors: s.errors.length,
      elapsedMs,
      rate: elapsedMs > 0 ? Math.round(s.stats.headers / (elapsedMs / 1000)) : 0,
    };
    try { this.onProgress(this.#progress); } catch { /* панель закрыта */ }
  }
}
