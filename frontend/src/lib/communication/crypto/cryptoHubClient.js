import { requestJson } from "../apiClient";
import {
  CRYPTO_HUB_BASE,
  cryptoDevLog,
  cryptoError,
  cryptoHubPath,
  cryptoPayloadError,
  cryptoRequestHeaders,
  durationSince,
  nowMs,
} from "./cryptoShared";

export { CRYPTO_HUB_BASE };

const CRYPTO_HUB_SINGLEFLIGHT_RECENT_MS = 1_200;
const cryptoHubInflight = new Map();
const cryptoHubRecentResults = new Map();

function requestBodyOptions(body) {
  if (body === undefined) return {};
  return {
    body,
    rawBody: typeof body === "string",
  };
}

function abortError(reason) {
  try {
    return new DOMException(reason || "Aborted", "AbortError");
  } catch {
    const error = new Error(reason || "Aborted");
    error.name = "AbortError";
    return error;
  }
}

function methodName(method) {
  return String(method || "GET").toUpperCase();
}

function cleanHubPath(requestPath = "") {
  return String(requestPath).split("?")[0];
}

function serializeSingleflightBody(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function canSingleflightHubRequest(method, requestPath) {
  const normalizedMethod = methodName(method);
  if (normalizedMethod === "GET") return true;
  return (
    normalizedMethod === "POST" &&
    cleanHubPath(requestPath) === "/crypto-hub/init"
  );
}

function canReuseRecentHubResult(method, requestPath) {
  if (methodName(method) !== "GET") return false;
  return !["/crypto-hub/status", "/crypto-hub/loading-progress"].includes(
    cleanHubPath(requestPath)
  );
}

function singleflightKeyFor({ method, requestPath, body }) {
  return `${methodName(method)}:${requestPath}:${serializeSingleflightBody(body)}`;
}

function pruneRecentResults(now = nowMs()) {
  for (const [key, entry] of cryptoHubRecentResults.entries()) {
    if (now - entry.at > CRYPTO_HUB_SINGLEFLIGHT_RECENT_MS) {
      cryptoHubRecentResults.delete(key);
    }
  }
}

function promiseWithCallerAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason || abortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function performCryptoHubRequest({
  requestPath,
  method,
  body,
  headers,
  rest,
  cryptoKind,
  startedAt,
}) {
  try {
    const result = await requestJson(requestPath, {
      ...rest,
      method,
      headers: cryptoRequestHeaders(headers),
      ...requestBodyOptions(body),
    });

    if (result.data?.success === false) {
      const error = cryptoPayloadError(
        result.data,
        "Crypto Hub request failed"
      );
      error.status = result.response?.status;
      error.details = { requestId: result.requestId };
      throw error;
    }

    cryptoDevLog("success", {
      requestId: result.requestId,
      cryptoKind,
      path: requestPath,
      status: result.response?.status,
      durationMs: durationSince(startedAt),
      result: "success",
    });

    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const normalized = cryptoError(error, "Crypto Hub request failed");
    cryptoDevLog("failure", {
      requestId: error?.details?.requestId || null,
      cryptoKind,
      path: requestPath,
      status: normalized.status || 0,
      durationMs: durationSince(startedAt),
      result: "failure",
    });
    throw normalized;
  }
}

export async function cryptoHubRequest(path, options = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    cryptoKind = "crypto_hub",
    query = null,
    ...rest
  } = options;
  const requestPath = cryptoHubPath(path, query);
  const startedAt = nowMs();
  const singleflightEnabled = canSingleflightHubRequest(method, requestPath);
  const recentReuseEnabled = canReuseRecentHubResult(method, requestPath);
  const singleflightKey = singleflightEnabled
    ? singleflightKeyFor({ method, requestPath, body })
    : null;
  const callerSignal = rest.signal;

  if (singleflightEnabled) {
    pruneRecentResults(startedAt);
    const recent = cryptoHubRecentResults.get(singleflightKey);
    if (
      recentReuseEnabled &&
      recent &&
      startedAt - recent.at <= CRYPTO_HUB_SINGLEFLIGHT_RECENT_MS
    ) {
      return promiseWithCallerAbort(
        Promise.resolve(recent.result),
        callerSignal
      );
    }

    const existing = cryptoHubInflight.get(singleflightKey);
    if (existing && !existing.signal?.aborted) {
      return promiseWithCallerAbort(existing.promise, callerSignal);
    }

    const promise = performCryptoHubRequest({
      requestPath,
      method,
      body,
      headers,
      rest,
      cryptoKind,
      startedAt,
    })
      .then((result) => {
        if (recentReuseEnabled) {
          cryptoHubRecentResults.set(singleflightKey, {
            result,
            at: nowMs(),
          });
        }
        return result;
      })
      .finally(() => {
        if (cryptoHubInflight.get(singleflightKey)?.promise === promise) {
          cryptoHubInflight.delete(singleflightKey);
        }
      });
    cryptoHubInflight.set(singleflightKey, {
      promise,
      signal: callerSignal || null,
    });
    return promiseWithCallerAbort(promise, callerSignal);
  }

  return performCryptoHubRequest({
    requestPath,
    method,
    body,
    headers,
    rest,
    cryptoKind,
    startedAt,
  });
}

export async function cryptoHubFetch(path, options = {}) {
  const { data } = await cryptoHubRequest(path, options);
  return data;
}

export function cryptoHubGet(path, options = {}) {
  return cryptoHubFetch(path, { ...options, method: "GET" });
}

export function cryptoHubPost(path, body = undefined, options = {}) {
  return cryptoHubFetch(path, { ...options, method: "POST", body });
}
