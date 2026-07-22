/**
 * IndexedDB key/value store for the vault's bulk, at-rest ciphertext.
 *
 * Why IndexedDB and not localStorage: the sealed vault blob carries avatars,
 * channel icons, a chat wallpaper, and custom sound files -- all base64 -- and
 * the per-channel message logs grow without bound. localStorage's ~5MB origin
 * cap is reached by a single wallpaper plus a busy channel, and its synchronous
 * API blocks the main thread on every write. Only large, encrypted values live
 * here; the small plaintext account registry stays in localStorage so the
 * account API can remain synchronous (see accounts.ts).
 *
 * Everything written here is already a secretbox ciphertext. IndexedDB is not a
 * trust boundary -- it is wiped by "clear browsing data" exactly like
 * localStorage. Durability against that is the backup layer's job, not this
 * store's.
 */

const DB_NAME = 'darkchat';
const STORE = 'kv';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    // A parallel tab holding an old-version connection blocks the upgrade. We
    // never change version out from under a live tab in v1, but reject rather
    // than hang forever if that ever changes.
    req.onblocked = () => reject(new Error('indexedDB upgrade blocked by another tab'));
  });
  return dbPromise;
}

/** Promisify a single-store transaction, resolving with the request result. */
function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        // Resolve on the request, but let a failed *commit* (quota, abort) still
        // reject: a put whose request succeeded can be rolled back at commit.
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error ?? req.error ?? new Error('indexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
      })
  );
}

export function dbGet<T>(key: string): Promise<T | null> {
  return run<T | undefined>('readonly', (s) => s.get(key)).then((v) => v ?? null);
}

export function dbPut(key: string, value: unknown): Promise<void> {
  return run<IDBValidKey>('readwrite', (s) => s.put(value, key)).then(() => undefined);
}

export function dbDelete(key: string): Promise<void> {
  return run<undefined>('readwrite', (s) => s.delete(key)).then(() => undefined);
}

/** Every key currently under `prefix`. Used to enumerate a channel's messages. */
export function dbKeys(prefix = ''): Promise<string[]> {
  return run<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.map(String).filter((k) => k.startsWith(prefix))
  );
}

/**
 * Drop the whole store, and the cached connection with it.
 *
 * Test-only: fake-indexeddb persists across cases in a file, so without this a
 * vault written in one test is visible in the next. Never called in the app.
 */
export async function resetDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
