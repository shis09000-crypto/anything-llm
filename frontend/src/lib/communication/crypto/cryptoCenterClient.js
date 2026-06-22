import { getJson } from "../apiClient";
import { createWebSocket } from "../webSocketClient";
import {
  cryptoCenterPath,
  cryptoCenterStreamUrl,
  cryptoDevLog,
  cryptoError,
  cryptoPayloadError,
  cryptoRequestHeaders,
  durationSince,
  nowMs,
} from "./cryptoShared";

export async function fetchCryptoCenterSnapshot(range, options = {}) {
  const path = cryptoCenterPath("/crypto-center/snapshot", { range });
  const startedAt = nowMs();
  try {
    const result = await getJson(path, {
      ...options,
      headers: cryptoRequestHeaders(options.headers),
    });
    if (!result.data?.success) {
      const error = cryptoPayloadError(result.data, "Snapshot request failed.");
      error.status = result.response?.status;
      error.details = { requestId: result.requestId };
      throw error;
    }

    cryptoDevLog("success", {
      requestId: result.requestId,
      cryptoKind: "crypto_center_snapshot",
      path,
      status: result.response?.status,
      durationMs: durationSince(startedAt),
      result: "success",
    });
    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const normalized = cryptoError(error, "Snapshot request failed.");
    cryptoDevLog("failure", {
      requestId: error?.details?.requestId || null,
      cryptoKind: "crypto_center_snapshot",
      path,
      status: normalized.status || 0,
      durationMs: durationSince(startedAt),
      result: "failure",
    });
    throw normalized;
  }
}

export function createCryptoCenterSocket(range, options = {}) {
  return createWebSocket({
    ...options,
    url: options.url || cryptoCenterStreamUrl(range),
  });
}

export { cryptoCenterStreamUrl };
