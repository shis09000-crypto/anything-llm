const DB_NAME = "athena-auth-recovery";
const DB_VERSION = 1;
const BINDING_STORE = "bindings";
const KEY_STORE = "keys";
const WRAP_KEY_ID = "session-recovery-wrap-key";

export function authRecoveryStorageSupported() {
  return Boolean(
    globalThis.isSecureContext &&
      globalThis.indexedDB &&
      globalThis.crypto?.subtle
  );
}

export async function saveSessionRecoveryBinding({
  clientId,
  recoveryHandle,
  expiresAt,
} = {}) {
  if (!authRecoveryStorageSupported() || !clientId || !recoveryHandle) {
    return false;
  }
  const db = await openDb();
  const wrapKey = await getWrapKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrapKey,
    new TextEncoder().encode(String(recoveryHandle))
  );
  await putRecord(db, BINDING_STORE, {
    clientId: String(clientId),
    wrappedHandle: bytesToBase64Url(new Uint8Array(encrypted)),
    iv: bytesToBase64Url(iv),
    expiresAt: Number(expiresAt) || null,
    updatedAt: Date.now(),
  });
  return true;
}

export async function readSessionRecoveryBinding(clientId) {
  if (!authRecoveryStorageSupported() || !clientId) return null;
  const db = await openDb();
  const record = await getRecord(db, BINDING_STORE, String(clientId));
  if (!record?.wrappedHandle || !record?.iv) return null;
  if (record.expiresAt && Number(record.expiresAt) <= Date.now()) {
    await deleteRecord(db, BINDING_STORE, String(clientId));
    return null;
  }
  try {
    const wrapKey = await getWrapKey(db);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(record.iv) },
      wrapKey,
      base64UrlToBytes(record.wrappedHandle)
    );
    return {
      clientId: String(clientId),
      recoveryHandle: new TextDecoder().decode(decrypted),
      expiresAt: Number(record.expiresAt) || null,
      updatedAt: Number(record.updatedAt) || null,
    };
  } catch {
    await deleteRecord(db, BINDING_STORE, String(clientId)).catch(() => null);
    return null;
  }
}

export async function clearSessionRecoveryBinding(clientId = null) {
  if (!authRecoveryStorageSupported()) return false;
  const db = await openDb();
  if (clientId) {
    await deleteRecord(db, BINDING_STORE, String(clientId));
  } else {
    await clearStore(db, BINDING_STORE);
  }
  return true;
}

async function getWrapKey(db) {
  const existing = await getRecord(db, KEY_STORE, WRAP_KEY_ID);
  if (existing?.key) return existing.key;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  await putRecord(db, KEY_STORE, { id: WRAP_KEY_ID, key });
  return key;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BINDING_STORE)) {
        db.createObjectStore(BINDING_STORE, { keyPath: "clientId" });
      }
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeRequest(db, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
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

function bytesToBase64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    ""
  );
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "="
  );
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
