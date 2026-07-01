const VAULT_DB_NAME = "athena-vault-keys";
const VAULT_DB_VERSION = 1;
const KEY_STORE = "keys";
const WRAPPED_KEY_STORE = "wrappedKeys";
const DEVICE_WRAP_KEY_ID = "device-wrap-key:v1";
const VAULT_CRYPTO_VERSION = "athena-vault-item:v1";
const VAULT_ALGORITHM = "AES-GCM-256+AES-KW";
const VAULT_RECOVERY_VERSION = "athena-vault-recovery:v1";
const VAULT_RECOVERY_ALGORITHM = "PBKDF2-SHA256+AES-KW-256";
const VAULT_RECOVERY_ITERATIONS = 210_000;
const DEFAULT_VAULT_UNLOCK_TTL_MS = 5 * 60 * 1000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const lockedVaultUsers = new Set();
const vaultUnlockExpiresAt = new Map();
let vaultAutoLockCleanup = null;

export function vaultCryptoSupported({ keyStore = null } = {}) {
  return Boolean(
    globalThis.isSecureContext !== false &&
      globalThis.crypto?.subtle &&
      (keyStore || globalThis.indexedDB || globalThis.__athenaVaultKeyStore)
  );
}

export function createMemoryVaultKeyStore() {
  const keys = new Map();
  const wrappedKeys = new Map();
  return {
    async getKey(id) {
      return keys.get(id) || null;
    },
    async putKey(id, key) {
      keys.set(id, key);
    },
    async getWrappedKey(id) {
      return wrappedKeys.get(id) || null;
    },
    async putWrappedKey(id, value) {
      wrappedKeys.set(id, value);
    },
    async deletePrefix(prefix) {
      for (const key of [...keys.keys()]) {
        if (key.startsWith(prefix)) keys.delete(key);
      }
      for (const key of [...wrappedKeys.keys()]) {
        if (key.startsWith(prefix)) wrappedKeys.delete(key);
      }
    },
    snapshot() {
      return {
        keys: [...keys.keys()],
        wrappedKeys: [...wrappedKeys.entries()],
      };
    },
  };
}

