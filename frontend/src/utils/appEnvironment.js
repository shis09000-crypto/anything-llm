import { fetchSystemEnvironment } from "@/lib/communication/systemRuntimeClient";

export const DEFAULT_APP_ENV = "production";
export const APP_ENVIRONMENT_CHANGE_EVENT = "anythingllm-app-env-change";

const VALID_APP_ENVS = new Set(["production", "development"]);
const ENV_STORAGE_PREFIX = "anythingllm_env";

let currentAppEnv = DEFAULT_APP_ENV;
let storageScopeInstalled = false;

function normalizeAppEnv(value = DEFAULT_APP_ENV) {
  const normalized = String(value || DEFAULT_APP_ENV)
    .trim()
    .toLowerCase();
  return VALID_APP_ENVS.has(normalized) ? normalized : DEFAULT_APP_ENV;
}

export function getAppEnvironment() {
  return currentAppEnv;
}

export function isDevelopmentEnvironment() {
  return getAppEnvironment() === "development";
}

function setAppEnvironment(value = DEFAULT_APP_ENV, detail = {}) {
  const nextEnv = normalizeAppEnv(value);
  if (currentAppEnv === nextEnv) return currentAppEnv;
  currentAppEnv = nextEnv;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(APP_ENVIRONMENT_CHANGE_EVENT, {
        detail: { appEnv: currentAppEnv, ...detail },
      })
    );
  }
  return currentAppEnv;
}

export function envStorageKey(baseKey = "") {
  const key = String(baseKey || "");
  if (!key) return key;
  if (key.startsWith(`${ENV_STORAGE_PREFIX}:`)) return key;
  return `${ENV_STORAGE_PREFIX}:${getAppEnvironment()}:${key}`;
}

function unscopedStorageKey(scopedKey = "") {
  const prefix = `${ENV_STORAGE_PREFIX}:${getAppEnvironment()}:`;
  const key = String(scopedKey || "");
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

export function envIndexedDbName(baseName = "") {
  return envStorageKey(baseName);
}

function shouldScopeStorageKey(key = "") {
  const value = String(key || "");
  if (!value) return false;
  if (value.startsWith(`${ENV_STORAGE_PREFIX}:`)) return false;
  return true;
}

function scopedKey(key = "") {
  return shouldScopeStorageKey(key) ? envStorageKey(key) : key;
}

export function installEnvironmentStorageScope() {
  if (storageScopeInstalled || typeof window === "undefined") return;
  if (typeof Storage === "undefined") return;

  const proto = Storage.prototype;
  const originalGetItem = proto.getItem;
  const originalSetItem = proto.setItem;
  const originalRemoveItem = proto.removeItem;
  const originalKey = proto.key;

  proto.getItem = function getItem(key) {
    return originalGetItem.call(this, scopedKey(key));
  };

  proto.setItem = function setItem(key, value) {
    return originalSetItem.call(this, scopedKey(key), value);
  };

  proto.removeItem = function removeItem(key) {
    return originalRemoveItem.call(this, scopedKey(key));
  };

  proto.key = function key(index) {
    const rawKey = originalKey.call(this, index);
    if (!rawKey) return rawKey;
    return unscopedStorageKey(rawKey);
  };

  proto.clear = function clear() {
    const keys = [];
    for (let index = 0; index < this.length; index += 1) {
      const rawKey = originalKey.call(this, index);
      if (unscopedStorageKey(rawKey)) keys.push(rawKey);
    }
    keys.forEach((key) => originalRemoveItem.call(this, key));
  };

  storageScopeInstalled = true;
}

export function storageKeys(storage = null) {
  if (!storage) return [];
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) keys.push(key);
  }
  return keys;
}

export function scopedStorageKeyPrefix() {
  return `${ENV_STORAGE_PREFIX}:${getAppEnvironment()}:`;
}

export async function loadAppEnvironment() {
  try {
    const { data: payload } = await fetchSystemEnvironment({
      timeoutMs: 1_500,
    });
    return setAppEnvironment(payload?.environment?.appEnv, {
      environment: payload?.environment || null,
    });
  } catch {
    return setAppEnvironment(DEFAULT_APP_ENV, { environment: null });
  }
}
