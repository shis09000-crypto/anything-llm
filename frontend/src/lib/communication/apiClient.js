import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";
import { assertSecureHttpUrl } from "./transportSecurity";

function createRequestId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function devLog(phase, metadata = {}) {
  if (!import.meta.env.DEV) return;
  console.debug(`[apiClient] ${phase}`, metadata);
}

function durationSince(startedAt) {
  return Math.round(nowMs() - startedAt);
}

function requestSignal({ signal, timeoutMs }) {
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!hasTimeout) {
    return {
      signal,
      cleanup: () => {},
      didTimeout: () => false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(signal?.reason);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (signal?.aborted) {
    abortFromExternal();
  } else {
    signal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortFromExternal);
    },
    didTimeout: () => timedOut,
  };
}

export function apiUrl(path = "") {
  if (!path) return assertSecureHttpUrl(API_BASE, { kind: "api" });
  if (/^https?:\/\//i.test(path)) {
    return assertSecureHttpUrl(path, { kind: "api" });
  }
  return assertSecureHttpUrl(
    `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`,
    { kind: "api" }
  );
}

export function jsonHeaders(headers = {}, { includeBaseHeaders = true } = {}) {
  return cleanHeaders({
    ...(includeBaseHeaders ? baseHeaders() : {}),
    "Content-Type": "application/json",
    ...headers,
  });
}

export function formDataHeaders(
  headers = {},
  { includeBaseHeaders = true } = {}
) {
  return cleanHeaders({
    ...(includeBaseHeaders ? baseHeaders() : {}),
    ...headers,
  });
}

function cleanHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([, value]) => value !== null && value !== undefined
    )
  );
}

export async function parseJsonResponse(response) {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || response.statusText };
  }
}

export async function requestJson(path, options = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    signal,
    timeoutMs,
    includeBaseHeaders = true,
    retryAttempt = 0,
    rawBody = false,
    ...rest
  } = options;
  const normalizedMethod = method.toUpperCase();
  const requestId = createRequestId();
  const startedAt = nowMs();
  const signalState = requestSignal({ signal, timeoutMs });

  if (retryAttempt > 0) {
    devLog("retry", {
      requestId,
      method: normalizedMethod,
      path,
      retryAttempt,
    });
  }
  devLog("start", {
    requestId,
    method: normalizedMethod,
    path,
  });

  try {
    const response = await fetch(apiUrl(path), {
      method: normalizedMethod,
      headers: jsonHeaders(headers, { includeBaseHeaders }),
      body: rawBody
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
      signal: signalState.signal,
      ...rest,
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      const apiError = normalizeApiError(null, response, {
        details: { requestId, method: normalizedMethod, path },
        raw: data,
      });
      devLog("failure", {
        requestId,
        method: normalizedMethod,
        path,
        status: response.status,
        durationMs: durationSince(startedAt),
      });
      throw apiError;
    }

    devLog("success", {
      requestId,
      method: normalizedMethod,
      path,
      status: response.status,
      durationMs: durationSince(startedAt),
    });
    return { response, data, requestId };
  } catch (error) {
    if (signalState.didTimeout()) {
      const apiError = createApiError({
        code: API_ERROR_CODES.API_TIMEOUT_ERROR,
        status: 0,
        message: `Request timed out after ${timeoutMs}ms.`,
        details: { requestId, method: normalizedMethod, path, timeoutMs },
        raw: error,
      });
      devLog("timeout", {
        requestId,
        method: normalizedMethod,
        path,
        status: 0,
        durationMs: durationSince(startedAt),
      });
      throw apiError;
    }
    if (error?.name === "AbortError") throw error;
    if (error?.ok === false) throw error;

    const apiError = normalizeApiError(error, null, {
      details: {
        ...(error?.details || {}),
        requestId,
        method: normalizedMethod,
        path,
      },
    });
    devLog("failure", {
      requestId,
      method: normalizedMethod,
      path,
      status: apiError.status,
      durationMs: durationSince(startedAt),
    });
    throw apiError;
  } finally {
    signalState.cleanup();
  }
}

export function getJson(path, options = {}) {
  return requestJson(path, { ...options, method: "GET" });
}

export function postJson(path, body, options = {}) {
  return requestJson(path, { ...options, method: "POST", body });
}

export function putJson(path, body, options = {}) {
  return requestJson(path, { ...options, method: "PUT", body });
}

export function patchJson(path, body, options = {}) {
  return requestJson(path, { ...options, method: "PATCH", body });
}

export function deleteJson(path, options = {}) {
  return requestJson(path, { ...options, method: "DELETE" });
}

export async function unwrapJson(request, fallback, mapper = (data) => data) {
  try {
    const result = await (typeof request === "function" ? request() : request);
    return mapper(result?.data);
  } catch (error) {
    return typeof fallback === "function" ? fallback(error) : fallback;
  }
}