export async function encryptVaultItemPayload({ userId, item, keyStore } = {}) {
  assertSupported({ keyStore });
  const ownerId = normalizeUserId(userId);
  const store = keyStore || (await defaultVaultKeyStore());
  const vaultMasterKey = await ensureVaultMasterKey({ store, userId: ownerId });
  const itemKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const keyId = vaultMasterKeyId(ownerId);
  const wrappedItemKey = await crypto.subtle.wrapKey(
    "raw",
    itemKey,
    vaultMasterKey,
    "AES-KW"
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = itemAdditionalData({ keyId });
  const plaintext = textEncoder.encode(JSON.stringify(item || {}));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    itemKey,
    plaintext
  );

  return {
    cryptoVersion: VAULT_CRYPTO_VERSION,
    algorithm: VAULT_ALGORITHM,
    keyId,
    wrappedItemKey: bytesToBase64Url(new Uint8Array(wrappedItemKey)),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptVaultItemPayload({
  userId,
  encryptedPayload,
  keyStore,
} = {}) {
  assertSupported({ keyStore });
  const ownerId = normalizeUserId(userId);
  assertVaultUnlocked(ownerId);
  const payload = normalizeEncryptedPayload(encryptedPayload);
  const store = keyStore || (await defaultVaultKeyStore());
  const vaultMasterKey = await ensureVaultMasterKey({ store, userId: ownerId });
  const itemKey = await crypto.subtle.unwrapKey(
    "raw",
    base64UrlToBytes(payload.wrappedItemKey),
    vaultMasterKey,
    "AES-KW",
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(payload.iv),
      additionalData: itemAdditionalData({ keyId: payload.keyId }),
    },
    itemKey,
    base64UrlToBytes(payload.ciphertext)
  );
  return JSON.parse(textDecoder.decode(plaintext));
}

export async function clearVaultKeyHierarchy({ userId, keyStore } = {}) {
  const ownerId = normalizeUserId(userId);
  const store = keyStore || (await defaultVaultKeyStore());
  await store.deletePrefix(`umk:${ownerId}:`);
  await store.deletePrefix(`vmk:${ownerId}:`);
  lockedVaultUsers.delete(ownerId);
}

export async function ensureVaultKeyHierarchy({ userId, keyStore } = {}) {
  assertSupported({ keyStore });
  const ownerId = normalizeUserId(userId);
  const store = keyStore || (await defaultVaultKeyStore());
  const vaultMasterKey = await ensureVaultMasterKey({
    store,
    userId: ownerId,
  });
  return {
    userId: ownerId,
    deviceWrapKeyId: DEVICE_WRAP_KEY_ID,
    userMasterKeyId: userMasterKeyId(ownerId),
    vaultMasterKeyId: vaultMasterKeyId(ownerId),
    ready: Boolean(vaultMasterKey),
  };
}

export function lockVault({ userId } = {}) {
  const ownerId = userId ? normalizeUserId(userId) : null;
  if (!ownerId) {
    vaultUnlockExpiresAt.clear();
    return;
  }
  vaultUnlockExpiresAt.delete(ownerId);
  lockedVaultUsers.add(ownerId);
}

export function unlockVault({
  userId,
  ttlMs = DEFAULT_VAULT_UNLOCK_TTL_MS,
} = {}) {
  const ownerId = userId ? normalizeUserId(userId) : null;
  if (!ownerId) return null;
  lockedVaultUsers.delete(ownerId);
  const ttl = Number(ttlMs);
  const expiresAt =
    Number.isFinite(ttl) && ttl > 0
      ? Date.now() + ttl
      : Number.POSITIVE_INFINITY;
  vaultUnlockExpiresAt.set(ownerId, expiresAt);
  return { userId: ownerId, expiresAt };
}

export function vaultIsLocked({ userId } = {}) {
  const ownerId = userId ? normalizeUserId(userId) : null;
  if (!ownerId) return lockedVaultUsers.size > 0;
  expireVaultUnlockIfNeeded(ownerId);
  return lockedVaultUsers.has(ownerId);
}

export function vaultUnlockState({ userId } = {}) {
  const ownerId = userId ? normalizeUserId(userId) : null;
  if (!ownerId) return { locked: lockedVaultUsers.size > 0, expiresAt: null };
  expireVaultUnlockIfNeeded(ownerId);
  return {
    userId: ownerId,
    locked: lockedVaultUsers.has(ownerId),
    expiresAt: vaultUnlockExpiresAt.get(ownerId) || null,
  };
}

export function refreshVaultUnlock({
  userId,
  ttlMs = DEFAULT_VAULT_UNLOCK_TTL_MS,
} = {}) {
  const ownerId = userId ? normalizeUserId(userId) : null;
  if (!ownerId || lockedVaultUsers.has(ownerId)) return null;
  return unlockVault({ userId: ownerId, ttlMs });
}

export function expireVaultUnlocks(now = Date.now()) {
  for (const [userId, expiresAt] of [...vaultUnlockExpiresAt.entries()]) {
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      vaultUnlockExpiresAt.delete(userId);
      lockedVaultUsers.add(userId);
    }
  }
}

export function installVaultAutoLock({
  userId,
  ttlMs = DEFAULT_VAULT_UNLOCK_TTL_MS,
  lockOnHidden = true,
  lockOnBlur = true,
} = {}) {
  if (typeof window === "undefined" || vaultAutoLockCleanup) {
    return vaultAutoLockCleanup || (() => {});
  }
  const ownerId = userId ? normalizeUserId(userId) : null;
  const lockTarget = () => {
    if (ownerId) lockVault({ userId: ownerId });
    else lockVault();
  };
  const refreshTarget = () => {
    if (ownerId && !vaultIsLocked({ userId: ownerId })) {
      refreshVaultUnlock({ userId: ownerId, ttlMs });
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden" && lockOnHidden) lockTarget();
    else refreshTarget();
  };
  const onBlur = () => {
    if (lockOnBlur) lockTarget();
  };
  const interval = window.setInterval(() => expireVaultUnlocks(), 15_000);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", refreshTarget);
  vaultAutoLockCleanup = () => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", refreshTarget);
    vaultAutoLockCleanup = null;
  };
  return vaultAutoLockCleanup;
}

