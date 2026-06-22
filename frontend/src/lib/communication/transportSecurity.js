import { API_ERROR_CODES, createApiError } from "./apiError";

const SAFE_NON_HTTP_PROTOCOLS = new Set(["blob:", "data:"]);

function isProduction() {
  return !!import.meta.env.PROD;
}

export function isLocalhostLike(hostname = "") {
  const normalized = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized.endsWith(".localhost")
  );
}

function browserOrigin() {
  if (typeof window === "undefined") return null;
  return window.location?.origin || null;
}

function resolveUrlForPolicy(url) {
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(String(url))) return new URL(url);
    const origin = browserOrigin();
    return origin ? new URL(url, origin) : null;
  } catch {
    return null;
  }
}

function redactedUrl(url) {
  const resolved = resolveUrlForPolicy(url);
  if (!resolved) return String(url || "");
  resolved.username = "";
  resolved.password = "";
  resolved.search = resolved.search ? "?[redacted]" : "";
  resolved.hash = resolved.hash ? "#[redacted]" : "";
  return resolved.toString();
}

function insecureTransportError({ kind, url, protocol }) {
  return createApiError({
    code: API_ERROR_CODES.TRANSPORT_SECURITY_ERROR,
    status: 0,
    message: `Insecure ${kind} transport is not allowed in production.`,
    details: {
      kind,
      protocol,
      url: redactedUrl(url),
    },
    raw: null,
  });
}

export function assertSecureHttpUrl(url, { kind = "api" } = {}) {
  if (!isProduction()) return url;
  const resolved = resolveUrlForPolicy(url);
  if (!resolved) return url;
  if (SAFE_NON_HTTP_PROTOCOLS.has(resolved.protocol)) return url;
  if (resolved.protocol === "https:") return url;
  if (resolved.protocol === "http:") {
    throw insecureTransportError({ kind, url, protocol: resolved.protocol });
  }
  return url;
}

export function assertSecureWebSocketUrl(url, { kind = "websocket" } = {}) {
  if (!isProduction()) return url;
  const resolved = resolveUrlForPolicy(url);
  if (!resolved) return url;
  if (resolved.protocol === "wss:") return url;
  if (resolved.protocol === "ws:") {
    throw insecureTransportError({ kind, url, protocol: resolved.protocol });
  }
  return url;
}

export function webSocketOriginForHttpBase(
  httpBase,
  { kind = "websocket" } = {}
) {
  const resolved = resolveUrlForPolicy(httpBase);
  if (!resolved) return httpBase;
  const protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
  const wsOrigin = `${protocol}//${resolved.host}`;
  return assertSecureWebSocketUrl(wsOrigin, { kind });
}
