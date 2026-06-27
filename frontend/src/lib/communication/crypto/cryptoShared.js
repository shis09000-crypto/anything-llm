import { API_BASE, fullApiUrl } from "@/utils/constants";
import { assertSecureWebSocketUrl } from "../transportSecurity";
import { getAuthToken } from "@/utils/authTokenStorage";

export const CRYPTO_CENTER_DEV_AUTH_BYPASS_HEADER =
  "x-crypto-center-dev-auth-bypass";
export const CRYPTO_HUB_BASE = `${API_BASE}/crypto-hub`;

export function cryptoDevBypassActive() {
  if (import.meta.env.PROD || typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search || "");
  const value = params.get("cryptoCenterAuthBypass");
  return value === "1" || value === "true";
}

export function cryptoRequestHeaders(headers = {}) {
  return {
    ...(cryptoDevBypassActive()
      ? { [CRYPTO_CENTER_DEV_AUTH_BYPASS_HEADER]: "1" }
      : {}),
    ...headers,
  };
}

export function cryptoHubPath(path = "", query = null) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const queryString =
    query instanceof URLSearchParams
      ? query.toString()
      : query && typeof query === "object"
        ? new URLSearchParams(cleanQuery(query)).toString()
        : "";
  return `/crypto-hub${normalizedPath}${queryString ? `?${queryString}` : ""}`;
}

export function cryptoCenterPath(path = "", query = null) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const queryString =
    query instanceof URLSearchParams
      ? query.toString()
      : query && typeof query === "object"
        ? new URLSearchParams(cleanQuery(query)).toString()
        : "";
  return `${normalizedPath}${queryString ? `?${queryString}` : ""}`;
}

function cleanQuery(query = {}) {
  return Object.fromEntries(
    Object.entries(query).filter(
      ([, value]) => value !== null && value !== undefined
    )
  );
}

export function cryptoCenterStreamUrl(range) {
  const token = typeof window === "undefined" ? null : getAuthToken();
  const url = new URL("crypto-center/stream", `${fullApiUrl()}/`);
  url.searchParams.set("range", range);
  if (token) url.searchParams.set("token", token);
  if (cryptoDevBypassActive())
    url.searchParams.set("cryptoCenterAuthBypass", "1");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return assertSecureWebSocketUrl(url.toString(), {
    kind: "crypto_center_websocket",
  });
}

export function cryptoError(error, fallback = "Crypto request failed") {
  const raw =
    error?.raw && typeof error.raw === "object" && !(error.raw instanceof Error)
      ? error.raw
      : null;
  const message =
    raw?.safeErrorMessage ||
    raw?.error ||
    raw?.message ||
    error?.message ||
    fallback;
  const next = new Error(message);
  next.code = error?.code;
  next.status = error?.status;
  next.details = error?.details || null;
  next.raw = raw || error?.raw || null;
  return next;
}

export function cryptoPayloadError(
  payload,
  fallback = "Crypto request failed"
) {
  return cryptoError({ raw: payload }, fallback);
}

export function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function durationSince(startedAt) {
  return Math.round(nowMs() - startedAt);
}

export function cryptoDevLog(phase, metadata = {}) {
  if (!import.meta.env.DEV) return;
  const {
    requestId = null,
    cryptoKind = "crypto",
    path = null,
    status = null,
    durationMs = null,
    result = null,
  } = metadata;
  console.debug(`[cryptoCommunication] ${phase}`, {
    requestId,
    cryptoKind,
    path,
    status,
    durationMs,
    result,
  });
}
