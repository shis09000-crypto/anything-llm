import { AUTH_USER } from "@/utils/constants";

const SENSITIVE_USER_FIELD_PATTERN =
  /(password|token|secret|api.?key|private.?key|credential|challenge|recovery|totp|mfa|salt|hash|session|jwt|signing)/i;

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

function safeJsonParse(value, fallback = null) {
  try {
    if (value === null || value === undefined) return fallback;
    return JSON.parse(value);
  } catch {}
  return fallback;
}

function storageSafeValue(value) {
  if (value === null || value === undefined) return value;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    return value
      .filter((item) => ["string", "number", "boolean"].includes(typeof item))
      .slice(0, 20);
  }
  return undefined;
}

export function sanitizeStoredAuthUser(user = null) {
  if (!user || typeof user !== "object") return null;
  const sanitized = {};
  for (const [key, value] of Object.entries(user)) {
    if (SENSITIVE_USER_FIELD_PATTERN.test(key)) continue;
    const next = storageSafeValue(value);
    if (next !== undefined) sanitized[key] = next;
  }
  return Object.keys(sanitized).length ? sanitized : null;
}

export function getStoredAuthUser() {
  const sessionStorage = safeSessionStorage();
  const sessionUser = safeJsonParse(sessionStorage?.getItem(AUTH_USER), null);
  if (sessionUser) return sanitizeStoredAuthUser(sessionUser);

  const localStorage = safeLocalStorage();
  const legacyUser = safeJsonParse(localStorage?.getItem(AUTH_USER), null);
  if (!legacyUser) return null;

  const sanitized = sanitizeStoredAuthUser(legacyUser);
  if (sanitized) sessionStorage?.setItem(AUTH_USER, JSON.stringify(sanitized));
  localStorage?.removeItem(AUTH_USER);
  return sanitized;
}

export function hasStoredAuthUser() {
  return !!getStoredAuthUser();
}

export function setStoredAuthUser(user = null) {
  const sessionStorage = safeSessionStorage();
  const localStorage = safeLocalStorage();
  localStorage?.removeItem(AUTH_USER);

  const sanitized = sanitizeStoredAuthUser(user);
  if (!sanitized) {
    sessionStorage?.removeItem(AUTH_USER);
    return null;
  }

  sessionStorage?.setItem(AUTH_USER, JSON.stringify(sanitized));
  return sanitized;
}

export function patchStoredAuthUser(updates = {}) {
  const current = getStoredAuthUser();
  if (!current) return null;
  return setStoredAuthUser({ ...current, ...updates });
}

export function removeStoredAuthUser() {
  safeSessionStorage()?.removeItem(AUTH_USER);
  safeLocalStorage()?.removeItem(AUTH_USER);
}
