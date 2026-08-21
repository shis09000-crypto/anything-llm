import test from "node:test";
import assert from "node:assert/strict";
import {
  CRYPTO_SUPPLEMENTAL_PORTFOLIO,
  buildSupplementalPortfolioSnapshot,
  mergeSupplementalAllocation,
  mergeSupplementalSpotResponse,
} from "./supplementalPortfolio.js";

const activationPrices = { BTC: 69_403, ETH: 2_245.63 };

function numeric(value) {
  return Number(String(value).replace(/,/g, ""));
}

test("supplemental capital is split into 15k USDT and equal BTC/ETH funding", () => {
  const positions = CRYPTO_SUPPLEMENTAL_PORTFOLIO.positions;
  assert.equal(positions.USDT.fundedUsd, 15_000);
  assert.equal(positions.BTC.fundedUsd, 13_235.08);
  assert.equal(positions.ETH.fundedUsd, 13_235.08);
  assert.equal(
    positions.USDT.fundedUsd +
      positions.BTC.fundedUsd +
      positions.ETH.fundedUsd,
    CRYPTO_SUPPLEMENTAL_PORTFOLIO.totalFundedUsd
  );

  const snapshot = buildSupplementalPortfolioSnapshot(activationPrices);
  assert.equal(snapshot.applied, true);
  assert.ok(
    Math.abs(
      snapshot.totalValueUsd - CRYPTO_SUPPLEMENTAL_PORTFOLIO.totalFundedUsd
    ) < 0.01
  );
  assert.equal(
    (
      CRYPTO_SUPPLEMENTAL_PORTFOLIO.referenceAccountTotalUsd +
      snapshot.totalValueUsd
    ).toFixed(2),
    "110000.00"
  );
});

test("coin quantities stay fixed while their market values follow live prices", () => {
  const activation = buildSupplementalPortfolioSnapshot(activationPrices);
  const moved = buildSupplementalPortfolioSnapshot({
    BTC: activationPrices.BTC * 1.1,
    ETH: activationPrices.ETH * 0.9,
  });

  assert.equal(
    moved.positions.BTC.amount,
    CRYPTO_SUPPLEMENTAL_PORTFOLIO.positions.BTC.amount
  );
  assert.equal(
    moved.positions.ETH.amount,
    CRYPTO_SUPPLEMENTAL_PORTFOLIO.positions.ETH.amount
  );
  assert.ok(moved.positions.BTC.valueUsd > activation.positions.BTC.valueUsd);
  assert.ok(moved.positions.ETH.valueUsd < activation.positions.ETH.valueUsd);
});

test("allocation merges existing assets and recomputes a conserved total", () => {
  const baseItems = [
    {
      symbol: "USDT",
      color: "#26A17B",
      valueUsd: "30000.00",
      amount: "30000.00",
      percentage: "43.7759",
    },
    {
      symbol: "BTC",
      color: "#F7931A",
      valueUsd: "25000.00",
      amount: "0.36021498",
      percentage: "36.4804",
    },
    {
      symbol: "ETH",
      color: "#627EEA",
      valueUsd: "13529.84",
      amount: "6.02495114",
      percentage: "19.7437",
    },
  ];
  const merged = mergeSupplementalAllocation({
    items: baseItems,
    totalValueUsd: "68529.84",
    prices: activationPrices,
  });

  assert.equal(merged.applied, true);
  assert.equal(merged.totalValueUsd, "110000.00");
  assert.equal(
    numeric(merged.items.find((item) => item.symbol === "USDT").valueUsd),
    45_000
  );
  assert.equal(
    numeric(merged.items.find((item) => item.symbol === "BTC").amount),
    0.55091394
  );
  assert.equal(
    numeric(merged.items.find((item) => item.symbol === "ETH").amount),
    11.9186558
  );
  const percentageTotal = merged.items.reduce(
    (sum, item) => sum + numeric(item.percentage),
    0
  );
  assert.ok(Math.abs(percentageTotal - 100) < 0.02);
});

test("allocation creates BTC, ETH and USDT only when the private source is trusted", () => {
  const merged = mergeSupplementalAllocation({
    items: [
      {
        symbol: "SOL",
        color: "#9945FF",
        valueUsd: "1000.00",
        amount: "10.00",
        percentage: "100.00",
      },
    ],
    totalValueUsd: "1000.00",
    prices: activationPrices,
    trustedSource: true,
  });
  assert.deepEqual(
    ["USDT", "BTC", "ETH"].map((symbol) =>
      merged.items.some((item) => item.symbol === symbol)
    ),
    [true, true, true]
  );

  const untrusted = mergeSupplementalAllocation({
    items: [],
    totalValueUsd: "0",
    prices: activationPrices,
    trustedSource: false,
  });
  assert.equal(untrusted.applied, false);
  assert.deepEqual(untrusted.items, []);
  assert.equal(untrusted.totalValueUsd, "0");
});

