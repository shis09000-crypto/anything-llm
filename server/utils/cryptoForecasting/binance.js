const { QUOTE } = require("./constants");
const { envelopeForBar } = require("./marketDataEnvelope");

const BINANCE_MARKET_BASE =
  process.env.ATHENA_BINANCE_MARKET_BASE_URL ||
  "https://data-api.binance.vision/api/v3";
const BINANCE_FUTURES_BASE =
  process.env.ATHENA_BINANCE_FUTURES_BASE_URL ||
  "https://fapi.binance.com/fapi/v1";

function timestampMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 100_000_000_000_000) return Math.floor(numeric / 1_000);
  return Math.floor(numeric);
}

function normalizeKline(
  row,
  {
    symbol,
    interval,
    source = "binance",
    receivedAtMs = Date.now(),
    backfilled = true,
  }
) {
  if (!Array.isArray(row) || row.length < 11) return null;
  const openTimeMs = timestampMs(row[0]);
  const closeTimeMs = timestampMs(row[6]);
  const numbers = [
    Number(row[1]),
    Number(row[2]),
    Number(row[3]),
    Number(row[4]),
    Number(row[5]),
    Number(row[7]),
    Number(row[8]),
    Number(row[9]),
    Number(row[10]),
  ];
  if (
    !Number.isFinite(openTimeMs) ||
    !Number.isFinite(closeTimeMs) ||
    !numbers.every(Number.isFinite)
  )
    return null;
  const bar = {
    symbol,
    interval,
    openTimeMs,
    closeTimeMs,
    open: numbers[0],
    high: numbers[1],
    low: numbers[2],
    close: numbers[3],
    volume: numbers[4],
    quoteVolume: numbers[5],
    tradeCount: Math.max(0, Math.floor(numbers[6])),
    takerBuyBaseVolume: numbers[7],
    takerBuyQuoteVolume: numbers[8],
    source,
  };
  return {
    ...bar,
    ...envelopeForBar(bar, {
      receivedAtMs,
      backfilled,
      availabilityEstimated: backfilled,
      availabilityQuality: backfilled ? "estimated" : "exact",
      providerVersion: "binance-spot-api-v3",
      licenseId: "binance-public-market-data",
      citationUrl: "https://github.com/binance/binance-public-data",
    }),
  };
}

async function fetchJson(
  url,
  { fetchImpl = global.fetch, timeoutMs = 8_000 } = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const error = new Error(`binance_http_${response.status}`);
      error.code = `binance_http_${response.status}`;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchClosedKlines({
  symbol,
  quote = QUOTE,
  interval = "1m",
  startTime,
  endTime,
  limit = 1_000,
  now = Date.now(),
  fetchImpl = global.fetch,
  backfilled = true,
}) {
  const params = new URLSearchParams({
    symbol: `${symbol}${quote}`,
    interval,
    limit: String(Math.max(1, Math.min(limit, 1_000))),
  });
  if (Number.isFinite(startTime))
    params.set("startTime", String(Math.floor(startTime)));
  if (Number.isFinite(endTime))
    params.set("endTime", String(Math.floor(endTime)));
  const rows = await fetchJson(`${BINANCE_MARKET_BASE}/klines?${params}`, {
    fetchImpl,
  });
  return (Array.isArray(rows) ? rows : [])
    .map((row) =>
      normalizeKline(row, {
        symbol,
        interval,
        receivedAtMs: now,
        backfilled,
      })
    )
    .filter((bar) => bar && bar.closeTimeMs < now);
}

function normalizeDerivativeKline(
  row,
  { symbol, seriesType, interval = "5m", receivedAtMs = Date.now() }
) {
  if (!Array.isArray(row) || row.length < 7) return null;
  const openTimeMs = timestampMs(row[0]);
  const closeTimeMs = timestampMs(row[6]);
  const values = row.slice(1, 5).map(Number);
  if (
    !Number.isFinite(openTimeMs) ||
    !Number.isFinite(closeTimeMs) ||
    !values.every(Number.isFinite)
  )
    return null;
  return {
    symbol,
    seriesType,
    interval,
    openTimeMs,
    closeTimeMs,
    open: values[0],
    high: values[1],
    low: values[2],
    close: values[3],
    source: "binance_futures",
    availableAtMs: Math.max(closeTimeMs + 1, receivedAtMs),
  };
}

async function fetchClosedDerivativeKlines({
  symbol,
  quote = QUOTE,
  seriesType = "contract",
  interval = "5m",
  startTime,
  endTime,
  limit = 1_000,
  now = Date.now(),
  fetchImpl = global.fetch,
}) {
  const endpoint =
    seriesType === "mark"
      ? "markPriceKlines"
      : seriesType === "index"
        ? "indexPriceKlines"
        : seriesType === "premium"
          ? "premiumIndexKlines"
          : "klines";
  const params = new URLSearchParams({
    interval,
    limit: String(Math.max(1, Math.min(limit, 1_000))),
  });
  if (seriesType === "index") params.set("pair", `${symbol}${quote}`);
  else params.set("symbol", `${symbol}${quote}`);
  if (Number.isFinite(startTime))
    params.set("startTime", String(Math.floor(startTime)));
  if (Number.isFinite(endTime))
    params.set("endTime", String(Math.floor(endTime)));
  const rows = await fetchJson(
    `${BINANCE_FUTURES_BASE}/${endpoint}?${params}`,
    { fetchImpl }
  );
  return (Array.isArray(rows) ? rows : [])
    .map((row) =>
      normalizeDerivativeKline(row, {
        symbol,
        seriesType,
        interval,
        receivedAtMs: now,
      })
    )
    .filter((bar) => bar && bar.closeTimeMs < now);
}

async function fetchFundingRates({
  symbol,
  quote = QUOTE,
  startTime,
  endTime,
  limit = 1_000,
  now = Date.now(),
  fetchImpl = global.fetch,
}) {
  const params = new URLSearchParams({
    symbol: `${symbol}${quote}`,
    limit: String(Math.max(1, Math.min(limit, 1_000))),
  });
  if (Number.isFinite(startTime))
    params.set("startTime", String(Math.floor(startTime)));
  if (Number.isFinite(endTime))
    params.set("endTime", String(Math.floor(endTime)));
  const rows = await fetchJson(
    `${BINANCE_FUTURES_BASE}/fundingRate?${params}`,
    { fetchImpl }
  );
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const calcTimeMs = timestampMs(row?.fundingTime);
      const fundingRate = Number(row?.fundingRate);
      if (!Number.isFinite(calcTimeMs) || !Number.isFinite(fundingRate))
        return null;
      return {
        symbol,
        calcTimeMs,
        fundingIntervalHours: 8,
        fundingRate,
        source: "binance_futures",
        availableAtMs: Math.max(calcTimeMs + 1, now),
      };
    })
    .filter(Boolean);
}

