/* eslint-env jest */

const {
  aggregateBars,
  timestampMs,
} = require("../../../utils/cryptoForecasting/binance");

function minute(index) {
  const openTimeMs = 1_700_000_100_000 + index * 60_000;
  return {
    symbol: "BTC",
    interval: "1m",
    openTimeMs,
    closeTimeMs: openTimeMs + 59_999,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 2,
    quoteVolume: 200,
    tradeCount: 3,
    takerBuyBaseVolume: 1,
    takerBuyQuoteVolume: 100,
    source: "test",
  };
}

describe("crypto forecasting Binance normalization", () => {
  it("normalizes post-2025 microsecond timestamps", () => {
    expect(timestampMs(1_750_000_000_123_000)).toBe(1_750_000_000_123);
    expect(timestampMs(1_750_000_000_123)).toBe(1_750_000_000_123);
  });

  it("only emits complete contiguous five-minute bars", () => {
    expect(aggregateBars([0, 1, 2, 3, 4].map(minute))).toEqual([
      expect.objectContaining({
        interval: "5m",
        open: 100,
        close: 104.5,
        volume: 10,
        tradeCount: 15,
      }),
    ]);
    expect(aggregateBars([0, 1, 3, 4].map(minute))).toEqual([]);
  });
});