export async function createVaultRecoveryKit({
  userId,
  recoveryCode = null,
  keyStore,
} = {}) {
  assertSupported({ keyStore });
  const ownerId = normalizeUserId(userId);
  const store = keyStore || (await defaultVaultKeyStore());
  const umkId = userMasterKeyId(ownerId);
  const vmkId = vaultMasterKeyId(ownerId);
  const existingUmk = await store.getWrappedKey(umkId);
  const existingVmk = await store.getWrappedKey(vmkId);

  if (existingUmk || existingVmk) {
    return {
      userId: ownerId,
      recoveryReady: false,
      needsRotation: true,
      reason: "vault_recovery_requires_key_rotation",
      userMasterKeyId: umkId,
      vaultMasterKeyId: vmkId,
    };
  }

  const code = normalizeRecoveryCode(recoveryCode || generateRecoveryCode());
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const recoveryWrappingKey = await deriveRecoveryWrappingKey({
    recoveryCode: code,
    salt,
    iterations: VAULT_RECOVERY_ITERATIONS,
  });
  const deviceWrapKey = await ensureDeviceWrapKey(store);

  const userMasterKey = await crypto.subtle.generateKey(
    { name: "AES-KW", length: 256 },
    true,
    ["wrapKey", "unwrapKey"]
  );
  const vaultMasterKey = await crypto.subtle.generateKey(
    { name: "AES-KW", length: 256 },
    true,
    ["wrapKey", "unwrapKey"]
  );

  const wrappedUserMasterKey = await crypto.subtle.wrapKey(
    "raw",
    userMasterKey,
    deviceWrapKey,
    "AES-KW"
  );
  const wrappedVaultMasterKey = await crypto.subtle.wrapKey(
    "raw",
    vaultMasterKey,
    userMasterKey,
    "AES-KW"
  );
  const recoveryWrappedUserMasterKey = await crypto.subtle.wrapKey(
    "raw",
    userMasterKey,
    recoveryWrappingKey,
    "AES-KW"
  );
  const recoveryWrappedVaultMasterKey = await crypto.subtle.wrapKey(
    "raw",
    vaultMasterKey,
    recoveryWrappingKey,
    "AES-KW"
  );

  await store.putWrappedKey(umkId, {
    id: umkId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedUserMasterKey)),
    algorithm: "AES-KW-256",
    createdAt: new Date().toISOString(),
  });
  await store.putWrappedKey(vmkId, {
    id: vmkId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedVaultMasterKey)),
    algorithm: "AES-KW-256",
    createdAt: new Date().toISOString(),
  });

  return {
    userId: ownerId,
    recoveryReady: true,
    needsRotation: false,
    recoveryCode: code,
    recoveryRecord: {
      cryptoVersion: VAULT_RECOVERY_VERSION,
      algorithm: VAULT_RECOVERY_ALGORITHM,
      userId: ownerId,
      userMasterKeyId: umkId,
      vaultMasterKeyId: vmkId,
      iterations: VAULT_RECOVERY_ITERATIONS,
      salt: bytesToBase64Url(salt),
      wrappedUserMasterKey: bytesToBase64Url(
        new Uint8Array(recoveryWrappedUserMasterKey)
      ),
      wrappedVaultMasterKey: bytesToBase64Url(
        new Uint8Array(recoveryWrappedVaultMasterKey)
      ),
      createdAt: new Date().toISOString(),
    },
  };
}

