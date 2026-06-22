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

function requestBodyOptions(body) {
  if (body === undefined) return {};
  return {
    body,
    rawBody: typeof body === "string",
  };
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
