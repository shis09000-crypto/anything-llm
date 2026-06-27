import { AUTH_TOKEN } from "@/utils/constants";

export const AUTH_TOKEN_STORAGE_MODE = "session";
export const AUTH_SESSION_CLEARED_EVENT = "athena-auth-session-cleared";
export const SIGNING_SECRET_SESSION_PREFIX = "athena_signing_secret_v1:";

function safeLocalStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeSessionStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function clearSigningSecretSessionStorage() {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(SIGNING_SECRET_SESSION_PREFIX)) {
        storage.removeItem(key);
      }
    }
  } catch {}
}

function notifyAuthSessionCleared() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(AUTH_SESSION_CLEARED_EVENT));
  } catch {}
}

export function getAuthToken() {
  const sessionToken = safeSessionStorage()?.getItem(AUTH_TOKEN);
  if (sessionToken) return sessionToken;

  const localStorage = safeLocalStorage();
  const legacyToken = localStorage?.getItem(AUTH_TOKEN);
  if (!legacyToken) return null;

  setAuthToken(legacyToken);
  return legacyToken;
}

export function setAuthToken(token) {
  const normalized = token ? String(token) : "";
  const sessionStorage = safeSessionStorage();
  const localStorage = safeLocalStorage();

  if (!normalized) {
    removeAuthToken();
    return null;
  }

  sessionStorage?.setItem(AUTH_TOKEN, normalized);
  localStorage?.removeItem(AUTH_TOKEN);
  return normalized;
}

export function removeAuthToken() {
  safeSessionStorage()?.removeItem(AUTH_TOKEN);
  safeLocalStorage()?.removeItem(AUTH_TOKEN);
  clearSigningSecretSessionStorage();
  notifyAuthSessionCleared();
}

export function hasAuthToken() {
  return !!getAuthToken();
}
