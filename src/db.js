// Хранилище. IndexedDB, потому что держит сотни тысяч записей и не требует
// установки внешних компонентов. Запросов поверх сырых данных не делаем:
// метрики графа считаются инкрементально при разборе письма.

import { folderKey } from "./keys.js";

const DB_NAME = "r7-triage";

// v2: ключи `messages` и `verdicts` переведены с идентификатора сессии
// Thunderbird на устойчивый ключ из keys.js. Старое содержимое этих хранилищ
// после такой смены бессмысленно — оно адресовано номерами, которых больше
// не существует, — поэтому миграция их очищает.
// v3: составной индекс очереди обогащения. Разобранное не трогает: индекс
// строится поверх уже записанных писем.
const DB_VERSION = 3;

const STORES = ["messages", "edges", "people", "verdicts", "tasks", "meta"];

let _opening = null;
let _db = null;

export function open() {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;

  _opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => migrate(req.result, e.oldVersion, req.transaction);
    req.onsuccess = () => {
      _db = req.result;
      // Другая вкладка или обновление расширения подняли версию: соединение
      // надо отпустить, иначе апгрейд заблокируется навсегда.
      _db.onversionchange = () => close();
      _db.onclose = () => { _db = null; };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB: апгрейд заблокирован другим соединением"));
  }).finally(() => { _opening = null; });

  return _opening;
}

export function close() {
  if (_db) { _db.close(); _db = null; }
}

function migrate(db, oldVersion, tx) {
  if (oldVersion < 2) {
    // Хранилища, ключи которых сменили природу, пересоздаём.
    for (const name of ["messages", "verdicts"]) {
      if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
    }

    // Разобранные письма. Ключ — устойчивый messageKey. Тело НЕ храним:
    // оно уже лежит в офлайн-хранилище Thunderbird, дублировать незачем.
    const messages = db.createObjectStore("messages", { keyPath: "id" });
    messages.createIndex("date", "date");
    messages.createIndex("threadId", "threadId");
    messages.createIndex("fromId", "fromId");
    // Одно письмо может лежать в нескольких папках (копия в папке проекта,
    // виртуальные и объединённые папки). multiEntry позволяет спросить
    // «что разобрано в этой папке», не заводя второй записи о письме.
    messages.createIndex("locations", "locations", { multiEntry: true });
    // Разобраны ли полные заголовки (References, List-*, вложения). Проход
    // T1 читает только то, что отдаёт MessageHeader, и ставит false.
    messages.createIndex("enriched", "enriched");

    if (!db.objectStoreNames.contains("edges")) {
      db.createObjectStore("edges", { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains("people")) {
      const people = db.createObjectStore("people", { keyPath: "id" });
      people.createIndex("level", "level");
    }

    const verdicts = db.createObjectStore("verdicts", { keyPath: "messageId" });
    verdicts.createIndex("label", "label");
    verdicts.createIndex("expiresAt", "expiresAt");

    if (!db.objectStoreNames.contains("tasks")) {
      const tasks = db.createObjectStore("tasks", {
        keyPath: "id", autoIncrement: true });
      tasks.createIndex("assigneeId", "assigneeId");
      tasks.createIndex("dueDate", "dueDate");
      tasks.createIndex("status", "status");
    }

    // Служебное: курсоры сканирования, настройки, версии промптов.
    if (!db.objectStoreNames.contains("meta")) {
      db.createObjectStore("meta", { keyPath: "key" });
    }
  }

  if (oldVersion < 3) {
    // Очередь прохода обогащения: письма с `enriched: 0`, от свежих к
    // старым. Составной ключ [состояние, дата] позволяет взять следующую
    // пачку курсором в обратном порядке, не поднимая в память весь ящик.
    tx.objectStore("messages").createIndex("enrichQueue", ["enriched", "date"]);
  }
}

// --- примитивы -----------------------------------------------------------

function request(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.onabort = () => reject(t.error ?? new Error("транзакция прервана"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(store, key) {
  return request(await open(), store, "readonly", (s) => s.get(key));
}

export async function put(store, value) {
  return request(await open(), store, "readwrite", (s) => s.put(value));
}

export async function count(store) {
  return request(await open(), store, "readonly", (s) => s.count());
}

export async function getAll(store, query, limit) {
  return request(await open(), store, "readonly",
    (s) => s.getAll(query ?? null, limit));
}

export async function getAllFromIndex(store, index, query, limit) {
  return request(await open(), store, "readonly",
    (s) => s.index(index).getAll(query ?? null, limit));
}

/**
 * Много выборок за одну транзакцию. Сборка дел поднимает ранние письма
 * сотнями ключей, и транзакция на каждый ключ обошлась бы дороже самих
 * чтений.
 *
 * @param {string[]} keys ключи записей (`getMany`) или значения индекса
 * @returns {Promise<object[]>} найденные записи, в одном списке
 */
export async function getMany(store, keys) {
  return manyRequests(store, keys, (s, key) => s.get(key));
}

export async function getAllFromIndexMany(store, index, values, limit) {
  return manyRequests(store, values,
    (s, v) => s.index(index).getAll(IDBKeyRange.only(v), limit));
}

async function manyRequests(store, values, fn) {
  if (!values.length) return [];
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const s = t.objectStore(store);
    const out = [];
    for (const v of values) {
      const req = fn(s, v);
      req.onsuccess = () => {
        const r = req.result;
        if (Array.isArray(r)) out.push(...r);
        else if (r !== undefined) out.push(r);
      };
    }
    t.oncomplete = () => resolve(out);
    t.onabort = () => reject(t.error ?? new Error("транзакция прервана"));
    t.onerror = () => reject(t.error);
  });
}

/**
 * Чтение и запись одной записи в одной транзакции. Проход обогащения
 * дописывает поля к письму, и перечитать его нужно в той же транзакции:
 * иначе можно затереть то, что успел дописать проход по ящику (например,
 * новое место хранения).
 *
 * @param {(row: object) => object|null} fn новая запись; null — не писать
 * @returns {Promise<object|null>} записанное, null — записи нет или fn отказалась
 */
export async function patch(store, key, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    const s = t.objectStore(store);
    let out = null;
    const r = s.get(key);
    r.onsuccess = () => {
      if (r.result === undefined) return;
      out = fn(r.result) ?? null;
      if (out) s.put(out);
    };
    t.oncomplete = () => resolve(out);
    t.onabort = () => reject(t.error ?? new Error("транзакция прервана"));
    t.onerror = () => reject(t.error);
  });
}

/**
 * Пакетная запись. Вся страница пишется одной транзакцией: либо страница
 * записана целиком, либо не записана вовсе, и чекпойнт за ней не сдвинется.
 */
export async function putMany(store, values) {
  if (!values.length) return 0;
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    const s = t.objectStore(store);
    for (const v of values) s.put(v);
    t.oncomplete = () => resolve(values.length);
    t.onabort = () => reject(t.error ?? new Error("транзакция прервана"));
    t.onerror = () => reject(t.error);
  });
}

