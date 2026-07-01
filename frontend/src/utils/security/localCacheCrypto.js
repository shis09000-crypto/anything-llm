const LOCAL_CACHE_DB_NAME = "athena-local-cache-crypto";
const LOCAL_CACHE_DB_VERSION = 1;
const KEY_STORE = "keys";
const LOCAL_CACHE_KEY_ID = "local-cache:aes-gcm:v1";
const LOCAL_CACHE_CRYPTO_VERSION = "athena-local-cache:v1";
const LOCAL_CACHE_ALGORITHM = "AES-GCM-256";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function localCacheCryptoSupported({ keyStore = null } = {}) {
  return Boolean(
    globalThis.isSecureContext !== false &&
      globalThis.crypto?.subtle &&
      (keyStore ||
        globalThis.indexedDB ||
        globalThis.__athenaLocalCacheKeyStore)
  );
}

export function createMemoryLocalCacheKeyStore() {
  const keys = new Map();
  return {
    async getKey(id) {
      return keys.get(id) || null;
    },
    async putKey(id, key) {
      keys.set(id, key);
    },
    async deleteKey(id) {
      keys.delete(id);
    },
    async clear() {
      keys.clear();
    },
    snapshot() {
      return [...keys.keys()];
    },
  };
}

export async function encryptLocalCachePayload({
  namespace,
  payload,
  keyStore = null,
} = {}) {
  if (!localCacheCryptoSupported({ keyStore })) {
    return {
      encrypted: false,
      cryptoVersion: "plaintext-fallback",
      payload,
    };
  }

  const normalizedNamespace = normalizeNamespace(namespace);
  const store = keyStore || (await defaultLocalCacheKeyStore());
  const key = await ensureLocalCacheKey(store);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(payload ?? null));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: additionalData(normalizedNamespace),
    },
    key,
    plaintext
  );

  return {
    encrypted: true,
    cryptoVersion: LOCAL_CACHE_CRYPTO_VERSION,
    algorithm: LOCAL_CACHE_ALGORITHM,
    keyId: LOCAL_CACHE_KEY_ID,
    namespace: normalizedNamespace,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptLocalCachePayload({
  namespace,
  encryptedPayload,
  keyStore = null,
} = {}) {
  if (!encryptedPayload || typeof encryptedPayload !== "object") {
    return null;
  }
  if (encryptedPayload.encrypted === false) return encryptedPayload.payload;

  const normalizedNamespace = normalizeNamespace(namespace);
  if (encryptedPayload.namespace !== normalizedNamespace) {
    throw new Error("local_cache_namespace_mismatch");
  }
  if (encryptedPayload.cryptoVersion !== LOCAL_CACHE_CRYPTO_VERSION) {
    throw new Error("unsupported_local_cache_crypto_version");
  }
  if (encryptedPayload.algorithm !== LOCAL_CACHE_ALGORITHM) {
    throw new Error("unsupported_local_cache_algorithm");
  }
  if (encryptedPayload.keyId !== LOCAL_CACHE_KEY_ID) {
    throw new Error("unsupported_local_cache_key");
  }

  const store = keyStore || (await defaultLocalCacheKeyStore());
  const key = await ensureLocalCacheKey(store);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(encryptedPayload.iv),
      additionalData: additionalData(normalizedNamespace),
    },
    key,
    base64UrlToBytes(encryptedPayload.ciphertext)
  );
  return JSON.parse(textDecoder.decode(plaintext));
}

export async function clearLocalCacheCryptoKeys({ keyStore = null } = {}) {
  const store = keyStore || (await defaultLocalCacheKeyStore());
  if (store.clear) return store.clear();
  if (store.deleteKey) return store.deleteKey(LOCAL_CACHE_KEY_ID);
}

function normalizeNamespace(value) {
  const namespace = String(value || "").trim();
  if (!namespace) throw new Error("local_cache_namespace_required");
  return namespace.slice(0, 512);
}

function additionalData(namespace) {
  return textEncoder.encode(
    JSON.stringify({
      cryptoVersion: LOCAL_CACHE_CRYPTO_VERSION,
      algorithm: LOCAL_CACHE_ALGORITHM,
      keyId: LOCAL_CACHE_KEY_ID,
      namespace,
    })
  );
}

async function ensureLocalCacheKey(store) {
  const existing = await store.getKey(LOCAL_CACHE_KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  await store.putKey(LOCAL_CACHE_KEY_ID, key);
  return key;
}

async function defaultLocalCacheKeyStore() {
  if (globalThis.__athenaLocalCacheKeyStore) {
    return globalThis.__athenaLocalCacheKeyStore;
  }
  const db = await openDb();
  return {
    async getKey(id) {
      return getRecord(db, KEY_STORE, id).then((record) => record?.key || null);
    },
    async putKey(id, key) {
      return putRecord(db, KEY_STORE, { id, key });
    },
    async deleteKey(id) {
      return deleteRecord(db, KEY_STORE, id);
    },
    async clear() {
      return clearStore(db, KEY_STORE);
    },
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_CACHE_DB_NAME, LOCAL_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getRecord(db, storeName, key) {
  return storeRequest(db, storeName, "readonly", (store) => store.get(key));
}

function putRecord(db, storeName, value) {
  return storeRequest(db, storeName, "readwrite", (store) => store.put(value));
}

function deleteRecord(db, storeName, key) {
  return storeRequest(db, storeName, "readwrite", (store) => store.delete(key));
}

function clearStore(db, storeName) {
  return storeRequest(db, storeName, "readwrite", (store) => store.clear());
}

function storeRequest(db, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function bytesToBase64Url(bytes) {
  const bufferCtor = globalThis.Buffer;
  if (bufferCtor) {
    return bufferCtor.from(bytes).toString("base64url");
  }
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    ""
  );
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const bufferCtor = globalThis.Buffer;
  if (bufferCtor) {
    return Uint8Array.from(bufferCtor.from(String(value), "base64url"));
  }
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "="
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
