const {
  addDecimalStrings,
  multiplyDecimalStrings,
  toScaledInt,
  trimDecimal,
} = require("./decimal");
const { GateRestClient } = require("./restClient");
const { safeErrorMessage } = require("./sanitizer");

const DEFAULT_TOP_ASSET_LIMIT = 6;
const MAX_TOP_ASSET_LIMIT = 20;
const DEFAULT_EXCLUDED_ASSETS = ["BTC", "ETH", "USDT", "GUSD"];
const DEFAULT_QUOTE_ASSET = "USDT";
const AMOUNT_SCALE = 12;
const PRICE_SCALE = 8;

function normalizeAsset(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizePositiveAmount(value) {
  const amount = String(value || "0");
  return toScaledInt(amount, AMOUNT_SCALE) > 0n ? amount : "0";
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_TOP_ASSET_LIMIT;
  return Math.max(1, Math.min(MAX_TOP_ASSET_LIMIT, Math.round(number)));
}

function normalizeExclusions(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeAsset).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map(normalizeAsset).filter(Boolean);
  }
  return DEFAULT_EXCLUDED_ASSETS;
}

function addBalance(balances, asset, amount) {
  const normalizedAsset = normalizeAsset(asset);
  const normalizedAmount = normalizePositiveAmount(amount);
  if (!normalizedAsset || toScaledInt(normalizedAmount, AMOUNT_SCALE) <= 0n) {
    return;
  }

  const current = balances.get(normalizedAsset) || "0";
  balances.set(
    normalizedAsset,
    addDecimalStrings([current, normalizedAmount], {
      scale: AMOUNT_SCALE,
      decimals: 8,
    })
  );
}

function collectSpotBalances(accounts = []) {
  const balances = new Map();
  if (!Array.isArray(accounts)) return balances;

  for (const account of accounts) {
    addBalance(
      balances,
      account?.currency,
      addDecimalStrings([account?.available || "0", account?.locked || "0"], {
        scale: AMOUNT_SCALE,
        decimals: 8,
      })
    );
  }

  return balances;
}

function mergeEarnBalances(balances, lends = []) {
  if (!Array.isArray(lends)) return balances;

  for (const lend of lends) {
    addBalance(
      balances,
      lend?.currency,
      lend?.amount || lend?.lent_amount || "0"
    );
  }

  return balances;
}

function normalizeTickerPrice(ticker) {
  const last = ticker?.last || ticker?.close;
  return toScaledInt(last || "0", PRICE_SCALE) > 0n ? String(last) : null;
}

function normalizeTickerChange(ticker) {
  const value =
    ticker?.change_percentage ??
    ticker?.change_utc0 ??
    ticker?.change_utc8 ??
    ticker?.change;
  return value === undefined || value === null ? null : String(value);
}

function tickerMapByPair(tickers = []) {
  const map = new Map();
  if (!Array.isArray(tickers)) return map;

  for (const ticker of tickers) {
    const pair = normalizeAsset(ticker?.currency_pair);
    if (!pair) continue;
    const price = normalizeTickerPrice(ticker);
    if (!price) continue;
    map.set(pair, {
      price,
      change24hPct: normalizeTickerChange(ticker),
    });
  }

  return map;
}

class GateTopSpotAssetsService {
  constructor({ restClientFactory = () => new GateRestClient() } = {}) {
    this.restClientFactory = restClientFactory;
  }

  async topAssets({
    limit = DEFAULT_TOP_ASSET_LIMIT,
    exclude = DEFAULT_EXCLUDED_ASSETS,
    quote = DEFAULT_QUOTE_ASSET,
  } = {}) {
    const normalizedLimit = normalizeLimit(limit);
    const quoteAsset = normalizeAsset(quote) || DEFAULT_QUOTE_ASSET;
    const excludedAssets = new Set(normalizeExclusions(exclude));
    const client = this.restClientFactory();

    const [spotResult, earnResult, tickersResult] = await Promise.allSettled([
      client.getSpotAccountsRaw(),
      client.getEarnUniLendsRaw(),
      client.getSpotTickersRaw(),
    ]);

    const partialFailures = [];
    if (spotResult.status !== "fulfilled" || !spotResult.value.success) {
      throw new Error(
        spotResult.status === "fulfilled"
          ? spotResult.value.safeErrorMessage || "Gate spot accounts failed."
          : safeErrorMessage(spotResult.reason)
      );
    }

    if (earnResult.status !== "fulfilled" || !earnResult.value.success) {
      partialFailures.push({
        source: "earn_uni_lends",
        message:
          earnResult.status === "fulfilled"
            ? earnResult.value.safeErrorMessage || "Gate earn balance failed."
            : safeErrorMessage(earnResult.reason),
      });
    }

    if (tickersResult.status !== "fulfilled" || !tickersResult.value.success) {
      throw new Error(
        tickersResult.status === "fulfilled"
          ? tickersResult.value.safeErrorMessage || "Gate spot tickers failed."
          : safeErrorMessage(tickersResult.reason)
      );
    }

    const balances = mergeEarnBalances(
      collectSpotBalances(spotResult.value.data),
      earnResult.status === "fulfilled" && earnResult.value.success
        ? earnResult.value.data
        : []
    );
    const tickers = tickerMapByPair(tickersResult.value.data);
    const candidates = [];

    for (const [baseAsset, holdingAmountBase] of balances.entries()) {
      if (excludedAssets.has(baseAsset)) continue;

      const pair = `${baseAsset}_${quoteAsset}`;
      const ticker = tickers.get(pair);
      if (!ticker) continue;

      const holdingValueQuote = multiplyDecimalStrings(
        holdingAmountBase,
        ticker.price,
        {
          leftScale: AMOUNT_SCALE,
          rightScale: PRICE_SCALE,
          decimals: 2,
        }
      );
      if (toScaledInt(holdingValueQuote, 2) <= 0n) continue;

      candidates.push({
        pair,
        baseAsset,
        quoteAsset,
        symbol: `${baseAsset}/${quoteAsset}`,
        holdingAmountBase: trimDecimal(holdingAmountBase),
        currentPriceQuote: ticker.price,
        change24hPct: ticker.change24hPct,
        holdingValueQuote,
        holdingValueUsd:
          quoteAsset === "USDT" || quoteAsset === "USD"
            ? holdingValueQuote
            : null,
      });
    }

    candidates.sort((left, right) => {
      const leftValue = toScaledInt(left.holdingValueQuote, 2);
      const rightValue = toScaledInt(right.holdingValueQuote, 2);
      if (leftValue === rightValue) return left.pair.localeCompare(right.pair);
      return rightValue > leftValue ? 1 : -1;
    });

    return {
      success: true,
      asOf: Date.now(),
      exchange: "gate",
      marketType: "spot",
      quoteAsset,
      limit: normalizedLimit,
      excludedAssets: [...excludedAssets],
      connectionStatus: partialFailures.length ? "degraded" : "connected",
      assets: candidates.slice(0, normalizedLimit),
      partialFailures,
    };
  }
}

const cryptoGateTopSpotAssetsService = new GateTopSpotAssetsService();

module.exports = {
  GateTopSpotAssetsService,
  cryptoGateTopSpotAssetsService,
};
