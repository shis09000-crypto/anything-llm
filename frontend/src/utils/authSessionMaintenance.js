import {
  authReasonFrom,
  isTerminalAuthReason,
} from "@/utils/authLifecycleCoordinator";

export const DEV_AUTH_REFRESH_TOAST_ID = "athena-dev-auth-refresh";

const TRANSIENT_ERROR_CODES = new Set([
  "API_ERROR",
  "API_TIMEOUT_ERROR",
  "HTTP_OPEN_ERROR",
]);

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
  return isTerminalAuthReason(authReasonFrom(source));
}

export function isTransientAuthFailure(source = {}) {
  const status = statusFrom(source);
  if ([401, 403, 429].includes(status) && !isExplicitAuthFailure(source))
    return true;
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
  // Ambiguous business 401/403 and malformed upstream failures are not proof
  // that Identity revoked the session. Keep the local session until the
  // Identity-owned validation endpoint returns a terminal reason.
  return "transient";
}

export function shouldPreserveLocalAuthOnFailure(source = {}) {
  return !isExplicitAuthFailure(source) && isTransientAuthFailure(source);
}

export function classifyDeviceBindingPreflightFailure(error = {}) {
  const status = statusFrom(error);
  const transportFailure = error?.deviceBindingStage === "transport";
  const serviceUnavailable =
    transportFailure && (status === 0 || status >= 500);
  return {
    status,
    serviceUnavailable,
    errorCode:
      String(error?.code || error?.message || "").trim() ||
      "device_binding_preflight_failed",
    message: serviceUnavailable
      ? "登录服务暂时不可用，请稍后重试。"
      : "无法读取或验证此设备的安全密钥。",
  };
}

export function authMaintenanceRetryDelayMs(attempt = 0) {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  return Math.min(1_000 * 2 ** Math.min(safeAttempt, 4), 10_000);
}
