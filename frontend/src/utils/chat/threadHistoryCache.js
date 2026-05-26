const DB_NAME = "anythingllm-workspacechat-cache";
const STORE_NAME = "history";
const SESSION_PREFIX = "workspacechat-history:";

export const THREAD_HISTORY_CACHE_VERSION = 1;
export const THREAD_HISTORY_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
export const THREAD_HISTORY_CACHE_MAX_SIZE = 8 * 1024 * 1024;

const memoryCache = new Map();

function cacheKey({
  workspaceSlug,
  threadSlug = null,
  kind = "page",
  cursor = "latest",
}) {
  return `${THREAD_HISTORY_CACHE_VERSION}:${workspaceSlug}:${threadSlug || "default"}:${kind}:${cursor || "latest"}`;
}

function estimateSize(value) {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

function isExpired(entry) {
  return !entry || Date.now() - entry.updatedAt > THREAD_HISTORY_CACHE_TTL_MS;
}

function openDb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, THREAD_HISTORY_CACHE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readIndexedDb(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

async function writeIndexedDb(entry) {
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(entry);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
  pruneIndexedDb(db);
}

function pruneIndexedDb(db) {
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();
  request.onsuccess = () => {
    const entries = request.result || [];
    const validEntries = entries
      .filter((entry) => !isExpired(entry))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const expiredKeys = entries
      .filter((entry) => isExpired(entry))
      .map((entry) => entry.key);
    expiredKeys.forEach((key) => store.delete(key));

    let size = 0;
    for (const entry of validEntries) {
      size += entry.size || estimateSize(entry.payload);
      if (size > THREAD_HISTORY_CACHE_MAX_SIZE) store.delete(entry.key);
    }
  };
}

function setSession(key, entry) {
  try {
    sessionStorage.setItem(`${SESSION_PREFIX}${key}`, JSON.stringify(entry));
  } catch {}
}

function getSession(key) {
  try {
    return JSON.parse(sessionStorage.getItem(`${SESSION_PREFIX}${key}`));
  } catch {
    return null;
  }
}

export const threadHistoryCache = {
  key: cacheKey,
  async get(options) {
    const key = cacheKey(options);
    const memory = memoryCache.get(key);
    if (!isExpired(memory)) return memory.payload;

    const session = getSession(key);
    if (!isExpired(session)) {
      memoryCache.set(key, session);
      return session.payload;
    }

    const indexed = await readIndexedDb(key);
    if (!isExpired(indexed)) {
      memoryCache.set(key, indexed);
      setSession(key, indexed);
      return indexed.payload;
    }
    return null;
  },
  async set(options, payload, { indexed = false } = {}) {
    const key = cacheKey(options);
    const entry = {
      key,
      payload,
      updatedAt: Date.now(),
      cacheVersion: THREAD_HISTORY_CACHE_VERSION,
      size: estimateSize(payload),
    };
    memoryCache.set(key, entry);
    setSession(key, entry);
    if (indexed) await writeIndexedDb(entry);
  },
  invalidateThread(workspaceSlug, threadSlug = null) {
    const needle = `:${workspaceSlug}:${threadSlug || "default"}:`;
    for (const key of [...memoryCache.keys()]) {
      if (key.includes(needle)) memoryCache.delete(key);
    }
    try {
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith(SESSION_PREFIX) && key.includes(needle))
        .forEach((key) => sessionStorage.removeItem(key));
    } catch {}
    openDb().then((db) => {
      if (!db) return;
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        (request.result || [])
          .filter((key) => String(key).includes(needle))
          .forEach((key) => store.delete(key));
      };
    });
  },
  invalidateWorkspace(workspaceSlug) {
    const needle = `:${workspaceSlug}:`;
    for (const key of [...memoryCache.keys()]) {
      if (key.includes(needle)) memoryCache.delete(key);
    }
    try {
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith(SESSION_PREFIX) && key.includes(needle))
        .forEach((key) => sessionStorage.removeItem(key));
    } catch {}
    openDb().then((db) => {
      if (!db) return;
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        (request.result || [])
          .filter((key) => String(key).includes(needle))
          .forEach((key) => store.delete(key));
      };
    });
  },
};
