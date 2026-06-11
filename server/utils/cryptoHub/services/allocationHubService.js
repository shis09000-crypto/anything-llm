const { GateRestClient, safeErrorMessage } = require("../../cryptoGate");

const STABLE_ALLOCATION_ASSETS = new Set(["USDT", "GUSD", "USDC"]);
const ASSET_COLORS = {
  BTC: "#1683FF",
  ETH: "#A855F7",
  USDT: "#FF8A00",
  GUSD: "#14C8B8",
  USDC: "#2775CA",
  SOL: "#4F63FF",
  BNB: "#F6B91A",
  XRP: "#F05272",
};

function normalizeAsset(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function decimalString(value, fractionDigits = 2) {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(fractionDigits);
}

function addAllocationBalance(balances, asset, amount) {
  const symbol = normalizeAsset(asset);
  const value = numberValue(amount);
  if (!symbol || value <= 0) return;
  balances.set(symbol, (balances.get(symbol) || 0) + value);
}

function collectAllocationBalances(accounts = [], earns = []) {
  const balances = new Map();
  if (Array.isArray(accounts)) {
    for (const account of accounts) {
      addAllocationBalance(
        balances,
        account?.currency,
        numberValue(account?.available) + numberValue(account?.locked)
      );
    }
  }
  if (Array.isArray(earns)) {
    for (const lend of earns) {
      addAllocationBalance(
        balances,
        lend?.currency,
        lend?.amount || lend?.lent_amount
      );
    }
  }
  return balances;
}

function tickerMapByPair(tickers = []) {
  const map = new Map();
  if (!Array.isArray(tickers)) return map;
  for (const ticker of tickers) {
    const pair = normalizeAsset(ticker?.currency_pair);
    if (!pair) continue;
    const price = numberValue(ticker?.last || ticker?.close);
    if (price <= 0) continue;
    map.set(pair, {
      price,
      change24hPct:
        ticker?.change_percentage ??
        ticker?.change_utc0 ??
        ticker?.change_utc8 ??
        ticker?.change,
    });
  }
  return map;
}

function allocationItemFor({ symbol, amount, quoteAsset, ticker }) {
  const stable = STABLE_ALLOCATION_ASSETS.has(symbol);
  const priceUsd = stable ? 1 : ticker?.price;
  if (!priceUsd || priceUsd <= 0) return null;
  const valueUsd = amount * priceUsd;
  if (valueUsd <= 0) return null;
  return {
    symbol,
    name: stable ? "USD Stablecoin" : symbol,
    nameCn: stable ? symbol : symbol,
    color: ASSET_COLORS[symbol] || "#9CA3AF",
    valueUsd: decimalString(valueUsd, 2),
    percentage: "0",
    amount: decimalString(amount, stable ? 2 : 8),
    priceUsd: decimalString(priceUsd, stable ? 2 : 8),
    change24hPct:
      ticker?.change24hPct === undefined || ticker?.change24hPct === null
        ? null
        : String(ticker.change24hPct),
    quoteAsset,
  };
}

class AllocationHubService {
  constructor({ restClientFactory = () => new GateRestClient() } = {}) {
    this.restClientFactory = restClientFactory;
  }

  async snapshot({ quote = "USDT", config = null } = {}) {
    const quoteAsset = normalizeAsset(quote || "USDT");
    const client = this.restClientFactory();
    const [spotResult, earnResult, tickersResult] = await Promise.allSettled([
      client.getSpotAccountsRaw(),
      client.getEarnUniLendsRaw(),
      client.getSpotTickersRaw(),
    ]);

    if (spotResult.status !== "fulfilled" || !spotResult.value.success) {
      throw new Error(
        spotResult.status === "fulfilled"
          ? spotResult.value.safeErrorMessage || "Gate spot accounts failed."
          : safeErrorMessage(spotResult.reason)
      );
    }
    if (tickersResult.status !== "fulfilled" || !tickersResult.value.success) {
      throw new Error(
        tickersResult.status === "fulfilled"
          ? tickersResult.value.safeErrorMessage || "Gate spot tickers failed."
          : safeErrorMessage(tickersResult.reason)
      );
    }

    const partialFailures = [];
    if (earnResult.status !== "fulfilled" || !earnResult.value.success) {
      partialFailures.push({
        source: "earn_uni_lends",
        message:
          earnResult.status === "fulfilled"
            ? earnResult.value.safeErrorMessage || "Gate earn balance failed."
            : safeErrorMessage(earnResult.reason),
      });
    }

    const balances = collectAllocationBalances(
      spotResult.value.data,
      earnResult.status === "fulfilled" && earnResult.value.success
        ? earnResult.value.data
        : []
    );
    const tickers = tickerMapByPair(tickersResult.value.data);
    const rawItems = [];

    for (const [symbol, amount] of balances.entries()) {
      const ticker = tickers.get(`${symbol}_${quoteAsset}`);
      const item = allocationItemFor({ symbol, amount, quoteAsset, ticker });
      if (item) rawItems.push(item);
    }

    const totalValue = rawItems.reduce(
      (sum, item) => sum + numberValue(item.valueUsd),
      0
    );
    const items = rawItems
      .map((item) => ({
        ...item,
        percentage:
          totalValue > 0
            ? decimalString((numberValue(item.valueUsd) / totalValue) * 100, 2)
            : "0.00",
      }))
      .sort(
        (left, right) =>
          numberValue(right.valueUsd) - numberValue(left.valueUsd)
      );

    return {
      success: true,
      asOf: Date.now(),
      exchange: "gate",
      marketType: "spot",
      scope: "all",
      quoteAsset,
      totalValueUsd: decimalString(totalValue, 2),
      items,
      connectionStatus: partialFailures.length ? "degraded" : "connected",
      config,
      partialFailures,
    };
  }
}

module.exports = {
  AllocationHubService,
};
