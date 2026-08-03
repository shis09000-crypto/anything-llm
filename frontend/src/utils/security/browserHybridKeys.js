import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { getClientIdentity } from "@/lib/communication/clientIdentity";
import {
  getDeviceIdentityKeyRecord,
  signWithDeviceIdentityKey,
} from "@/lib/communication/deviceIdentityKey";

export const VAULT_HYBRID_SUITE = "vault-xwing-mldsa65-v1";
export const REQUEST_PQ_SUITE = "request-device-mldsa65-v1";
export const REQUEST_HYBRID_SUITE = "device-hybrid-p256-mldsa65-v1";

const DB_NAME = "athena-browser-hybrid-keys";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const RECORD_STORE = "records";
const WRAP_KEY_ID = "browser-hybrid-wrap-key:v1";
const encoder = new TextEncoder();
let cached = null;

function base64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    ""
  );
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        db.createObjectStore(RECORD_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestRecord(db, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function wrapKey(db) {
  const existing = await requestRecord(db, KEY_STORE, "readonly", (store) =>
    store.get(WRAP_KEY_ID)
  );
  if (existing?.key) return existing.key;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  await requestRecord(db, KEY_STORE, "readwrite", (store) =>
    store.put({ id: WRAP_KEY_ID, key })
  );
  return key;
}

function p256X963(publicKey) {
  const jwk = JSON.parse(publicKey);
  return base64Url(
    new Uint8Array([0x04, ...fromBase64Url(jwk.x), ...fromBase64Url(jwk.y)])
  );
}

async function decryptRecord(db, record) {
  const key = await wrapKey(db);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(record.iv) },
    key,
    fromBase64Url(record.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function encryptRecord(db, id, value) {
  const key = await wrapKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(value))
  );
  await requestRecord(db, RECORD_STORE, "readwrite", (store) =>
    store.put({
      id,
      iv: base64Url(iv),
      ciphertext: base64Url(new Uint8Array(ciphertext)),
      updatedAt: new Date().toISOString(),
    })
  );
}

async function loadExisting() {
  if (cached) return cached;
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) return null;
  const { clientId } = getClientIdentity();
  if (!clientId) return null;
  const db = await openDb();
  const record = await requestRecord(db, RECORD_STORE, "readonly", (store) =>
    store.get(`hybrid:${clientId}:v1`)
  );
  if (!record) return null;
  const secrets = await decryptRecord(db, record);
  cached = {
    clientId,
    keyGeneration: Number(secrets.keyGeneration || 1),
    pqSecretKey: fromBase64Url(secrets.pqSecretKey),
    pqPublicKey: secrets.pqPublicKey,
    kemSecretKey: fromBase64Url(secrets.kemSecretKey),
    kemPublicKey: secrets.kemPublicKey,
  };
  return cached;
}

export async function ensureBrowserHybridKeys() {
  const existing = await loadExisting();
  if (existing) return registration(existing);
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) {
    throw new Error("browser_hybrid_crypto_unavailable");
  }
  const { clientId } = getClientIdentity();
  if (!clientId) throw new Error("browser_client_identity_unavailable");
  const p256 = await getDeviceIdentityKeyRecord();
  if (!p256?.publicKey) throw new Error("browser_p256_key_unavailable");
  const pq = ml_dsa65.keygen();
  const kem = ml_kem768_x25519.keygen();
  cached = {
    clientId,
    keyGeneration: 1,
    pqSecretKey: pq.secretKey,
    pqPublicKey: base64Url(pq.publicKey),
    kemSecretKey: kem.secretKey,
    kemPublicKey: base64Url(kem.publicKey),
  };
  const db = await openDb();
  await encryptRecord(db, `hybrid:${clientId}:v1`, {
    keyGeneration: 1,
    pqSecretKey: base64Url(pq.secretKey),
    pqPublicKey: cached.pqPublicKey,
    kemSecretKey: base64Url(kem.secretKey),
    kemPublicKey: cached.kemPublicKey,
  });
  return registration(cached, p256);
}

