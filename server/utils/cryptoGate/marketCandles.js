const { DEFAULT_SPOT_PAIR } = require("./constants");
const { GatePublicMarketClient } = require("./publicMarketClient");
const { safeErrorMessage } = require("./sanitizer");

const REST_CACHE_TTL_MS = 5_000;
const MAX_CACHED_CANDLES = 720;
const RECENT_FALLBACK_LIMIT = 20;

const RANGE_META = {
  "15m": { interval: "15m", segmentSeconds: 15 * 60, limit: 200 },
  "1h": { interval: "1h", segmentSeconds: 60 * 60, limit: 200 },
  "4h": { interval: "4h", segmentSeconds: 4 * 60 * 60, limit: 200 },
  "1d": { interval: "1d", segmentSeconds: 24 * 60 * 60, limit: 200 },
  "1w": { interval: "1w", segmentSeconds: 7 * 24 * 60 * 60, limit: 200 },
  "7d": { interval: "7d", segmentSeconds: 7 * 24 * 60 * 60, limit: 200 },
  "30d": { interval: "30d", segmentSeconds: 30 * 24 * 60 * 60, limit: 200 },
};

const marketCandleCache = new Map();
const restInFlight = new Map();
const publicRateLimitState = {
  updatedAt: null,
  rateLimit: null,
};

function parseGateSpotPair(pair) {
  const normalized = String(pair || DEFAULT_SPOT_PAIR)
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{2,20}_[A-Z0-9]{2,20}$/.test(normalized)) {
    const error = new Error("Unsupported or invalid Gate spot pair.");
    error.code = "invalid_pair";
    throw error;
  }

  const [baseAsset, quoteAsset] = normalized.split("_");
  return {
    baseAsset,
    quoteAsset,
    gateCurrencyPair: normalized,
    symbol: `${baseAsset}/${quoteAsset}`,
  };
}

function rangeMeta(range) {
  const normalized = String(range || "1d")
    .trim()
    .toLowerCase();
  return RANGE_META[normalized]
    ? { id: normalized, ...RANGE_META[normalized] }
    : null;
}

function assertSpotMarket(market) {
  const marketType = String(market || "spot")
    .trim()
    .toLowerCase();
  if (marketType !== "spot") {
    const error = new Error("Only Gate spot market candles are supported.");
    error.code = "unsupported_market";
    throw error;
  }
  return marketType;
}

function resolveMarketRequest({ pair, range, market = "spot" }) {
  const marketType = assertSpotMarket(market);
  const parsedPair = parseGateSpotPair(pair);
  const meta = rangeMeta(range);
  if (!meta) {
    const error = new Error("Unsupported candle range.");
    error.code = "unsupported_range";
    throw error;
  }

  return {
    marketType,
    parsedPair,
    meta,
    cacheKey: marketCandleCacheKey({
      market: marketType,
      pair: parsedPair.gateCurrencyPair,
      range: meta.id,
    }),
  };
}

function marketCandleCacheKey({ market = "spot", pair, range }) {
  return `${String(market || "spot").toLowerCase()}:${String(
    pair || DEFAULT_SPOT_PAIR
  )
    .trim()
    .toUpperCase()}:${String(range || "1d")
    .trim()
    .toLowerCase()}`;
}

function normalizeTs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number > 10_000_000_000
    ? Math.floor(number / 1_000)
    : Math.floor(number);
}

function normalizeTicker(data) {
  const ticker = Array.isArray(data) ? data[0] : data;
  if (!ticker || typeof ticker !== "object") return null;

  const last = ticker.last || ticker.close || null;
  const change24hPct =
    ticker.change_percentage ??
    ticker.change_utc0 ??
    ticker.change_utc8 ??
    ticker.change ??
    null;

  return {
    currentPriceQuote: last === null ? null : String(last),
    change24hPct: change24hPct === null ? null : String(change24hPct),
  };
}