// --- выборки для прохода -------------------------------------------------

/**
 * Письма, уже разобранные в заданном диапазоне дат, включая границы.
 * Проход берёт их перед окном, чтобы отличать новое от уже записанного
 * в памяти, а не запросом на каждое письмо.
 *
 * @param {number|null} from мс, null — без нижней границы
 * @param {number|null} to   мс, null — без верхней
 */
export async function messagesInDateRange(from, to) {
  let range = null;
  if (from != null && to != null) range = IDBKeyRange.bound(from, to);
  else if (from != null) range = IDBKeyRange.lowerBound(from);
  else if (to != null) range = IDBKeyRange.upperBound(to);
  return getAllFromIndex("messages", "date", range);
}

// --- очередь обогащения ---------------------------------------------------
// Состояние письма в поле `enriched`. Число, а не булево: булевы значения
// не являются ключами IndexedDB и в индекс не попали бы.

export const ENRICH = { PENDING: 0, DONE: 1, SKIPPED: 2, FAILED: -1 };

function enrichRange(state, since = null, until = null) {
  return IDBKeyRange.bound([state, since ?? -Infinity], [state, until ?? Infinity]);
}

/**
 * Следующая пачка писем в заданном состоянии, от свежих к старым.
 *
 * @param {number|null} since мс; письма старше не берём (свежий проход)
 * @param {number|null} until мс; письма новее не берём (ещё не сохранены офлайн)
 */
export async function enrichQueue({
  state = ENRICH.PENDING, since = null, until = null, limit = 500,
} = {}) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction("messages", "readonly");
    const idx = t.objectStore("messages").index("enrichQueue");
    const out = [];
    const req = idx.openCursor(enrichRange(state, since, until), "prev");
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      out.push(c.value);
      if (out.length < limit) c.continue();
    };
    t.oncomplete = () => resolve(out);
    t.onabort = () => reject(t.error ?? new Error("транзакция прервана"));
    t.onerror = () => reject(t.error);
  });
}

/** Сколько писем в состоянии обогащения в диапазоне дат. */
export async function countEnrich(state, since = null, until = null) {
  return request(await open(), "messages", "readonly",
    (s) => s.index("enrichQueue").count(enrichRange(state, since, until)));
}

/** Сколько писем в каждом состоянии обогащения. Для панели. */
export async function enrichCounts() {
  const db = await open();
  const out = {};
  for (const [name, state] of Object.entries(ENRICH)) {
    out[name.toLowerCase()] = await request(db, "messages", "readonly",
      (s) => s.index("enrichQueue").count(enrichRange(state)));
  }
  return out;
}

