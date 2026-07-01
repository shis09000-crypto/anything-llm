import {
  envIndexedDbName,
  getAppEnvironment,
  storageKeys,
} from "@/utils/appEnvironment";
import {
  decryptLocalCachePayload,
  encryptLocalCachePayload,
} from "@/utils/security/localCacheCrypto";
import { historyCacheScope } from "./historyCacheScope";

const DB_NAME = "anythingllm-workspacechat-cache";
const STORE_NAME = "history";
const SESSION_PREFIX = "workspacechat-history:";

export const THREAD_HISTORY_CACHE_VERSION = 2;
export const THREAD_HISTORY_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
export const THREAD_HISTORY_CACHE_MAX_SIZE = 8 * 1024 * 1024;
export const THREAD_HISTORY_MEMORY_MAX_SIZE = 3 * 1024 * 1024;
export const THREAD_HISTORY_SESSION_MAX_SIZE = 4 * 1024 * 1024;
export const THREAD_HISTORY_MEMORY_MAX_ENTRIES = 32;

const memoryCache = new Map();

function cacheKey({
  workspaceSlug,
  threadSlug = null,
  kind = "page",
  cursor = "latest",
  detail = "light",
  surface = "desktop",
}) {
  const scope = historyCacheScope({ detail, surface });
  return `${getAppEnvironment()}:${THREAD_HISTORY_CACHE_VERSION}:${scope.detail}:${scope.surface}:${workspaceSlug}:${threadSlug || "default"}:${kind}:${cursor || "latest"}`;
}

function estimateSize(value) {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

function sanitizeForCache(value) {
  const seen = new WeakSet();
  return JSON.parse(
    JSON.stringify(value, (key, nestedValue) => {
      if (
        key === "contentString" ||
        key === "previewUrl" ||
        key === "compressedImages" ||
        key === "rawToolPayload" ||
        key === "rawPayload"
      ) {
        return undefined;
      }
      if (
        typeof nestedValue === "string" &&
        nestedValue.length > 8192 &&
        /^data:/i.test(nestedValue)
      ) {
        return undefined;
      }
      if (nestedValue && typeof nestedValue === "object") {
        if (seen.has(nestedValue)) return undefined;
        seen.add(nestedValue);
      }
      return nestedValue;
    })
  );
}

function isExpired(entry) {
  return !entry || Date.now() - entry.updatedAt > THREAD_HISTORY_CACHE_TTL_MS;
}

function encryptedEntryNamespace(key) {
  return `thread-history:${key}`;
}

async function sealEntry(entry) {
  try {
    const encryptedPayload = await encryptLocalCachePayload({
      namespace: encryptedEntryNamespace(entry.key),
      payload: entry.payload,
    });
    if (!encryptedPayload?.encrypted) return entry;
    return {
      ...entry,
      payload: null,
      encrypted: true,
      encryptedPayload,
    };
  } catch {
    return entry;
  }
}

async function unsealEntry(entry) {
  if (!entry?.encryptedPayload?.encrypted) return entry;
  try {
    const payload = await decryptLocalCachePayload({
      namespace: encryptedEntryNamespace(entry.key),
      encryptedPayload: entry.encryptedPayload,
    });
    return {
      ...entry,
      payload,
    };
  } catch {
    return null;
  }
}

function openDb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(
      envIndexedDbName(DB_NAME),
      THREAD_HISTORY_CACHE_VERSION
    );
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
    pruneSessionStorage();
  } catch {}
}

async function getSession(key) {
  try {
    const entry = JSON.parse(sessionStorage.getItem(`${SESSION_PREFIX}${key}`));
    const unsealed = await unsealEntry(entry);
    if (!unsealed && entry) {
      sessionStorage.removeItem(`${SESSION_PREFIX}${key}`);
    }
    return unsealed;
  } catch {
    return null;
  }
}

function memoryEntries() {
  return [...memoryCache.entries()].map(([key, entry]) => ({
    key,
    entry,
    size: entry?.size || estimateSize(entry?.payload),
    updatedAt: entry?.updatedAt || 0,
  }));
}