function normalizeCandle(candle) {
  if (Array.isArray(candle)) {
    const ts = Number(candle[0]) * 1_000;
    return {
      ts,
      volume: String(candle[1] ?? "0"),
      close: String(candle[2] ?? "0"),
      high: String(candle[3] ?? candle[2] ?? "0"),
      low: String(candle[4] ?? candle[2] ?? "0"),
      open: String(candle[5] ?? candle[2] ?? "0"),
    };
  }

  if (candle && typeof candle === "object") {
    const rawTs =
      candle.t || candle.time || candle.timestamp || candle.create_time || 0;
    const numericTs = Number(rawTs);
    return {
      ts: numericTs > 10_000_000_000 ? numericTs : numericTs * 1_000,
      open: String(candle.o ?? candle.open ?? candle.close ?? candle.c ?? "0"),
      high: String(candle.h ?? candle.high ?? candle.close ?? candle.c ?? "0"),
      low: String(candle.l ?? candle.low ?? candle.close ?? candle.c ?? "0"),
      close: String(candle.c ?? candle.close ?? "0"),
      volume: String(candle.v ?? candle.volume ?? "0"),
    };
  }

  return null;
}

function normalizeCandles(data) {
  if (!Array.isArray(data)) return [];
  return data
    .map(normalizeCandle)
    .filter(
      (candle) =>
        candle &&
        Number.isFinite(candle.ts) &&
        Number(candle.open) > 0 &&
        Number(candle.high) > 0 &&
        Number(candle.low) > 0 &&
        Number(candle.close) > 0
    )
    .sort((left, right) => left.ts - right.ts);
}

function intervalToMs(interval) {
  const value = String(interval || "1m");
  const amount = Number(value.slice(0, -1));
  const unit = value.slice(-1);
  if (!Number.isFinite(amount) || amount <= 0) return 60_000;
  if (unit === "s") return amount * 1_000;
  if (unit === "m") return amount * 60_000;
  if (unit === "h") return amount * 60 * 60_000;
  if (unit === "d") return amount * 24 * 60 * 60_000;
  if (unit === "w") return amount * 7 * 24 * 60 * 60_000;
  return 60_000;
}

function decimalString(value, decimals = 8) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number
    .toFixed(decimals)
    .replace(/\.?0+$/, "")
    .replace(/^-0$/, "0");
}

function candleWindow({ beforeTs, afterTs }) {
  const beforeSeconds = normalizeTs(beforeTs);
  const afterSeconds = normalizeTs(afterTs);

  if (beforeSeconds) return { to: Math.max(1, beforeSeconds - 1) };
  if (afterSeconds) return { from: afterSeconds + 1 };
  return {};
}

function mergeCandles(
  current,
  incoming,
  { keep = "newer", maxCandles = MAX_CACHED_CANDLES } = {}
) {
  const byTs = new Map();
  for (const candle of current || []) byTs.set(Number(candle.ts), candle);
  for (const candle of incoming || []) byTs.set(Number(candle.ts), candle);

  const merged = Array.from(byTs.values()).sort(
    (left, right) => left.ts - right.ts
  );
  if (merged.length <= maxCandles) return merged;
  return keep === "older"
    ? merged.slice(0, maxCandles)
    : merged.slice(-maxCandles);
}

function getOrCreateCacheEntry({ cacheKey, marketType, parsedPair, meta }) {
  const existingEntry = marketCandleCache.get(cacheKey);
  if (existingEntry && existingEntry.gateInterval !== meta.interval) {
    marketCandleCache.delete(cacheKey);
  }

  if (!marketCandleCache.has(cacheKey)) {
    marketCandleCache.set(cacheKey, {
      cacheKey,
      marketType,
      pair: parsedPair.gateCurrencyPair,
      range: meta.id,
      gateInterval: meta.interval,
      candles: [],
      lastUpdatedAt: null,
      latestSnapshotAt: null,
      wsStatus: "idle",
      restStatus: "idle",
      lastRestFetchAt: null,
      lastTickerFetchAt: null,
      lastWsMessageAt: null,
      subscriberCount: 0,
      currentPriceQuote: null,
      change24hPct: null,
      publicRateLimit: null,
    });
  }

  return marketCandleCache.get(cacheKey);
}

function updatePublicRateLimit(result) {
  if (!result?.rateLimit) return;
  publicRateLimitState.updatedAt = Date.now();
  publicRateLimitState.rateLimit = result.rateLimit;
}

function updateEntryCandles(entry, candles, { keep = "newer" } = {}) {
  if (!candles.length) return entry;
  entry.candles = mergeCandles(entry.candles, candles, { keep });
  entry.lastUpdatedAt = Date.now();
  entry.latestSnapshotAt = entry.lastUpdatedAt;
  entry.currentPriceQuote =
    entry.candles[entry.candles.length - 1]?.close || null;
  return entry;
}

