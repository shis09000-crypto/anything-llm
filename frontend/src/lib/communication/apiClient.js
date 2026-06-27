import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";
import { assertSecureHttpUrl } from "./transportSecurity";
import {
  createCommunicationRequestId,
  withClientIdentityHeaders,
} from "./clientIdentity";
import {
  clearSigningSecretCache,
  isRecoverableSigningError,
  maybeSignedRequestHeaders,
} from "./requestSigningClient";

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

export function jsonHeaders(
  headers = {},
  { includeBaseHeaders = true, requestId } = {}
) {
  return withClientIdentityHeaders(
    {
      ...(includeBaseHeaders ? baseHeaders() : {}),
      "Content-Type": "application/json",
      ...headers,
    },
    { requestId }
  );
}

export function formDataHeaders(
  headers = {},
  { includeBaseHeaders = true, requestId } = {}
) {
  return withClientIdentityHeaders(
    {
      ...(includeBaseHeaders ? baseHeaders() : {}),
      ...headers,
    },
    { requestId }
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
    signing = "auto",
    ...rest
  } = options;
  const normalizedMethod = method.toUpperCase();
  const requestId = createCommunicationRequestId();
  const startedAt = nowMs();
  const signalState = requestSignal({ signal, timeoutMs });
  const url = apiUrl(path);
  const bodyString = rawBody
    ? body || ""
    : body === undefined
      ? ""
      : JSON.stringify(body);

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
    const signingResult = await maybeSignedRequestHeaders({
      method: normalizedMethod,
      path,
      url,
      requestId,
      bodyString,
      signal: signalState.signal,
      signing,
    });
    const response = await fetch(url, {
      method: normalizedMethod,
      headers: {
        ...jsonHeaders(headers, { includeBaseHeaders, requestId }),
        ...signingResult.headers,
      },
      body: bodyString ? bodyString : undefined,
      signal: signalState.signal,
      ...rest,
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      if (
        signingResult.signed &&
        retryAttempt < 1 &&
        isRecoverableSigningError(data?.error)
      ) {
        clearSigningSecretCache();
        devLog("retry", {
          requestId,
          method: normalizedMethod,
          path,
          status: response.status,
          reason: data?.error,
          retryAttempt: retryAttempt + 1,
        });
        return requestJson(path, {
          method,
          body,
          headers,
          signal,
          timeoutMs,
          includeBaseHeaders,
          retryAttempt: retryAttempt + 1,
          rawBody,
          signing,
          ...rest,
        });
      }
      if (data?.error === API_ERROR_CODES.CLIENT_REVOKED) {
        clearSigningSecretCache();
      }
      const apiError = normalizeApiError(null, response, {
        code:
          data?.error === API_ERROR_CODES.CLIENT_REVOKED
            ? API_ERROR_CODES.CLIENT_REVOKED
            : isRecoverableSigningError(data?.error)
              ? data.error
              : undefined,
        details: { requestId, method: normalizedMethod, path },
        raw: data,
      });
      devLog("failure", {
        requestId,
        method: normalizedMethod,
        path,
        status: response.status,
        durationMs: durationSince(startedAt),
        signed: signingResult.signed,
      });
      throw apiError;
    }

    devLog("success", {
      requestId,
      method: normalizedMethod,
      path,
      status: response.status,
      durationMs: durationSince(startedAt),
      signed: signingResult.signed,
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