export async function recoverVaultKeyHierarchy({
  userId,
  recoveryCode,
  recoveryRecord,
  keyStore,
} = {}) {
  assertSupported({ keyStore });
  const ownerId = normalizeUserId(userId);
  const record = normalizeRecoveryRecord(recoveryRecord, ownerId);
  const store = keyStore || (await defaultVaultKeyStore());
  const recoveryWrappingKey = await deriveRecoveryWrappingKey({
    recoveryCode,
    salt: base64UrlToBytes(record.salt),
    iterations: record.iterations,
  });
  const userMasterKey = await crypto.subtle.unwrapKey(
    "raw",
    base64UrlToBytes(record.wrappedUserMasterKey),
    recoveryWrappingKey,
    "AES-KW",
    { name: "AES-KW", length: 256 },
    true,
    ["wrapKey", "unwrapKey"]
  );
  const vaultMasterKey = await crypto.subtle.unwrapKey(
    "raw",
    base64UrlToBytes(record.wrappedVaultMasterKey),
    recoveryWrappingKey,
    "AES-KW",
    { name: "AES-KW", length: 256 },
    true,
    ["wrapKey", "unwrapKey"]
  );
  const deviceWrapKey = await ensureDeviceWrapKey(store);
  const wrappedUserMasterKey = await crypto.subtle.wrapKey(
    "raw",
    userMasterKey,
    deviceWrapKey,
    "AES-KW"
  );
  const wrappedVaultMasterKey = await crypto.subtle.wrapKey(
    "raw",
    vaultMasterKey,
    userMasterKey,
    "AES-KW"
  );

  await store.putWrappedKey(record.userMasterKeyId, {
    id: record.userMasterKeyId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedUserMasterKey)),
    algorithm: "AES-KW-256",
    createdAt: new Date().toISOString(),
    recoveredAt: new Date().toISOString(),
  });
  await store.putWrappedKey(record.vaultMasterKeyId, {
    id: record.vaultMasterKeyId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedVaultMasterKey)),
    algorithm: "AES-KW-256",
    createdAt: new Date().toISOString(),
    recoveredAt: new Date().toISOString(),
  });
  unlockVault({ userId: ownerId });
  return ensureVaultKeyHierarchy({ userId: ownerId, keyStore: store });
}

function assertSupported({ keyStore = null } = {}) {
  if (vaultCryptoSupported({ keyStore })) return;
  throw new Error("Vault encryption requires WebCrypto and secure storage.");
}

function normalizeUserId(value) {
  const next = Number(value);
  if (!Number.isInteger(next) || next <= 0) {
    throw new Error("vault_user_required");
  }
  return next;
}

function assertVaultUnlocked(userId) {
  expireVaultUnlockIfNeeded(userId);
  if (lockedVaultUsers.has(userId)) {
    throw new Error("vault_locked");
  }
}

function expireVaultUnlockIfNeeded(userId) {
  const expiresAt = vaultUnlockExpiresAt.get(userId);
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    vaultUnlockExpiresAt.delete(userId);
    lockedVaultUsers.add(userId);
  }
}

function normalizeRecoveryCode(value) {
  const code = String(value || "").trim();
  if (code.length < 20) throw new Error("vault_recovery_code_required");
  return code;
}

function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return bytesToBase64Url(bytes)
    .match(/.{1,4}/g)
    .join("-");
}

async function deriveRecoveryWrappingKey({ recoveryCode, salt, iterations }) {
  const code = normalizeRecoveryCode(recoveryCode);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(code),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: Number(iterations || VAULT_RECOVERY_ITERATIONS),
    },
    baseKey,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

function normalizeRecoveryRecord(record = null, userId) {
  if (!record || typeof record !== "object") {
    throw new Error("vault_recovery_record_required");
  }
  if (record.cryptoVersion !== VAULT_RECOVERY_VERSION) {
    throw new Error("unsupported_vault_recovery_version");
  }
  if (record.algorithm !== VAULT_RECOVERY_ALGORITHM) {
    throw new Error("unsupported_vault_recovery_algorithm");
  }
  if (Number(record.userId) !== Number(userId)) {
    throw new Error("vault_recovery_user_mismatch");
  }
  [
    "userMasterKeyId",
    "vaultMasterKeyId",
    "salt",
    "wrappedUserMasterKey",
    "wrappedVaultMasterKey",
  ].forEach((field) => {
    if (!record[field]) throw new Error(`vault_recovery_missing_${field}`);
  });
  return {
    ...record,
    iterations: Number(record.iterations || VAULT_RECOVERY_ITERATIONS),
  };
}

function userMasterKeyId(userId) {
  return `umk:${userId}:v1`;
}

