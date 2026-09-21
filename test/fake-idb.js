// Минимальная IndexedDB для тестов. Ровно столько, сколько использует db.js:
// хранилища, индексы (включая multiEntry и составные), диапазоны,
// getAll/getAllKeys, курсоры в обе стороны, апгрейд версии с транзакцией
// апгрейда, versionchange и удаление базы.
//
// Зависимостей у проекта нет и заводить их ради тестов не хочется: fake-indexeddb
// потянул бы node_modules в расширение, которое собирается zip-ом.

const DBS = new Map();

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// Порядок ключей по спецификации: числа, затем строки, затем массивы;
// массивы сравниваются поэлементно.
const rankOf = (k) => (typeof k === "number" ? 0 : typeof k === "string" ? 1 : 2);

function cmp(a, b) {
  const ta = rankOf(a);
  const tb = rankOf(b);
  if (ta !== tb) return ta - tb;
  if (ta === 2) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function valueAt(obj, keyPath) {
  // Составной ключ: массив путей даёт массив значений.
  if (Array.isArray(keyPath)) return keyPath.map((p) => valueAt(obj, p));
  return keyPath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export class FakeKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower; this.upper = upper;
    this.lowerOpen = lowerOpen; this.upperOpen = upperOpen;
  }
  static bound(l, u, lo = false, uo = false) { return new FakeKeyRange(l, u, lo, uo); }
  static lowerBound(l, open = false) { return new FakeKeyRange(l, undefined, open, false); }
  static upperBound(u, open = false) { return new FakeKeyRange(undefined, u, false, open); }
  static only(v) { return new FakeKeyRange(v, v, false, false); }
  includes(key) {
    if (this.lower !== undefined) {
      const c = cmp(key, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const c = cmp(key, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
}

class FakeRequest {
  constructor(tx) { this.transaction = tx; this.result = undefined; this.error = null; }
}

class FakeIndex {
  constructor(store, name, keyPath, opts) {
    this.store = store; this.name = name;
    this.keyPath = keyPath; this.multiEntry = Boolean(opts?.multiEntry);
  }
  #entries() {
    const out = [];
    for (const [pk, value] of this.store.data) {
      const raw = valueAt(value, this.keyPath);
      if (raw === undefined || raw === null) continue;
      if (this.multiEntry && Array.isArray(raw)) {
        for (const k of raw) if (isValidKey(k)) out.push([k, pk, value]);
      } else if (isValidKey(raw)) {
        out.push([raw, pk, value]);
      }
      // Недопустимые ключи (например булевы) индекс молча пропускает —
      // ровно как настоящая IndexedDB.
    }
    return out.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  }
  #inRange(range) {
    const rows = this.#entries();
    return range ? rows.filter(([k]) => range.includes(k)) : rows;
  }
  getAll(range, limit) {
    return this.store.tx._enqueue(() => {
      let rows = this.#inRange(range);
      if (limit) rows = rows.slice(0, limit);
      return rows.map(([, , v]) => clone(v));
    });
  }
  count(range) {
    return this.store.tx._enqueue(() => this.#inRange(range).length);
  }
  /**
   * Курсор. Один и тот же запрос получает onsuccess на каждую запись и
   * последний раз — с null, как в настоящей IndexedDB. Снимок данных
   * берётся при открытии: тестам этого достаточно.
   */
  openCursor(range, direction = "next") {
    const tx = this.store.tx;
    const req = new FakeRequest(tx);
    let rows = null;
    let i = 0;
    const step = () => tx._enqueue(() => {
      if (!rows) {
        rows = this.#inRange(range);
        if (String(direction).startsWith("prev")) rows.reverse();
      }
      if (i >= rows.length) return null;
      const [key, primaryKey, value] = rows[i++];
      return { key, primaryKey, value: clone(value), continue: step };
    }, req);
    step();
    return req;
  }
}

function isValidKey(k) {
  if (Array.isArray(k)) return k.every(isValidKey);
  // Бесконечности — допустимые ключи, NaN — нет.
  return typeof k === "number" ? !Number.isNaN(k) : typeof k === "string";
}

class FakeObjectStore {
  constructor(meta, tx) { this.meta = meta; this.tx = tx; }
  get data() { return this.meta.data; }
  get keyPath() { return this.meta.keyPath; }

  #sortedKeys() { return [...this.data.keys()].sort(cmp); }

  #key(value) {
    if (this.meta.autoIncrement) {
      const existing = valueAt(value, this.keyPath);
      if (existing !== undefined) return existing;
      return this.meta.nextKey++;
    }
    return valueAt(value, this.keyPath);
  }

  put(value) {
    return this.tx._enqueue(() => {
      if (this.tx.mode === "readonly") throw new Error("ReadOnlyError");
      const v = clone(value);
      const key = this.#key(v);
      if (!isValidKey(key)) throw new Error(`DataError: недопустимый ключ ${String(key)}`);
      if (this.meta.autoIncrement && valueAt(v, this.keyPath) === undefined) {
        v[this.keyPath] = key;
      }
      this.data.set(key, v);
      return key;
    });
  }

  get(key) { return this.tx._enqueue(() => clone(this.data.get(key))); }
  delete(key) { return this.tx._enqueue(() => { this.data.delete(key); return undefined; }); }
  count() { return this.tx._enqueue(() => this.data.size); }

  getAll(range, limit) {
    return this.tx._enqueue(() => {
      let keys = this.#sortedKeys();
      if (range) keys = keys.filter((k) => range.includes(k));
      if (limit) keys = keys.slice(0, limit);
      return keys.map((k) => clone(this.data.get(k)));
    });
  }

  getAllKeys(range, limit) {
    return this.tx._enqueue(() => {
      let keys = this.#sortedKeys();
      if (range) keys = keys.filter((k) => range.includes(k));
      if (limit) keys = keys.slice(0, limit);
      return keys;
    });
  }

  createIndex(name, keyPath, opts) {
    this.meta.indexes.set(name, { name, keyPath, opts: opts ?? {} });
    return this.index(name);
  }

  index(name) {
    const m = this.meta.indexes.get(name);
    if (!m) throw new Error(`NotFoundError: индекс ${name}`);
    return new FakeIndex(this, m.name, m.keyPath, m.opts);
  }
}

class FakeTransaction {
  constructor(db, mode) {
    this.db = db; this.mode = mode;
    this.pending = 0; this.finished = false;
    this.oncomplete = null; this.onerror = null; this.onabort = null;
    this.error = null;
  }
  objectStore(name) {
    const meta = this.db.rec.stores.get(name);
    if (!meta) throw new Error(`NotFoundError: хранилище ${name}`);
    return new FakeObjectStore(meta, this);
  }
  _enqueue(fn, req = new FakeRequest(this)) {
    this.pending++;
    queueMicrotask(() => {
      let ok = true;
      try { req.result = fn(); } catch (e) { ok = false; req.error = e; this.error = e; }
      this.pending--;
      try {
        if (ok) req.onsuccess?.({ target: req });
        else { req.onerror?.({ target: req }); this._abort(req.error); }
      } catch (e) { this.error = e; }
      this._maybeComplete();
    });
    return req;
  }
  _abort(error) {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    queueMicrotask(() => this.onabort?.({ target: this }));
  }
  _maybeComplete() {
    if (this.pending > 0 || this.finished) return;
    // Даём обработчику onsuccess шанс поставить ещё один запрос в ту же
    // транзакцию, как это делает настоящая IndexedDB.
    queueMicrotask(() => {
      if (this.pending > 0 || this.finished) return;
      this.finished = true;
      this.oncomplete?.({ target: this });
    });
  }
}

class FakeDatabase {
  constructor(rec, name) {
    this.rec = rec; this.name = name;
    this.closed = false;
    this.onversionchange = null; this.onclose = null;
  }
  get version() { return this.rec.version; }
  get objectStoreNames() {
    const names = [...this.rec.stores.keys()];
    names.contains = (n) => names.includes(n);
    return names;
  }
  createObjectStore(name, opts = {}) {
    const meta = {
      name, keyPath: opts.keyPath, autoIncrement: Boolean(opts.autoIncrement),
      nextKey: 1, data: new Map(), indexes: new Map(),
    };
    this.rec.stores.set(name, meta);
    return new FakeObjectStore(meta, this.rec.upgradeTx);
  }
  deleteObjectStore(name) { this.rec.stores.delete(name); }
  transaction(names, mode = "readonly") {
    if (this.closed) throw new Error("InvalidStateError: соединение закрыто");
    return new FakeTransaction(this, mode);
  }
  close() {
    this.closed = true;
    this.rec.connections.delete(this);
    this.onclose?.();
  }
}

export const fakeIndexedDB = {
  open(name, version) {
    const req = new FakeRequest(null);
    setTimeout(() => {
      let rec = DBS.get(name);
      if (!rec) { rec = { version: 0, stores: new Map(), connections: new Set() }; DBS.set(name, rec); }

      const db = new FakeDatabase(rec, name);
      req.result = db;

      if (version > rec.version) {
        const oldVersion = rec.version;
        rec.upgradeTx = new FakeTransaction(db, "versionchange");
        rec.version = version;
        // Миграция добавляет индексы к уже существующим хранилищам через
        // транзакцию апгрейда — как `request.transaction` в настоящей базе.
        req.transaction = rec.upgradeTx;
        try {
          req.onupgradeneeded?.({ oldVersion, newVersion: version, target: req });
        } catch (e) {
          req.error = e;
          req.onerror?.({ target: req });
          return;
        }
        rec.upgradeTx = null;
        req.transaction = null;
      }

      rec.connections.add(db);
      req.onsuccess?.({ target: req });
    }, 0);
    return req;
  },

  deleteDatabase(name) {
    const req = new FakeRequest(null);
    setTimeout(() => {
      const rec = DBS.get(name);
      for (const conn of rec?.connections ?? []) conn.onversionchange?.();
      // Соединения обязаны закрыться сами; настоящая база иначе сообщила бы
      // blocked. Здесь считаем, что закрылись.
      DBS.delete(name);
      req.onsuccess?.({ target: req });
    }, 0);
    return req;
  },
};

/** Полный сброс между тестами. */
export function resetFakeIndexedDB() { DBS.clear(); }

export function install() {
  globalThis.indexedDB = fakeIndexedDB;
  globalThis.IDBKeyRange = FakeKeyRange;
}
