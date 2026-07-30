/* eslint-env jest */

process.env.NODE_ENV = "test";

const {
  MAX_ANALYSIS_PAYLOAD_BYTES,
  TIMEFRAME_CONFIG,
  _internals,
  analyzeTimeframe,
  buildQuantAnalysis,
} = require("../../../utils/agents/aibitat/plugins/crypto-market/quantAnalysis");

function candleSeries({
  count = 200,
  intervalMs,
  startClose = 100,
  step = 1,
  startTs = 1_700_000_000_000,
  volume = (index) => 100 + index,
} = {}) {
  return Array.from({ length: count }, (_, index) => {
    const close = startClose + step * index;
    return {
      ts: startTs + intervalMs * index,
      open: String(close - 0.25),
      high: String(close + 1),
      low: String(close - 1),
      close: String(close),
      volume: String(volume(index)),
    };
  });
}

describe("crypto quant analysis", () => {
  it("uses deterministic SMA, EMA, Wilder RSI, and drawdown formulas", () => {
    expect(_internals.smaSeries([1, 2, 3, 4, 5], 3)).toEqual([
      null,
      null,
      2,
      3,
      4,
    ]);
    expect(_internals.emaSeries([1, 2, 3, 4, 5], 3)).toEqual([
      null,
      null,
      2,
      3,
      4,
    ]);
    expect(_internals.rsiSeries(Array(20).fill(10), 14)[19]).toBe(50);
    expect(_internals.maximumDrawdown([100, 120, 90, 110], 30)).toBeCloseTo(
      -0.25,
      10
    );
  });

  it("excludes the forming candle from indicators and returned closed candles", () => {
    const intervalMs = TIMEFRAME_CONFIG["1h"].intervalMs;
    const candles = candleSeries({ count: 62, intervalMs });
    const formingStart = candles[candles.length - 1].ts;
    const result = analyzeTimeframe({
      id: "1h",
      candles,
      now: formingStart + intervalMs / 2,
    });

    expect(result.barsCalculated).toBe(61);
    expect(result.barsReturned).toBe(61);
    expect(result.formingCandle[0]).toBe(formingStart);
    expect(result.candles[result.candles.length - 1][0]).toBe(
      formingStart - intervalMs
    );
    expect(result.indicators.movingAverages.ma5.value).toBe(158);
  });

  it("computes fixed-window Fibonacci retracements and extensions without lookahead", () => {
    const intervalMs = TIMEFRAME_CONFIG["1d"].intervalMs;
    const candles = candleSeries({ count: 200, intervalMs });
    const now = candles[candles.length - 1].ts + intervalMs + 1;
    const result = analyzeTimeframe({ id: "1d", candles, now });
    const fibonacci = result.levels.fibonacci;

    expect(fibonacci).toMatchObject({
      status: "available",
      lookback: 100,
      direction: "upswing",
    });
    expect(fibonacci.swing.startPrice).toBe(199);
    expect(fibonacci.swing.endPrice).toBe(300);
    expect(fibonacci.retracements["0.236"]).toBe(276.164);
    expect(fibonacci.retracements["0.618"]).toBe(237.582);
    expect(fibonacci.extensions["1.272"]).toBe(327.472);
    expect(fibonacci.extensions["1.618"]).toBe(362.418);
    expect(fibonacci.nearestBelow).toBe(276.164);
    expect(fibonacci.nearestAbove).toBe(300);
  });

  it("returns complete multi-timeframe analysis with bounded compact candles", () => {
    const timeframePayloads = Object.fromEntries(
      Object.entries(TIMEFRAME_CONFIG).map(([id, config]) => [
        id,
        {
          candles: candleSeries({
            count: 200,
            intervalMs: config.intervalMs,
          }),
          source: "gate",
          cacheHit: false,
        },
      ])
    );
    const latestEnd = Math.max(
      ...Object.entries(TIMEFRAME_CONFIG).map(
        ([id, config]) =>
          timeframePayloads[id].candles[199].ts + config.intervalMs
      )
    );
    const result = buildQuantAnalysis({
      timeframePayloads,
      now: latestEnd + 1,
    });

    expect(result.analysisStatus).toBe("complete");
    expect(result.confluence.status).toBe("available");
    expect(result.scenarios).toHaveLength(3);
    expect(Object.values(result.timeframes)).toHaveLength(4);
    for (const timeframe of Object.values(result.timeframes)) {
      expect(timeframe.candles.length).toBeLessThanOrEqual(120);
      expect(timeframe.candles[0]).toHaveLength(6);
      expect(timeframe.formingCandle).toBeNull();
      expect(
        timeframe.indicators.shortTermSlopes.macdHistogram3Change
      ).not.toBeNull();
    }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      MAX_ANALYSIS_PAYLOAD_BYTES
    );
  });

  it("emits transparent bullish price-volume confirmation", () => {
    const intervalMs = TIMEFRAME_CONFIG["1h"].intervalMs;
    const candles = candleSeries({
      count: 100,
      intervalMs,
      volume: (index) => (index === 99 ? 10_000 : 100),
    });
    const result = analyzeTimeframe({
      id: "1h",
      candles,
      now: candles[99].ts + intervalMs + 1,
    });

    expect(result.events).toContainEqual({
      name: "elevated_volume",
      barsAgo: 0,
    });
    expect(result.events).toContainEqual({
      name: "bullish_price_volume_confirmation",
      barsAgo: 0,
    });
  });

  it("marks insufficient and unavailable data without fabricating scenarios", () => {
    const intervalMs = TIMEFRAME_CONFIG["1h"].intervalMs;
    const result = buildQuantAnalysis({
      timeframePayloads: {
        "1h": {
          candles: candleSeries({ count: 20, intervalMs }),
          source: "gate",
        },
      },
      now: 2_000_000_000_000,
      partialFailures: [
        { source: "gate_candles", timeframe: "1d", error: "timeout" },
      ],
    });

    expect(result.analysisStatus).toBe("unavailable");
    expect(result.timeframes["1h"].dataQuality.status).toBe("insufficient");
    expect(result.timeframes["1h"].indicators).toBeNull();
    expect(result.timeframes["1h"].events).toEqual([]);
    expect(result.confluence.status).toBe("unavailable");
    expect(result.scenarios).toEqual([]);
    expect(result.partialFailures).toHaveLength(1);
  });
});
