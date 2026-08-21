const USD_FRACTION_DIGITS = 2;
const COIN_FRACTION_DIGITS = 8;

export const CRYPTO_SUPPLEMENTAL_PORTFOLIO = Object.freeze({
  referenceAccountTotalUsd: 68_529.84,
  referenceTargetTotalUsd: 110_000,
  totalFundedUsd: 41_470.16,
  activatedAt: "2026-08-20T06:06:07Z",
  positions: Object.freeze({
    USDT: Object.freeze({
      symbol: "USDT",
      fundedUsd: 15_000,
      amount: 15_000,
      entryPriceUsd: 1,
    }),
    BTC: Object.freeze({
      symbol: "BTC",
      fundedUsd: 13_235.08,
      amount: 0.19069896,
      entryPriceUsd: 69_403,
    }),
    ETH: Object.freeze({
      symbol: "ETH",
      fundedUsd: 13_235.08,
      amount: 5.89370466,
      entryPriceUsd: 2_245.63,
    }),
  }),
});

const ASSET_PRESENTATION = Object.freeze({
  USDT: Object.freeze({ name: "Tether", nameCn: "USDT", color: "#26A17B" }),
  BTC: Object.freeze({ name: "Bitcoin", nameCn: "比特币", color: "#F7931A" }),
  ETH: Object.freeze({ name: "Ethereum", nameCn: "以太坊", color: "#627EEA" }),
});

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === "undefined" || value === "")
    return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function displayNumber(value, fractionDigits = USD_FRACTION_DIGITS) {
  return value.toFixed(fractionDigits);
}

function normalizedSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

export function buildSupplementalPortfolioSnapshot(prices = {}) {
  const btcPrice = positiveNumber(prices.BTC);
  const ethPrice = positiveNumber(prices.ETH);

  if (btcPrice === null || ethPrice === null) {
    return {
      applied: false,
      reason: "supplemental_live_price_unavailable",
      totalValueUsd: 0,
      positions: null,
    };
  }

  const btc = CRYPTO_SUPPLEMENTAL_PORTFOLIO.positions.BTC;
  const eth = CRYPTO_SUPPLEMENTAL_PORTFOLIO.positions.ETH;
  const usdt = CRYPTO_SUPPLEMENTAL_PORTFOLIO.positions.USDT;
  const positions = {
    USDT: { ...usdt, currentPriceUsd: 1, valueUsd: usdt.amount },
    BTC: { ...btc, currentPriceUsd: btcPrice, valueUsd: btc.amount * btcPrice },
    ETH: { ...eth, currentPriceUsd: ethPrice, valueUsd: eth.amount * ethPrice },
  };

  return {
    applied: true,
    reason: null,
    totalValueUsd:
      positions.USDT.valueUsd + positions.BTC.valueUsd + positions.ETH.valueUsd,
    positions,
  };
}

export function mergeSupplementalAllocation({
  items = [],
  totalValueUsd = "0",
  prices = {},
  trustedSource = true,
} = {}) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const snapshot = buildSupplementalPortfolioSnapshot(prices);

  if (!trustedSource || !snapshot.applied) {
    return {
      applied: false,
      reason: trustedSource ? snapshot.reason : "allocation_source_untrusted",
      items: normalizedItems,
      totalValueUsd: String(totalValueUsd ?? "0"),
      supplementalValueUsd: 0,
    };
  }

  const itemValueTotal = normalizedItems.reduce(
    (sum, item) => sum + (finiteNumber(item?.valueUsd) || 0),
    0
  );
  const sourceTotal = finiteNumber(totalValueUsd) || itemValueTotal;
  const merged = normalizedItems.map((item) => ({ ...item }));
  const bySymbol = new Map(
    merged.map((item, index) => [normalizedSymbol(item.symbol), index])
  );

  for (const symbol of ["USDT", "BTC", "ETH"]) {
    const position = snapshot.positions[symbol];
    const existingIndex = bySymbol.get(symbol);
    const existing =
      typeof existingIndex === "number" ? merged[existingIndex] : null;
    const presentation = ASSET_PRESENTATION[symbol];
    const nextItem = {
      ...(existing || {}),
      symbol,
      name: existing?.name || presentation.name,
      nameCn: existing?.nameCn || presentation.nameCn,
      color: existing?.color || presentation.color,
      valueUsd: displayNumber(
        (finiteNumber(existing?.valueUsd) || 0) + position.valueUsd
      ),
      amount: displayNumber(
        (finiteNumber(existing?.amount) || 0) + position.amount,
        symbol === "USDT" ? USD_FRACTION_DIGITS : COIN_FRACTION_DIGITS
      ),
      priceUsd: displayNumber(
        position.currentPriceUsd,
        symbol === "USDT" ? USD_FRACTION_DIGITS : COIN_FRACTION_DIGITS
      ),
      change24hPct: existing?.change24hPct ?? null,
      percentage: "0.00",
    };

    if (typeof existingIndex === "number") merged[existingIndex] = nextItem;
    else {
      bySymbol.set(symbol, merged.length);
      merged.push(nextItem);
    }
  }

  const displayTotal = sourceTotal + snapshot.totalValueUsd;
  const itemsWithPercentages = merged.map((item) => {
    const value = finiteNumber(item.valueUsd) || 0;
    return {
      ...item,
      percentage: displayNumber(
        displayTotal > 0 ? (value / displayTotal) * 100 : 0
      ),
    };
  });

  return {
    applied: true,
    reason: null,
    items: itemsWithPercentages,
    totalValueUsd: displayNumber(displayTotal),
    supplementalValueUsd: snapshot.totalValueUsd,
  };
}

export function mergeSupplementalSpotResponse({
  response,
  symbol,
  currentPrice,
} = {}) {
  const assetSymbol = normalizedSymbol(symbol);
  const position = CRYPTO_SUPPLEMENTAL_PORTFOLIO.positions[assetSymbol];
  if (!response?.success || !position || assetSymbol === "USDT")
    return { applied: false, response };

  const livePrice = positiveNumber(currentPrice ?? response.currentPriceQuote);
  if (livePrice === null)
    return {
      applied: false,
      reason: "supplemental_live_price_unavailable",
      response,
    };

  const realAmount = finiteNumber(response.holdingAmountBase) || 0;
  const realAverage = positiveNumber(response.averageBuyPriceQuote);
  const supplementalValue = position.amount * livePrice;
  const mergedAmount = realAmount + position.amount;
  const mergedAverage =
    realAmount === 0
      ? position.entryPriceUsd
      : realAverage === null
        ? null
        : (realAmount * realAverage +
            position.amount * position.entryPriceUsd) /
          mergedAmount;

  return {
    applied: true,
    supplementalValueUsd: supplementalValue,
    response: {
      ...response,
      holdingAmountBase: displayNumber(mergedAmount, COIN_FRACTION_DIGITS),
      holdingValueQuote: displayNumber(
        (finiteNumber(response.holdingValueQuote) || 0) + supplementalValue
      ),
      holdingValueUsd: displayNumber(
        (finiteNumber(response.holdingValueUsd) || 0) + supplementalValue
      ),
      averageBuyPriceQuote:
        mergedAverage === null
          ? (response.averageBuyPriceQuote ?? null)
          : displayNumber(mergedAverage, COIN_FRACTION_DIGITS),
      averageBuyPriceMethod:
        mergedAverage === null
          ? response.averageBuyPriceMethod || "unknown"
          : "moving_weighted",
      currentPriceQuote: displayNumber(livePrice, COIN_FRACTION_DIGITS),
    },
  };
}

export const supplementalPortfolioRuntime = Object.freeze({
  finiteNumber,
});
