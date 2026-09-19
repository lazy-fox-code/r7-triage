// Хранилище. IndexedDB, потому что держит сотни тысяч записей и не требует
// установки внешних компонентов. Запросов поверх сырых данных не делаем:
// метрики графа считаются инкрементально при разборе письма.

const DB_NAME = "r7-triage";
const DB_VERSION = 1;

let _db = null;

export async function open() {
  if (_db) return _db;
  _db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => migrate(e.target.result, e.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}

function migrate(db, oldVersion) {
  if (oldVersion < 1) {
    // Разобранные письма. Тело НЕ храним: оно уже лежит в офлайн-хранилище
    // Thunderbird, дублировать незачем.
    const messages = db.createObjectStore("messages", { keyPath: "id" });
    messages.createIndex("date", "date");
    messages.createIndex("threadId", "threadId");
    messages.createIndex("fromId", "fromId");

    // Рёбра графа: отправитель -> получатель, ключ "fromId|toId".
    db.createObjectStore("edges", { keyPath: "id" });

    // Люди. id — нормализованный адрес.
    const people = db.createObjectStore("people", { keyPath: "id" });
    people.createIndex("level", "level");

    // Вердикты классификации вместе с обоснованием.
    const verdicts = db.createObjectStore("verdicts", { keyPath: "messageId" });
    verdicts.createIndex("label", "label");
    verdicts.createIndex("expiresAt", "expiresAt");

    // Извлечённые поручения.
    const tasks = db.createObjectStore("tasks", {
      keyPath: "id", autoIncrement: true });
    tasks.createIndex("assigneeId", "assigneeId");
    tasks.createIndex("dueDate", "dueDate");
    tasks.createIndex("status", "status");

    // Служебное: курсоры сканирования, настройки, версии промптов.
    db.createObjectStore("meta", { keyPath: "key" });
  }
}

export async function put(store, value) {
  const db = await open();
  return tx(db, store, "readwrite", (s) => s.put(value));
}

export async function get(store, key) {
  const db = await open();
  return tx(db, store, "readonly", (s) => s.get(key));
}

export async function putMany(store, values) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    const s = t.objectStore(store);
    for (const v of values) s.put(v);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- чекпойнты -----------------------------------------------------------
// Длинный проход обязан переживать закрытие клиента.

export const checkpoint = {
  async load(scanId) {
    return (await get("meta", `scan:${scanId}`))?.value ?? null;
  },
  async save(scanId, value) {
    return put("meta", { key: `scan:${scanId}`, value });
  },
};

// --- выгрузка ------------------------------------------------------------
// Нужна с первого дня: IndexedDB нельзя открыть снаружи и посмотреть.

export async function exportAll() {
  const db = await open();
  const out = {};
  for (const name of db.objectStoreNames) {
    out[name] = await tx(db, name, "readonly", (s) => s.getAll());
  }
  return out;
}
