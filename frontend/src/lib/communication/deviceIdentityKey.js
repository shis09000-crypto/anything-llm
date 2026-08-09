import {
  CRYPTO_SUITE_IDS,
  CRYPTO_SUITE_PURPOSES,
  cryptoSuite,
} from "./cryptoSuiteRegistry";

const DB_NAME = "athena-device-identity";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const KEY_ID = "p256-signing-key-v1";
const DEVICE_KEY_SUITE = cryptoSuite(
  CRYPTO_SUITE_IDS.deviceP256WebCryptoV1,
  CRYPTO_SUITE_PURPOSES.deviceKey
);
if (!DEVICE_KEY_SUITE) throw new Error("device_key_crypto_suite_unavailable");
const DEVICE_KEY_ALGORITHM = DEVICE_KEY_SUITE.suiteId;
const DEVICE_KEY_SELF_TEST = new TextEncoder().encode(
  "athena-device-identity-key-self-test:v1"
);

let cachedKeyRecord = null;

function webCrypto() {
  return globalThis.crypto?.subtle || null;
}

function indexedDb() {
  if (typeof window === "undefined") return null;
  return window.indexedDB || null;
}

function bytesToBase64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    ""
  );
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : globalThis.Buffer.from(binary, "binary").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function canonicalPublicJwk(publicJwk) {
  if (!publicJwk || publicJwk.kty !== "EC" || publicJwk.crv !== "P-256") {
    return null;
  }
  return JSON.stringify({
    kty: "EC",
    crv: "P-256",
    x: publicJwk.x,
    y: publicJwk.y,
    ext: true,
    key_ops: ["verify"],
  });
}

function openDb() {
  const idb = indexedDb();
  if (!idb) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readKeyRecord() {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(KEY_ID);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeKeyRecord(record) {
  const db = await openDb();
  if (!db) return false;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_NAME).put(record);
  });
}

async function deleteKeyRecord() {
  const db = await openDb();
  if (!db) return false;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_NAME).delete(KEY_ID);
  });
}

async function generateKeyRecord() {
  const subtle = webCrypto();
  if (!subtle) return null;

  const keyPair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  );
  const publicJwk = await subtle.exportKey("jwk", keyPair.publicKey);
  const publicKey = canonicalPublicJwk(publicJwk);
  if (!publicKey) return null;

  return {
    id: KEY_ID,
    algorithm: DEVICE_KEY_ALGORITHM,
    publicKey,
    privateKey: keyPair.privateKey,
    createdAt: new Date().toISOString(),
  };
}

async function isConsistentKeyRecord(record) {
  const subtle = webCrypto();
  if (!subtle || !record?.privateKey || !record?.publicKey) return false;

  try {
    const publicJwk = JSON.parse(record.publicKey);
    const publicKey = await subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const signature = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      record.privateKey,
      DEVICE_KEY_SELF_TEST
    );
    return await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      DEVICE_KEY_SELF_TEST
    );
  } catch {
    return false;
  }
}

export async function getDeviceIdentityKeyRecord() {
  if (cachedKeyRecord) return cachedKeyRecord;
  const subtle = webCrypto();
  if (!subtle) return null;

  try {
    const stored = await readKeyRecord();
    if (await isConsistentKeyRecord(stored)) {
      cachedKeyRecord = stored;
      return cachedKeyRecord;
    }

    const generated = await generateKeyRecord();
    if (!generated) return null;
    await writeKeyRecord(generated);
    cachedKeyRecord = generated;
    return cachedKeyRecord;
  } catch {
    return null;
  }
}

export async function signWithDeviceIdentityKey(value) {
  const subtle = webCrypto();
  const record = await getDeviceIdentityKeyRecord();
  if (!subtle || !record?.privateKey || !record?.publicKey) return null;

  const signature = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    record.privateKey,
    new TextEncoder().encode(String(value))
  );

  return {
    algorithm: record.algorithm || DEVICE_KEY_ALGORITHM,
    publicKey: record.publicKey,
    signature: bytesToBase64Url(new Uint8Array(signature)),
  };
}

export function clearDeviceIdentityKeyCache() {
  cachedKeyRecord = null;
}

export async function deleteDeviceIdentityKeyRecord() {
  cachedKeyRecord = null;
  try {
    return await deleteKeyRecord();
  } catch {
    return false;
  }
}