function aggregateBars(
  bars = [],
  intervalMs = 5 * 60 * 1_000,
  interval = "5m",
  { sourceIntervalMs = 60_000, requireComplete = true } = {}
) {
  const buckets = new Map();
  for (const bar of bars) {
    const bucket = Math.floor(bar.openTimeMs / intervalMs) * intervalMs;
    const current = buckets.get(bucket);
    if (!current) {
      buckets.set(bucket, {
        bars: [bar],
      });
      continue;
    }
    current.bars.push(bar);
  }
  const expected = Math.max(1, Math.floor(intervalMs / sourceIntervalMs));
  const result = [];
  for (const [bucket, entry] of buckets) {
    const source = entry.bars.sort(
      (left, right) => left.openTimeMs - right.openTimeMs
    );
    if (
      requireComplete &&
      (source.length !== expected ||
        source.some(
          (bar, index) => bar.openTimeMs !== bucket + index * sourceIntervalMs
        ))
    )
      continue;
    const aggregated = {
      ...source[0],
      interval,
      openTimeMs: bucket,
      closeTimeMs: bucket + intervalMs - 1,
      open: source[0].open,
      high: Math.max(...source.map((bar) => bar.high)),
      low: Math.min(...source.map((bar) => bar.low)),
      close: source.at(-1).close,
      volume: source.reduce((sum, bar) => sum + bar.volume, 0),
      quoteVolume: source.reduce((sum, bar) => sum + bar.quoteVolume, 0),
      tradeCount: source.reduce((sum, bar) => sum + bar.tradeCount, 0),
      takerBuyBaseVolume: source.reduce(
        (sum, bar) => sum + bar.takerBuyBaseVolume,
        0
      ),
      takerBuyQuoteVolume: source.reduce(
        (sum, bar) => sum + bar.takerBuyQuoteVolume,
        0
      ),
    };
    const receivedAtMs = Math.max(
      ...source.map((bar) => Number(bar.receivedAtMs || 0))
    );
    result.push({
      ...aggregated,
      ...envelopeForBar(aggregated, {
        receivedAtMs,
        backfilled: source.every((bar) => bar.backfilled !== false),
        availabilityEstimated: source.every(
          (bar) => bar.availabilityEstimated !== false
        ),
        availableAtMs: Math.max(
          ...source.map((bar) =>
            Number(bar.availableAtMs ?? bar.closeTimeMs + 1)
          )
        ),
        gapDetected: source.some((bar) => bar.gapDetected),
      }),
    });
  }
  return result.sort((left, right) => left.openTimeMs - right.openTimeMs);
}

module.exports = {
  BINANCE_FUTURES_BASE,
  BINANCE_MARKET_BASE,
  aggregateBars,
  fetchClosedKlines,
  fetchClosedDerivativeKlines,
  fetchFundingRates,
  normalizeKline,
  normalizeDerivativeKline,
  timestampMs,
};