export async function messagesInFolder(fkeyOrFolder) {
  const key = typeof fkeyOrFolder === "string"
    ? fkeyOrFolder : folderKey(fkeyOrFolder);
  return getAllFromIndex("messages", "locations", IDBKeyRange.only(key));
}

// --- чекпойнты -----------------------------------------------------------
// Длинный проход обязан переживать закрытие клиента.

export const checkpoint = {
  async load(scanId) {
    return (await get("meta", `scan:${scanId}`))?.value ?? null;
  },
  async save(scanId, value) {
    return put("meta", { key: `scan:${scanId}`, value, savedAt: Date.now() });
  },
  async clear(scanId) {
    const db = await open();
    return request(db, "meta", "readwrite", (s) => s.delete(`scan:${scanId}`));
  },
  async list() {
    const rows = await getAll("meta");
    return rows.filter((r) => String(r.key).startsWith("scan:"))
      .map((r) => ({ scanId: String(r.key).slice(5), ...r.value, savedAt: r.savedAt }));
  },
};

// --- служебные записи ----------------------------------------------------
// Состояние проходов, у которых позиция не в чекпойнте папок: обогащение,
// замеры гейта. Ключи не пересекаются с `scan:*`.

export const meta = {
  async get(key) {
    return (await get("meta", key))?.value ?? null;
  },
  async set(key, value) {
    return put("meta", { key, value, savedAt: Date.now() });
  },
};

// --- выгрузка ------------------------------------------------------------
// Нужна с первого дня: IndexedDB нельзя открыть снаружи и посмотреть.
//
// Кроме секретов. Токены доступа к TrueConf лежат в `meta` под ключами
// `secret:*` и в выгрузку не попадают: файл выгрузки пересылают, прикладывают
// к заявкам, а токен в нём — это вход в чужую учётную запись.

const SECRET_PREFIX = "secret:";
const exportable = (store, row) =>
  store !== "meta" || !String(row?.key ?? "").startsWith(SECRET_PREFIX);

export async function stats() {
  const out = {};
  for (const name of STORES) {
    try { out[name] = await count(name); } catch { out[name] = null; }
  }
  return out;
}

/**
 * Постраничный обход хранилища по первичному ключу. Держать одну транзакцию
 * открытой на всю выгрузку нельзя: она закрывается, как только цикл событий
 * остаётся без запросов к ней.
 */
export async function pages(store, batch, onPage) {
  const db = await open();
  let lower = null;
  for (;;) {
    const range = lower === null ? null : IDBKeyRange.lowerBound(lower, true);
    const { keys, values } = await new Promise((resolve, reject) => {
      const t = db.transaction(store, "readonly");
      const s = t.objectStore(store);
      const kr = s.getAllKeys(range, batch);
      const vr = s.getAll(range, batch);
      t.oncomplete = () => resolve({ keys: kr.result, values: vr.result });
      t.onabort = () => reject(t.error ?? new Error("транзакция прервана"));
      t.onerror = () => reject(t.error);
    });
    if (!values.length) return;
    await onPage(values);
    if (values.length < batch) return;
    lower = keys[keys.length - 1];
  }
}

/**
 * Выгрузка состояния в JSON кусками. Собирать 50 000 писем в одну строку
 * незачем — отдаём фрагменты, вызывающая сторона складывает их в Blob.
 *
 * @param {(chunk: string) => void|Promise<void>} write
 */
export async function exportChunks(write, { batch = 2000 } = {}) {
  const meta = {
    exportedAt: new Date().toISOString(),
    dbVersion: DB_VERSION,
    counts: await stats(),
  };
  await write(`{\n"meta": ${JSON.stringify(meta, null, 2)},\n"stores": {`);

  let firstStore = true;
  for (const name of STORES) {
    await write(`${firstStore ? "" : ","}\n"${name}": [`);
    firstStore = false;
    let firstRow = true;
    await pages(name, batch, async (all) => {
      const rows = all.filter((r) => exportable(name, r));
      if (!rows.length) return;
      const text = rows.map((r) => JSON.stringify(r)).join(",\n");
      await write((firstRow ? "\n" : ",\n") + text);
      firstRow = false;
    });
    await write("\n]");
  }
  await write("\n}\n}\n");
}

/** Та же выгрузка одним объектом. Удобно в отладочной консоли. */
export async function exportAll() {
  const out = { stores: {} };
  for (const name of STORES) {
    out.stores[name] = [];
    await pages(name, 2000, (rows) => {
      out.stores[name].push(...rows.filter((r) => exportable(name, r)));
    });
  }
  out.meta = { exportedAt: new Date().toISOString(), dbVersion: DB_VERSION };
  return out;
}

/** Полный сброс разобранного. Настройки в storage.local не трогает. */
export async function reset() {
  close();
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    // Блокировка — не отказ: другое соединение получило versionchange и
    // закроется, после чего удаление продолжится само.
    req.onblocked = () => console.warn("r7-triage: удаление базы ждёт закрытия соединений");
  });
}