function cacheSnapshot(entry, { candles = entry?.candles || [] } = {}) {
  if (!entry) return null;
  return {
    cacheKey: entry.cacheKey,
    marketType: entry.marketType,
    gateCurrencyPair: entry.pair,
    range: entry.range,
    gateInterval: entry.gateInterval,
    candles,
    lastUpdatedAt: entry.lastUpdatedAt,
    latestSnapshotAt: entry.latestSnapshotAt,
    wsStatus: entry.wsStatus,
    restStatus: entry.restStatus,
    lastRestFetchAt: entry.lastRestFetchAt,
    lastTickerFetchAt: entry.lastTickerFetchAt,
    lastWsMessageAt: entry.lastWsMessageAt,
    subscriberCount: entry.subscriberCount,
    currentPriceQuote:
      entry.currentPriceQuote || candles[candles.length - 1]?.close || null,
    change24hPct: entry.change24hPct,
    publicRateLimit: entry.publicRateLimit || publicRateLimitState.rateLimit,
  };
}

function marketResponse({
  marketType,
  parsedPair,
  meta,
  beforeTs,
  afterTs,
  candles,
  ticker,
  entry,
  rateLimit,
  partialFailures = [],
  cacheHit = false,
}) {
  return {
    success: true,
    asOf: Date.now(),
    exchange: "gate",
    marketType,
    baseAsset: parsedPair.baseAsset,
    quoteAsset: parsedPair.quoteAsset,
    symbol: parsedPair.symbol,
    gateCurrencyPair: parsedPair.gateCurrencyPair,
    range: meta.id,
    gateInterval: meta.interval,
    segmentLimit: meta.limit,
    beforeTs: beforeTs ? Number(beforeTs) : null,
    afterTs: afterTs ? Number(afterTs) : null,
    candles,
    currentPriceQuote:
      ticker?.currentPriceQuote ||
      entry?.currentPriceQuote ||
      candles[candles.length - 1]?.close ||
      null,
    change24hPct: ticker?.change24hPct || entry?.change24hPct || null,
    latestSnapshotAt: entry?.latestSnapshotAt || null,
    lastUpdatedAt: entry?.lastUpdatedAt || null,
    wsStatus: entry?.wsStatus || "idle",
    restStatus: entry?.restStatus || "idle",
    lastRestFetchAt: entry?.lastRestFetchAt || null,
    lastWsMessageAt: entry?.lastWsMessageAt || null,
    subscriberCount: entry?.subscriberCount || 0,
    connectionStatus:
      partialFailures.length || entry?.wsStatus === "fallback"
        ? "degraded"
        : "connected",
    hasMoreHistory: candles.length >= meta.limit,
    cacheHit,
    rateLimit: rateLimit || entry?.publicRateLimit || null,
    cache: cacheSnapshot(entry),
    partialFailures,
  };
}

async function fetchPublicMarketCandles({
  parsedPair,
  meta,
  beforeTs,
  afterTs,
  limit = meta.limit,
  includeTicker = true,
}) {
  const client = new GatePublicMarketClient();
  const window = candleWindow({ beforeTs, afterTs });
  const candlesPromise = client.getSpotCandlesticksRaw({
    currencyPair: parsedPair.gateCurrencyPair,
    interval: meta.interval,
    limit,
    ...window,
  });
  const tickerPromise = includeTicker
    ? client.getSpotTickerRaw({ currencyPair: parsedPair.gateCurrencyPair })
    : Promise.resolve({ success: true, data: null });
  const [candlesResult, tickerResult] = await Promise.all([
    candlesPromise,
    tickerPromise,
  ]);
  updatePublicRateLimit(candlesResult);
  updatePublicRateLimit(tickerResult);

  if (!candlesResult.success) {
    const error = new Error(
      candlesResult.safeErrorMessage || "Gate market candles request failed."
    );
    error.code = "gate_request_failed";
    throw error;
  }

  return {
    candlesResult,
    tickerResult,
    candles: normalizeCandles(candlesResult.data),
    ticker: tickerResult.success ? normalizeTicker(tickerResult.data) : null,
  };
}

