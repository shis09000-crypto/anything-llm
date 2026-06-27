import { ZK_LOGIN_DEVICE_INDEX } from "@/utils/constants";
import { safeJsonParse } from "@/utils/request";

const DB_NAME = "athena-zk-login";
const DB_VERSION = 1;
const DEVICE_STORE = "devices";
const KEY_STORE = "keys";
const WRAP_KEY_ID = "device-secret-wrap-key";
const UNSUPPORTED_ZK_MESSAGE =
  "零知识快速登录需要 HTTPS 或 localhost。手机局域网 HTTP 地址无法保存可信设备。";

export function zkLoginStorageSupported() {
  return Boolean(
    globalThis.isSecureContext &&
      globalThis.indexedDB &&
      globalThis.crypto?.subtle
  );
}

function assertZkLoginStorageSupported() {
  if (zkLoginStorageSupported()) return;
  throw new Error(UNSUPPORTED_ZK_MESSAGE);
}

export async function createLocalZkDevice({ user, deviceName, avatarUrl }) {
  assertZkLoginStorageSupported();
  const deviceId = randomBase64Url(24);
  const deviceSecret = randomBase64Url(48);
  const deviceSalt = randomBase64Url(24);
  const metadata = {
    deviceId,
    userId: accountAuthUserId(user) || user?.id,
    username: user?.username || "Account",
    displayName: user?.displayName || null,
    avatarUrl: avatarUrl || null,
    deviceName: deviceName || deviceLabel(),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  return { deviceId, deviceSecret, deviceSalt, metadata };
}

export async function saveLocalZkDevice({ metadata, deviceSecret }) {
  assertZkLoginStorageSupported();
  const db = await openDb();
  const wrapKey = await getWrapKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedSecret = new TextEncoder().encode(deviceSecret);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrapKey,
    encodedSecret
  );
  await putRecord(db, DEVICE_STORE, {
    ...metadata,
    wrappedSecret: bytesToBase64Url(new Uint8Array(encrypted)),
    iv: bytesToBase64Url(iv),
  });
  updateDeviceIndex(metadata);
}

export async function listLocalZkDevices() {
  assertZkLoginStorageSupported();
  const db = await openDb();
  return getAllRecords(db, DEVICE_STORE);
}

export async function getPreferredLocalZkDevice() {
  const devices = await listLocalZkDevices();
  return devices
    .filter((device) => device?.deviceId && device?.userId)
    .map((device) => ({
      ...device,
      avatarUrl: durableAvatarUrl(device.avatarUrl),
    }))
    .sort((a, b) => {
      const aTime = new Date(a.lastUsedAt || a.createdAt || 0).getTime();
      const bTime = new Date(b.lastUsedAt || b.createdAt || 0).getTime();
      return bTime - aTime;
    })[0];
}

export async function readLocalZkDeviceSecret(deviceId) {
  assertZkLoginStorageSupported();
  const db = await openDb();
  const device = await getRecord(db, DEVICE_STORE, deviceId);
  if (!device?.wrappedSecret || !device?.iv) return null;
  const wrapKey = await getWrapKey(db);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(device.iv) },
    wrapKey,
    base64UrlToBytes(device.wrappedSecret)
  );
  return new TextDecoder().decode(decrypted);
}

export async function updateLocalZkDevice(deviceId, updates = {}) {
  assertZkLoginStorageSupported();
  const db = await openDb();
  const device = await getRecord(db, DEVICE_STORE, deviceId);
  if (!device) return;
  const next = { ...device, ...updates };
  await putRecord(db, DEVICE_STORE, next);
  updateDeviceIndex(next);
}

export async function syncLocalZkDevicesWithServer({
  user,
  devices = [],
  avatarUrl = null,
} = {}) {
  const serverDevices = new Map(
    devices
      .filter((device) => device?.deviceId)
      .map((device) => [device.deviceId, device])
  );
  if (serverDevices.size === 0) return;

  const localDevices = await listLocalZkDevices();
  await Promise.all(
    localDevices.map((localDevice) => {
      const serverDevice = serverDevices.get(localDevice?.deviceId);
      if (!serverDevice) return null;

      return updateLocalZkDevice(localDevice.deviceId, {
        ...serverDevice,
        userId:
          serverDevice.userId || accountAuthUserId(user) || localDevice.userId,
        username: user?.username || localDevice.username,
        displayName: user?.displayName || localDevice.displayName || null,
        avatarUrl: durableAvatarUrl(avatarUrl) || localDevice.avatarUrl || null,
        createdAt: serverDevice.createdAt || localDevice.createdAt,
        lastUsedAt: serverDevice.lastUsedAt || localDevice.lastUsedAt || null,
      });
    })
  );
}

export async function removeLocalZkDevice(deviceId) {
  assertZkLoginStorageSupported();
  const db = await openDb();
  await deleteRecord(db, DEVICE_STORE, deviceId);
  const index = localDeviceIndex().filter(
    (device) => device.deviceId !== deviceId
  );
  window.localStorage.setItem(ZK_LOGIN_DEVICE_INDEX, JSON.stringify(index));
}

export async function clearLocalZkDevices() {
  assertZkLoginStorageSupported();
  const db = await openDb();
  await storeRequest(db, DEVICE_STORE, "readwrite", (store) => store.clear());
  window.localStorage.removeItem(ZK_LOGIN_DEVICE_INDEX);
}

export function localDeviceIndex() {
  return safeJsonParse(window.localStorage.getItem(ZK_LOGIN_DEVICE_INDEX), []);
}

function updateDeviceIndex(metadata) {
  const index = localDeviceIndex().filter(
    (device) => device.deviceId !== metadata.deviceId
  );
  index.unshift({
    deviceId: metadata.deviceId,
    userId: metadata.userId,
    username: metadata.username,
    displayName: metadata.displayName || null,
    avatarUrl: durableAvatarUrl(metadata.avatarUrl),
    hasAvatar: Boolean(durableAvatarUrl(metadata.avatarUrl)),
    deviceName: metadata.deviceName,
    createdAt: metadata.createdAt,
    lastUsedAt: metadata.lastUsedAt || null,
  });
  window.localStorage.setItem(ZK_LOGIN_DEVICE_INDEX, JSON.stringify(index));
}

function durableAvatarUrl(value) {
  if (!value || String(value).startsWith("blob:")) return null;
  return value;
}

function accountAuthUserId(user = null) {
  const authUserId = Number(user?.authUserId);
  if (Number.isFinite(authUserId) && authUserId > 0) return authUserId;
  return null;
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
      if (!db.objectStoreNames.contains(DEVICE_STORE)) {
        db.createObjectStore(DEVICE_STORE, { keyPath: "deviceId" });
      }
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

function getAllRecords(db, storeName) {
  return storeRequest(db, storeName, "readonly", (store) => store.getAll());
}

function putRecord(db, storeName, value) {
  return storeRequest(db, storeName, "readwrite", (store) => store.put(value));
}

function deleteRecord(db, storeName, key) {
  return storeRequest(db, storeName, "readwrite", (store) => store.delete(key));
}

function storeRequest(db, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    ""
  );
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "="
  );
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function deviceLabel() {
  const platform = navigator.platform || "this device";
  if (/Mac/.test(platform)) return "Mac";
  if (/iPhone/.test(navigator.userAgent)) return "iPhone";
  if (/iPad/.test(navigator.userAgent)) return "iPad";
  if (/Win/.test(platform)) return "Windows PC";
  if (/Android/.test(navigator.userAgent)) return "Android Device";
  return "This Device";
}