function vaultMasterKeyId(userId) {
  return `vmk:${userId}:v1`;
}

function itemAdditionalData({ keyId }) {
  return textEncoder.encode(
    JSON.stringify({
      cryptoVersion: VAULT_CRYPTO_VERSION,
      algorithm: VAULT_ALGORITHM,
      keyId,
    })
  );
}

async function ensureDeviceWrapKey(store) {
  const existing = await store.getKey(DEVICE_WRAP_KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
  await store.putKey(DEVICE_WRAP_KEY_ID, key);
  return key;
}

async function ensureVaultMasterKey({ store, userId }) {
  const deviceWrapKey = await ensureDeviceWrapKey(store);
  const userMasterKey = await ensureWrappedAesKwKey({
    store,
    id: userMasterKeyId(userId),
    wrappingKey: deviceWrapKey,
  });
  return ensureWrappedAesKwKey({
    store,
    id: vaultMasterKeyId(userId),
    wrappingKey: userMasterKey,
  });
}

async function ensureWrappedAesKwKey({ store, id, wrappingKey }) {
  const existing = await store.getWrappedKey(id);
  if (existing?.wrappedKey) {
    await store.putWrappedKey(id, { ...existing, __wrappingKey: wrappingKey });
    return crypto.subtle.unwrapKey(
      "raw",
      base64UrlToBytes(existing.wrappedKey),
      wrappingKey,
      "AES-KW",
      { name: "AES-KW", length: 256 },
      false,
      ["wrapKey", "unwrapKey"]
    );
  }

  const extractableKey = await crypto.subtle.generateKey(
    { name: "AES-KW", length: 256 },
    true,
    ["wrapKey", "unwrapKey"]
  );
  const wrappedKey = await crypto.subtle.wrapKey(
    "raw",
    extractableKey,
    wrappingKey,
    "AES-KW"
  );
  const record = {
    id,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
    algorithm: "AES-KW-256",
    createdAt: new Date().toISOString(),
    __wrappingKey: wrappingKey,
  };
  await store.putWrappedKey(id, record);
  return crypto.subtle.unwrapKey(
    "raw",
    wrappedKey,
    wrappingKey,
    "AES-KW",
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

function normalizeEncryptedPayload(payload = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("vault_encrypted_payload_required");
  }
  if (payload.cryptoVersion !== VAULT_CRYPTO_VERSION) {
    throw new Error("unsupported_vault_crypto_version");
  }
  if (payload.algorithm !== VAULT_ALGORITHM) {
    throw new Error("unsupported_vault_algorithm");
  }
  ["keyId", "wrappedItemKey", "iv", "ciphertext"].forEach((field) => {
    if (!payload[field]) throw new Error(`vault_payload_missing_${field}`);
  });
  return payload;
}

async function defaultVaultKeyStore() {
  if (globalThis.__athenaVaultKeyStore) {
    return globalThis.__athenaVaultKeyStore;
  }
  const db = await openDb();
  return {
    async getKey(id) {
      return getRecord(db, KEY_STORE, id).then((record) => record?.key || null);
    },
    async putKey(id, key) {
      return putRecord(db, KEY_STORE, { id, key });
    },
    async getWrappedKey(id) {
      return getRecord(db, WRAPPED_KEY_STORE, id);
    },
    async putWrappedKey(id, value) {
      const { __wrappingKey: _ephemeral, ...stored } = value;
      return putRecord(db, WRAPPED_KEY_STORE, stored);
    },
    async deletePrefix(prefix) {
      await deleteByPrefix(db, KEY_STORE, prefix);
      await deleteByPrefix(db, WRAPPED_KEY_STORE, prefix);
    },
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(WRAPPED_KEY_STORE)) {
        db.createObjectStore(WRAPPED_KEY_STORE, { keyPath: "id" });
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

function deleteByPrefix(db, storeName, prefix) {
  return storeRequest(db, storeName, "readwrite", (store) => {
    const request = store.getAllKeys();
    request.onsuccess = () => {
      (request.result || [])
        .filter((key) => String(key).startsWith(prefix))
        .forEach((key) => store.delete(key));
    };
    return request;
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
