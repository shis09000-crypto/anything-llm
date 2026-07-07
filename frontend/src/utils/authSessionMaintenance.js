export const DEV_AUTH_REFRESH_TOAST_ID = "athena-dev-auth-refresh";

const TRANSIENT_ERROR_CODES = new Set([
  "API_ERROR",
  "API_TIMEOUT_ERROR",
  "HTTP_OPEN_ERROR",
]);
const EXPLICIT_AUTH_STATUSES = new Set([401, 403]);

function statusFrom(source = {}) {
  const status = source?.status ?? source?.response?.status ?? 0;
  return Number.isFinite(Number(status)) ? Number(status) : 0;
}

function codeFrom(source = {}) {
  return String(source?.code || source?.raw?.code || "").trim();
}

function messageFrom(source = {}) {
  return String(
    source?.message ||
      source?.raw?.error ||
      source?.raw?.message ||
      source?.error ||
      ""
  ).trim();
}

export function isDevelopmentAuthMaintenanceEnabled() {
  return !!import.meta.env?.DEV && typeof window !== "undefined";
}

export function isExplicitAuthFailure(source = {}) {
  const status = statusFrom(source);
  if (EXPLICIT_AUTH_STATUSES.has(status)) return true;

  const message = messageFrom(source);
  return /session expired|invalid auth|user is suspended|account.*disabled/i.test(
    message
  );
}

export function isTransientAuthFailure(source = {}) {
  const status = statusFrom(source);
  if (status >= 500) return true;
  if (status === 0 && TRANSIENT_ERROR_CODES.has(codeFrom(source))) return true;

  const message = messageFrom(source);
  return /failed to fetch|networkerror|load failed|timed out|could not refresh user|unable to connect/i.test(
    message
  );
}

export function classifyAuthRefreshResult(result = {}) {
  if (result?.success) return "valid";
  if (isExplicitAuthFailure(result)) return "invalid";
  if (isTransientAuthFailure(result)) return "transient";
  return "invalid";
}

export function shouldPreserveLocalAuthOnFailure(source = {}) {
  return !isExplicitAuthFailure(source) && isTransientAuthFailure(source);
}

export function authMaintenanceRetryDelayMs(attempt = 0) {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  return Math.min(1_000 * 2 ** Math.min(safeAttempt, 4), 10_000);
}