async function registration(keys, p256Record = null) {
  const p256 = p256Record || (await getDeviceIdentityKeyRecord());
  return {
    clientId: keys.clientId,
    keyGeneration: keys.keyGeneration,
    kemSuiteId: VAULT_HYBRID_SUITE,
    kemPublicKey: keys.kemPublicKey,
    p256PublicKey: p256X963(p256.publicKey),
    mlDSA65PublicKey: keys.pqPublicKey,
  };
}

export async function signWithPostQuantumDeviceKey(value) {
  const keys = await loadExisting();
  if (!keys) return null;
  const signature = ml_dsa65.sign(
    encoder.encode(String(value)),
    keys.pqSecretKey
  );
  return {
    signature: base64Url(signature),
    publicKey: keys.pqPublicKey,
    keyAlgorithm: REQUEST_PQ_SUITE,
    hybridSignatureVersion: REQUEST_HYBRID_SUITE,
    keyOrigin: "browser-indexeddb",
    hardwareProtection: "browser-webcrypto-wrapped",
  };
}

export async function signBrowserRootPayload(value) {
  const keys = await loadExisting();
  if (!keys) throw new Error("browser_hybrid_keys_unavailable");
  const classical = await signWithDeviceIdentityKey(String(value));
  if (!classical?.signature) throw new Error("browser_p256_signing_failed");
  return {
    p256Signature: classical.signature,
    mlDSA65Signature: base64Url(
      ml_dsa65.sign(encoder.encode(String(value)), keys.pqSecretKey)
    ),
  };
}

export async function createDeviceBindingAssertion(challenge = {}) {
  const challengeId = String(challenge?.challengeId || "");
  const challengeValue = String(challenge?.challenge || "");
  if (!challengeId || !challengeValue) {
    throw new Error("device_binding_challenge_invalid");
  }
  const registration = await ensureBrowserHybridKeys();
  const proof = [
    "athena-device-binding-preflight:v1",
    challengeId,
    challengeValue,
    registration.clientId,
  ].join("\n");
  const [p256, postQuantum] = await Promise.all([
    signWithDeviceIdentityKey(proof),
    signWithPostQuantumDeviceKey(proof),
  ]);
  if (!p256?.signature || !postQuantum?.signature) {
    throw new Error("device_binding_proof_unavailable");
  }
  return {
    challengeId,
    challenge: challengeValue,
    p256: {
      publicKey: p256.publicKey,
      keyAlgorithm: p256.algorithm,
      signature: p256.signature,
    },
    postQuantum: {
      publicKey: postQuantum.publicKey,
      keyAlgorithm: postQuantum.keyAlgorithm,
      hybridSignatureVersion: postQuantum.hybridSignatureVersion,
      signature: postQuantum.signature,
    },
  };
}

export async function encapsulateForBrowser(kemPublicKey) {
  const result = ml_kem768_x25519.encapsulate(fromBase64Url(kemPublicKey));
  return {
    encapsulatedKey: base64Url(result.cipherText),
    sharedSecret: result.sharedSecret,
  };
}

export async function decapsulateForBrowser(encapsulatedKey) {
  const keys = await loadExisting();
  if (!keys) throw new Error("browser_hybrid_keys_unavailable");
  return ml_kem768_x25519.decapsulate(
    fromBase64Url(encapsulatedKey),
    keys.kemSecretKey
  );
}

export async function storeBrowserRoot(authUserId, rootEpoch, material) {
  const db = await openDb();
  await encryptRecord(
    db,
    `root:${Number(authUserId)}:${Number(rootEpoch)}`,
    material
  );
}

export async function loadBrowserRoot(authUserId, rootEpoch) {
  const db = await openDb();
  const record = await requestRecord(db, RECORD_STORE, "readonly", (store) =>
    store.get(`root:${Number(authUserId)}:${Number(rootEpoch)}`)
  );
  return record ? decryptRecord(db, record) : null;
}

export const browserHybridEncoding = {
  base64Url,
  fromBase64Url,
};
