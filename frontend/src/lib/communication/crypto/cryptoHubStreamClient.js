import { getJsonSse } from "../streamClient";
import { cryptoHubPath, cryptoRequestHeaders } from "./cryptoShared";

const IGNORED_ENVELOPE_TYPES = new Set(["heartbeat", "status"]);

export function normalizeCryptoHubSsePayload(payload) {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "type" in payload &&
    "topic" in payload &&
    "data" in payload
  ) {
    return payload;
  }

  return {
    type: "update",
    topic: "legacy",
    asOf: Date.now(),
    data: payload,
    freshness: null,
    safeErrorMessage: null,
  };
}

export function parseCryptoHubSse(raw) {
  try {
    return normalizeCryptoHubSsePayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function cryptoHubEnvelopeData(envelope) {
  if (!envelope || IGNORED_ENVELOPE_TYPES.has(envelope.type)) return null;
  return envelope.data ?? null;
}

export function cryptoHubSseData(raw) {
  return cryptoHubEnvelopeData(parseCryptoHubSse(raw));
}

export async function streamCryptoHubData({
  path,
  query = null,
  signal,
  headers = {},
  openWhenHidden = false,
  retryOnError = false,
  onOpen,
  onEnvelope,
  onData,
  onClose,
  onError,
} = {}) {
  await getJsonSse({
    path: cryptoHubPath(path, query),
    signal,
    headers: cryptoRequestHeaders(headers),
    openWhenHidden,
    retryOnError,
    onOpen,
    onMessage(payload, rawMessage) {
      const envelope = normalizeCryptoHubSsePayload(payload);
      onEnvelope?.(envelope, rawMessage);
      const data = cryptoHubEnvelopeData(envelope);
      if (data === null || data === undefined) return;
      onData?.(data, envelope, rawMessage);
    },
    onClose,
    onError,
  });
}

export function streamOpenFuturesPositions(options = {}) {
  return streamCryptoHubData({
    ...options,
    path: "/open-futures-positions/stream",
  });
}

export function streamMarketCandles({ pair, range, market, ...options } = {}) {
  return streamCryptoHubData({
    ...options,
    path: "/market-candles/stream",
    query: { pair, range, market },
  });
}

export function streamTradeRecords({ from, to, limit, ...options } = {}) {
  return streamCryptoHubData({
    ...options,
    path: "/trade-records/stream",
    query: { from, to, limit },
  });
}

export function streamDashboardSnapshot(options = {}) {
  return streamCryptoHubData({
    ...options,
    path: "/dashboard-stream",
  });
}