async function marketCandles({
  pair,
  range,
  market = "spot",
  beforeTs,
  afterTs,
  includeTicker = true,
  limit,
}) {
  const resolved = resolveMarketRequest({
    pair,
    range,
    market,
  });
  const requestedLimit = Number(limit);
  const effectiveLimit =
    Number.isInteger(requestedLimit) &&
    requestedLimit >= 30 &&
    requestedLimit <= MAX_CACHED_CANDLES
      ? requestedLimit
      : resolved.meta.limit;
  const { marketType, parsedPair, cacheKey } = resolved;
  const meta = { ...resolved.meta, limit: effectiveLimit };
  const entry = getOrCreateCacheEntry({
    cacheKey,
    marketType,
    parsedPair,
    meta,
  });
  const isLatestSnapshot = !beforeTs && !afterTs;

  if (
    isLatestSnapshot &&
    entry.candles.length >= meta.limit &&
    entry.lastRestFetchAt &&
    Date.now() - entry.lastRestFetchAt < REST_CACHE_TTL_MS &&
    (!includeTicker ||
      (entry.lastTickerFetchAt &&
        Date.now() - entry.lastTickerFetchAt < REST_CACHE_TTL_MS))
  ) {
    const candles = entry.candles.slice(-meta.limit);
    return marketResponse({
      marketType,
      parsedPair,
      meta,
      beforeTs,
      afterTs,
      candles,
      ticker: {
        currentPriceQuote: entry.currentPriceQuote,
        change24hPct: entry.change24hPct,
      },
      entry,
      rateLimit: entry.publicRateLimit,
      cacheHit: true,
    });
  }

  const inFlightKey = `${cacheKey}:${beforeTs || ""}:${afterTs || ""}:${
    meta.limit
  }:ticker:${includeTicker ? "1" : "0"}`;
  if (restInFlight.has(inFlightKey)) return restInFlight.get(inFlightKey);

  const request = (async () => {
    entry.restStatus = "loading";
    const { candlesResult, tickerResult, candles, ticker } =
      await fetchPublicMarketCandles({
        parsedPair,
        meta,
        beforeTs,
        afterTs,
        limit: meta.limit,
        includeTicker,
      });
    const partialFailures = [];
    if (!tickerResult.success) {
      partialFailures.push({
        source: "ticker",
        message: safeErrorMessage(
          tickerResult.safeErrorMessage || "Gate ticker request failed."
        ),
      });
    }

    entry.restStatus = "connected";
    entry.lastRestFetchAt = Date.now();
    entry.publicRateLimit = candlesResult.rateLimit || null;
    if (ticker) {
      entry.currentPriceQuote = ticker.currentPriceQuote;
      entry.change24hPct = ticker.change24hPct;
      entry.lastTickerFetchAt = Date.now();
    }
    updateEntryCandles(entry, candles, {
      keep: beforeTs ? "older" : "newer",
    });

    return marketResponse({
      marketType,
      parsedPair,
      meta,
      beforeTs,
      afterTs,
      candles,
      ticker,
      entry,
      rateLimit: candlesResult.rateLimit || null,
      partialFailures,
      cacheHit: false,
    });
  })()
    .catch((error) => {
      entry.restStatus = "error";
      throw error;
    })
    .finally(() => {
      restInFlight.delete(inFlightKey);
    });

  restInFlight.set(inFlightKey, request);
  return request;
}

async function refreshRecentMarketCandles({
  pair,
  range,
  market = "spot",
  limit = RECENT_FALLBACK_LIMIT,
}) {
  const { marketType, parsedPair, meta, cacheKey } = resolveMarketRequest({
    pair,
    range,
    market,
  });
  const entry = getOrCreateCacheEntry({
    cacheKey,
    marketType,
    parsedPair,
    meta,
  });
  const boundedLimit = Math.max(5, Math.min(20, Number(limit) || 20));
  const inFlightKey = `${cacheKey}:fallback:${boundedLimit}`;
  if (restInFlight.has(inFlightKey)) return restInFlight.get(inFlightKey);

  const request = (async () => {
    const { candlesResult, candles } = await fetchPublicMarketCandles({
      parsedPair,
      meta,
      limit: boundedLimit,
      includeTicker: false,
    });
    entry.restStatus = "connected";
    entry.lastRestFetchAt = Date.now();
    entry.publicRateLimit = candlesResult.rateLimit || null;
    updateEntryCandles(entry, candles, { keep: "newer" });
    return cacheSnapshot(entry, {
      candles: entry.candles.slice(-boundedLimit),
    });
  })()
    .catch((error) => {
      entry.restStatus = "error";
      throw error;
    })
    .finally(() => {
      restInFlight.delete(inFlightKey);
    });

  restInFlight.set(inFlightKey, request);
  return request;
}