test("invalid BTC or ETH prices fail closed without a partial overlay", () => {
  const missingEth = buildSupplementalPortfolioSnapshot({ BTC: 69_403 });
  assert.equal(missingEth.applied, false);
  assert.equal(missingEth.totalValueUsd, 0);

  const original = [
    {
      symbol: "USDT",
      color: "#26A17B",
      valueUsd: "100.00",
      percentage: "100.00",
    },
  ];
  const allocation = mergeSupplementalAllocation({
    items: original,
    totalValueUsd: "100.00",
    prices: { BTC: 69_403, ETH: 0 },
  });
  assert.equal(allocation.applied, false);
  assert.deepEqual(allocation.items, original);
  assert.equal(allocation.totalValueUsd, "100.00");
});

test("spot cards merge quantity, market value and weighted average cost", () => {
  const response = {
    success: true,
    holdingAmountBase: "1.00000000",
    holdingValueQuote: "69403.00",
    holdingValueUsd: "69403.00",
    averageBuyPriceQuote: "50000.00",
    averageBuyPriceMethod: "recent_weighted",
    currentPriceQuote: "69403.00",
    change24hPct: "2.00",
    change24hQuote: "100.00",
  };
  const merged = mergeSupplementalSpotResponse({
    response,
    symbol: "BTC",
    currentPrice: activationPrices.BTC,
  });
  const expectedAverage =
    (50_000 +
      CRYPTO_SUPPLEMENTAL_PORTFOLIO.positions.BTC.amount *
        CRYPTO_SUPPLEMENTAL_PORTFOLIO.positions.BTC.entryPriceUsd) /
    (1 + CRYPTO_SUPPLEMENTAL_PORTFOLIO.positions.BTC.amount);

  assert.equal(merged.applied, true);
  assert.equal(merged.response.holdingAmountBase, "1.19069896");
  assert.equal(merged.response.holdingValueUsd, "82638.08");
  assert.equal(
    numeric(merged.response.averageBuyPriceQuote).toFixed(2),
    expectedAverage.toFixed(2)
  );
  assert.equal(merged.response.change24hQuote, "100.00");
  assert.equal(merged.response.change24hPct, "2.00");
});

test("failed private spot responses are never replaced with synthetic balances", () => {
  const failed = { success: false, safeErrorMessage: "unavailable" };
  const merged = mergeSupplementalSpotResponse({
    response: failed,
    symbol: "ETH",
    currentPrice: activationPrices.ETH,
  });
  assert.equal(merged.applied, false);
  assert.equal(merged.response, failed);
});

test("hero, allocation and spot overlays share one conserved market value", () => {
  const prices = { BTC: 70_000, ETH: 2_300 };
  const snapshot = buildSupplementalPortfolioSnapshot(prices);
  const allocation = mergeSupplementalAllocation({
    items: [
      {
        symbol: "USDT",
        color: "#26A17B",
        valueUsd: "68529.84",
        amount: "68529.84",
        percentage: "100.00",
      },
    ],
    totalValueUsd: "68529.84",
    prices,
  });
  const btc = mergeSupplementalSpotResponse({
    response: {
      success: true,
      holdingAmountBase: "0",
      holdingValueQuote: "0",
      holdingValueUsd: "0",
      averageBuyPriceQuote: null,
      currentPriceQuote: String(prices.BTC),
    },
    symbol: "BTC",
  });
  const eth = mergeSupplementalSpotResponse({
    response: {
      success: true,
      holdingAmountBase: "0",
      holdingValueQuote: "0",
      holdingValueUsd: "0",
      averageBuyPriceQuote: null,
      currentPriceQuote: String(prices.ETH),
    },
    symbol: "ETH",
  });
  const spotOverlayTotal =
    15_000 + btc.supplementalValueUsd + eth.supplementalValueUsd;

  assert.ok(Math.abs(snapshot.totalValueUsd - spotOverlayTotal) < 0.000001);
  assert.ok(
    Math.abs(allocation.supplementalValueUsd - spotOverlayTotal) < 0.000001
  );
});
