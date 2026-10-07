// Async key-value storage (ARCHITECTURE §6.2). On web: IndexedDB, falling back to localStorage
// (private mode, old WebViews), then memory. Native has no persistent backend wired yet (MMKV lands
// with the Android milestone), so it uses memory and a guest lasts for the app session.

export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryKv(initial: Record<string, string> = {}): Kv {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(map.get(key) ?? null),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

function localStorageKv(storage: Storage): Kv {
  return {
    get: (key) => Promise.resolve(storage.getItem(key)),
    set: (key, value) => {
      storage.setItem(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      storage.removeItem(key);
      return Promise.resolve();
    },
  };
}

const DB_NAME = 'playhub';
const STORE = 'kv';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function indexedDbKv(idb: IDBFactory): Kv {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    return db;
  };
  const store = async (mode: IDBTransactionMode) =>
    (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    async get(key) {
      const value: unknown = await request((await store('readonly')).get(key));
      return typeof value === 'string' ? value : null;
    },
    async set(key, value) {
      await request((await store('readwrite')).put(value, key));
    },
    async delete(key) {
      await request((await store('readwrite')).delete(key));
    },
  };
}

/** Uses IndexedDB until it fails once, then the fallback for the rest of the session. */
function withFallback(primary: Kv, fallback: Kv): Kv {
  let active = primary;
  const run = async <T>(op: (kv: Kv) => Promise<T>): Promise<T> => {
    try {
      return await op(active);
    } catch {
      active = fallback;
      return op(fallback);
    }
  };
  return {
    get: (key) => run((kv) => kv.get(key)),
    set: (key, value) => run((kv) => kv.set(key, value)),
    delete: (key) => run((kv) => kv.delete(key)),
  };
}

function safeLocalStorage(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return null;
    storage.getItem('__probe');
    return storage;
  } catch {
    return null;
  }
}

function createDefaultKv(): Kv {
  const local = safeLocalStorage();
  const fallback = local ? localStorageKv(local) : memoryKv();
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  return idb ? withFallback(indexedDbKv(idb), fallback) : fallback;
}

let shared: Kv | null = null;

export function defaultKv(): Kv {
  shared ??= createDefaultKv();
  return shared;
}
