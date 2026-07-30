/* eslint-env jest */

const {
  FEATURE_NAMES,
  MIN_BARS,
  buildFeatureVector,
  labelBandRatio,
} = require("../../../utils/cryptoForecasting/features");

function bars(count = MIN_BARS + 10, symbol = "BTC") {
  const start = 1_700_000_000_000;
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.01 + Math.sin(index / 20);
    return {
      symbol,
      interval: "5m",
      openTimeMs: start + index * 300_000,
      closeTimeMs: start + (index + 1) * 300_000 - 1,
      open: close - 0.05,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 10 + (index % 20),
      quoteVolume: (10 + (index % 20)) * close,
      tradeCount: 100 + (index % 50),
      takerBuyBaseVolume: 5 + (index % 10) / 10,
      takerBuyQuoteVolume: (5 + (index % 10) / 10) * close,
      source: "test",
    };
  });
}

describe("crypto forecast features", () => {
  it("returns a fixed, finite feature order and transparent coverage", () => {
    const source = bars();
    const result = buildFeatureVector({
      symbol: "BTC",
      bars: source,
      btcBars: source,
      asOfMs: source.at(-1).closeTimeMs,
    });

    expect(result.featureSchemaVersion).toBe("crypto-forecast-features-v1");
    expect(result.vector).toHaveLength(FEATURE_NAMES.length);
    expect(result.vector.every(Number.isFinite)).toBe(true);
    expect(Object.keys(result.values)).toEqual(FEATURE_NAMES);
    expect(result.values.asset_btc).toBe(1);
    expect(result.values.relative_btc_return_4h).toBe(0);
    expect(result.evidenceCoverage).toBeGreaterThan(0.9);
  });

  it("does not allow bars after asOf to change the feature vector", () => {
    const source = bars();
    const asOfMs = source.at(-1).closeTimeMs;
    const before = buildFeatureVector({
      symbol: "BTC",
      bars: source,
      btcBars: source,
      asOfMs,
    });
    const future = bars(20).map((bar, index) => ({
      ...bar,
      openTimeMs: asOfMs + 1 + index * 300_000,
      closeTimeMs: asOfMs + (index + 1) * 300_000,
      close: 10_000,
    }));
    const after = buildFeatureVector({
      symbol: "BTC",
      bars: [...source, ...future],
      btcBars: [...source, ...future],
      asOfMs,
    });

    expect(after.vector).toEqual(before.vector);
  });

  it("does not admit a bar received after the prediction decision", () => {
    const source = bars();
    const last = source.at(-1);
    last.availableAtMs = last.closeTimeMs + 10_000;
    const expected = buildFeatureVector({
      symbol: "BTC",
      bars: source.slice(0, -1),
      btcBars: source.slice(0, -1),
      asOfMs: last.closeTimeMs,
      decisionAtMs: last.closeTimeMs + 1,
    });
    const result = buildFeatureVector({
      symbol: "BTC",
      bars: source,
      btcBars: source,
      asOfMs: last.closeTimeMs,
      decisionAtMs: last.closeTimeMs + 1,
    });
    expect(result.vector).toEqual(expected.vector);
  });

  it("uses a volatility-aware band no smaller than round-trip costs", () => {
    const band = labelBandRatio(bars(), 4 * 60 * 60 * 1_000);
    expect(band).toBeGreaterThanOrEqual(0.0024);
  });

  it("abstains before the minimum history is available", () => {
    expect(
      buildFeatureVector({
        symbol: "BTC",
        bars: bars(100),
        btcBars: bars(100),
      })
    ).toMatchObject({
      status: "insufficient",
      reason: "insufficient_history",
      barsRequired: MIN_BARS,
    });
  });

  it("abstains when the latest 30-day feature window contains a gap", () => {
    const source = bars(MIN_BARS + 10);
    source.splice(source.length - 50, 1);
    expect(
      buildFeatureVector({
        symbol: "BTC",
        bars: source,
        btcBars: source,
        asOfMs: source.at(-1).closeTimeMs,
      })
    ).toMatchObject({
      status: "insufficient",
      reason: "market_data_gap",
    });
  });
});