function applyRealtimeCandle({ pair, range, market = "spot", candle }) {
  const { marketType, parsedPair, meta, cacheKey } = resolveMarketRequest({
    pair,
    range,
    market,
  });
  const entry = getOrCreateCacheEntry({
    cacheKey,
    marketType,
    parsedPair,
    meta,
  });
  const normalized = normalizeCandle(candle);
  if (!normalized) return cacheSnapshot(entry);

  entry.wsStatus = "connected";
  entry.lastWsMessageAt = Date.now();
  updateEntryCandles(entry, [normalized], { keep: "newer" });
  return cacheSnapshot(entry);
}

function applyRealtimeTrade({ pair, range, market = "spot", trade }) {
  const { marketType, parsedPair, meta, cacheKey } = resolveMarketRequest({
    pair,
    range,
    market,
  });
  const entry = getOrCreateCacheEntry({
    cacheKey,
    marketType,
    parsedPair,
    meta,
  });
  const price = Number(trade?.price);
  const amount = Number(trade?.amount);
  const rawTs =
    trade?.create_time_ms ??
    trade?.time_ms ??
    trade?.create_time ??
    trade?.time;
  const numericTs = Number(rawTs);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(numericTs)) {
    return cacheSnapshot(entry);
  }

  const tradeTs =
    numericTs > 10_000_000_000 ? Math.floor(numericTs) : numericTs * 1_000;
  const bucketMs = intervalToMs(meta.interval);
  const bucketTs = Math.floor(tradeTs / bucketMs) * bucketMs;
  const quoteVolume =
    Number.isFinite(amount) && amount > 0 ? amount * price : 0;
  const current = entry.candles.find((candle) => candle.ts === bucketTs);
  const nextCandle = current
    ? {
        ...current,
        high: decimalString(Math.max(Number(current.high), price)),
        low: decimalString(Math.min(Number(current.low), price)),
        close: decimalString(price),
        volume: decimalString(Number(current.volume) + quoteVolume),
      }
    : {
        ts: bucketTs,
        open: decimalString(price),
        high: decimalString(price),
        low: decimalString(price),
        close: decimalString(price),
        volume: decimalString(quoteVolume),
      };

  entry.wsStatus = "connected";
  entry.lastWsMessageAt = Date.now();
  updateEntryCandles(entry, [nextCandle], { keep: "newer" });
  return cacheSnapshot(entry);
}

function setMarketCacheSubscriberCount(cacheKey, subscriberCount) {
  const entry = marketCandleCache.get(cacheKey);
  if (entry) entry.subscriberCount = subscriberCount;
}

function setMarketCacheWsStatus(cacheKey, wsStatus) {
  const entry = marketCandleCache.get(cacheKey);
  if (entry) {
    entry.wsStatus = wsStatus;
    entry.lastUpdatedAt = Date.now();
  }
}

function getMarketCacheSnapshot({ pair, range, market = "spot" }) {
  const { cacheKey } = resolveMarketRequest({ pair, range, market });
  return cacheSnapshot(marketCandleCache.get(cacheKey));
}

const cryptoGateMarketCandlesService = {
  marketCandles,
};

module.exports = {
  MAX_CACHED_CANDLES,
  RANGE_META,
  RECENT_FALLBACK_LIMIT,
  applyRealtimeCandle,
  applyRealtimeTrade,
  cryptoGateMarketCandlesService,
  getMarketCacheSnapshot,
  intervalToMs,
  marketCandleCacheKey,
  marketCandles,
  normalizeCandle,
  normalizeCandles,
  parseGateSpotPair,
  rangeMeta,
  refreshRecentMarketCandles,
  resolveMarketRequest,
  setMarketCacheSubscriberCount,
  setMarketCacheWsStatus,
};