function pruneMemoryCache() {
  const entries = memoryEntries()
    .filter(({ entry }) => {
      const expired = isExpired(entry);
      if (expired) memoryCache.delete(entry.key);
      return !expired;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  let size = 0;
  entries.forEach((item, index) => {
    size += item.size;
    if (
      index >= THREAD_HISTORY_MEMORY_MAX_ENTRIES ||
      size > THREAD_HISTORY_MEMORY_MAX_SIZE
    ) {
      memoryCache.delete(item.key);
    }
  });
}

function sessionEntries() {
  if (typeof sessionStorage === "undefined") return [];
  const entries = [];
  try {
    storageKeys(sessionStorage).forEach((storageKey) => {
      if (!storageKey.startsWith(SESSION_PREFIX)) return;
      const raw = sessionStorage.getItem(storageKey);
      const entry = JSON.parse(raw);
      entries.push({
        storageKey,
        entry,
        size: raw?.length || 0,
        updatedAt: entry?.updatedAt || 0,
      });
    });
  } catch {}
  return entries;
}

function pruneSessionStorage() {
  const entries = sessionEntries()
    .filter(({ storageKey, entry }) => {
      const expired = isExpired(entry);
      if (expired) sessionStorage.removeItem(storageKey);
      return !expired;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  let size = 0;
  entries.forEach((item) => {
    size += item.size;
    if (size > THREAD_HISTORY_SESSION_MAX_SIZE) {
      sessionStorage.removeItem(item.storageKey);
    }
  });
}

export const threadHistoryCache = {
  key: cacheKey,
  async get(options) {
    const key = cacheKey(options);
    const memory = memoryCache.get(key);
    if (!isExpired(memory)) return memory.payload;
    if (memory) memoryCache.delete(key);

    const session = await getSession(key);
    if (!isExpired(session)) {
      memoryCache.set(key, session);
      pruneMemoryCache();
      return session.payload;
    }

    const indexed = await unsealEntry(await readIndexedDb(key));
    if (!isExpired(indexed)) {
      memoryCache.set(key, indexed);
      setSession(key, await sealEntry(indexed));
      pruneMemoryCache();
      return indexed.payload;
    }
    return null;
  },
  async set(options, payload, { indexed = false } = {}) {
    const key = cacheKey(options);
    const cachedPayload = sanitizeForCache(payload);
    const entry = {
      key,
      payload: cachedPayload,
      updatedAt: Date.now(),
      cacheVersion: THREAD_HISTORY_CACHE_VERSION,
      size: estimateSize(cachedPayload),
    };
    memoryCache.set(key, entry);
    pruneMemoryCache();
    const sealedEntry = await sealEntry(entry);
    setSession(key, sealedEntry);
    if (indexed) await writeIndexedDb(sealedEntry);
  },
  prune() {
    pruneMemoryCache();
    pruneSessionStorage();
    openDb().then((db) => db && pruneIndexedDb(db));
  },
  stats() {
    const memory = memoryEntries();
    const session = sessionEntries();
    return {
      memoryEntries: memory.length,
      memoryBytes: memory.reduce((sum, item) => sum + item.size, 0),
      sessionEntries: session.length,
      sessionBytes: session.reduce((sum, item) => sum + item.size, 0),
      limits: {
        memoryBytes: THREAD_HISTORY_MEMORY_MAX_SIZE,
        sessionBytes: THREAD_HISTORY_SESSION_MAX_SIZE,
        memoryEntries: THREAD_HISTORY_MEMORY_MAX_ENTRIES,
        ttlMs: THREAD_HISTORY_CACHE_TTL_MS,
      },
    };
  },
  invalidateThread(workspaceSlug, threadSlug = null) {
    const needle = `:${workspaceSlug}:${threadSlug || "default"}:`;
    for (const key of [...memoryCache.keys()]) {
      if (key.includes(needle)) memoryCache.delete(key);
    }
    try {
      storageKeys(sessionStorage)
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
      storageKeys(sessionStorage)
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
  clearAll() {
    memoryCache.clear();
    try {
      storageKeys(sessionStorage)
        .filter((key) => key.startsWith(SESSION_PREFIX))
        .forEach((key) => sessionStorage.removeItem(key));
    } catch {}
    openDb().then((db) => {
      if (!db) return;
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
    });
  },
};
