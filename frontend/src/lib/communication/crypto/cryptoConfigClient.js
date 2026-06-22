import { deleteJson, getJson, postJson } from "../apiClient";
import {
  cryptoDevLog,
  cryptoError,
  cryptoPayloadError,
  cryptoRequestHeaders,
  durationSince,
  nowMs,
} from "./cryptoShared";

export const CRYPTO_CONFIG_KINDS = {
  tradingPairDetail: "trading_pair_detail",
  assetAllocationDonut: "asset_allocation_donut",
  openFuturesPositions: "open_futures_positions",
  tradeRecords: "trade_records",
};

const CONFIG_PATHS = {
  [CRYPTO_CONFIG_KINDS.tradingPairDetail]:
    "/crypto-component-experiment/config",
  [CRYPTO_CONFIG_KINDS.assetAllocationDonut]:
    "/crypto-component-experiment/asset-allocation-donut/config",
  [CRYPTO_CONFIG_KINDS.openFuturesPositions]:
    "/crypto-component-experiment/open-futures-positions/config",
  [CRYPTO_CONFIG_KINDS.tradeRecords]:
    "/crypto-component-experiment/trade-records/config",
};

function configPath(kind) {
  const path = CONFIG_PATHS[kind];
  if (!path) throw new Error(`Unknown crypto config kind: ${kind}`);
  return path;
}

function assertConfigPayload(payload, fallback) {
  if (!payload?.success) throw cryptoPayloadError(payload, fallback);
  return payload;
}

async function requestConfig(kind, request) {
  const path = configPath(kind);
  const startedAt = nowMs();
  try {
    const result = await request(path);
    if (result.data?.success === false) {
      const error = cryptoPayloadError(
        result.data,
        "Crypto config request failed"
      );
      error.status = result.response?.status;
      error.details = { requestId: result.requestId };
      throw error;
    }

    cryptoDevLog("success", {
      requestId: result.requestId,
      cryptoKind: `crypto_config:${kind}`,
      path,
      status: result.response?.status,
      durationMs: durationSince(startedAt),
      result: "success",
    });
    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const normalized = cryptoError(error, "Crypto config request failed");
    cryptoDevLog("failure", {
      requestId: error?.details?.requestId || null,
      cryptoKind: `crypto_config:${kind}`,
      path,
      status: normalized.status || 0,
      durationMs: durationSince(startedAt),
      result: "failure",
    });
    throw normalized;
  }
}

export async function loadCryptoConfig(kind, options = {}) {
  const { data } = await requestConfig(kind, (path) =>
    getJson(path, {
      ...options,
      headers: cryptoRequestHeaders(options.headers),
    })
  );
  return assertConfigPayload(data, "读取后台参数失败").config ?? null;
}

export async function saveCryptoConfig(kind, config, options = {}) {
  const { data } = await requestConfig(kind, (path) =>
    postJson(
      path,
      { config },
      {
        ...options,
        headers: cryptoRequestHeaders(options.headers),
      }
    )
  );
  assertConfigPayload(data, "保存后台参数失败");
  return true;
}

export async function clearCryptoConfig(kind, options = {}) {
  const { data } = await requestConfig(kind, (path) =>
    deleteJson(path, {
      ...options,
      headers: cryptoRequestHeaders(options.headers),
    })
  );
  assertConfigPayload(data, "清除后台参数失败");
  return true;
}
