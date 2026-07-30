/* eslint-env jest */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseDerivativeKlines,
  parseFundingRates,
  parseMetrics,
} = require("../../../scripts/crypto-forecast-derivatives-backfill");
const {
  CryptoForecastStore,
} = require("../../../utils/cryptoForecasting/store");

describe("crypto forecast derivative archive contracts", () => {
  let root;
  let store;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-derivatives-"));
    store = new CryptoForecastStore({ root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("normalizes official kline, funding and metrics CSV shapes", () => {
    const kline = parseDerivativeKlines(
      "1700000000000,100,110,90,105,1,1700000299999,2,3,4,5,0\n",
      { symbol: "BTC", seriesType: "mark" }
    );
    const funding = parseFundingRates("1700000000000,8,0.0001\n", {
      symbol: "BTC",
    });
    const metrics = parseMetrics("2024-01-01 00:00:00,BTCUSDT,1,2,3,4,5,6\n", {
      symbol: "BTC",
    });
    expect(kline[0]).toMatchObject({
      symbol: "BTC",
      seriesType: "mark",
      open: 100,
      close: 105,
    });
    expect(funding[0]).toMatchObject({
      fundingIntervalHours: 8,
      fundingRate: 0.0001,
    });
    expect(metrics[0]).toMatchObject({
      sumOpenInterest: 1,
      sumOpenInterestValue: 2,
      sumTakerLongShortVolRatio: 6,
    });
  });

  it("stores derivative evidence separately and reports it ineligible before 180 days", () => {
    store.upsertDerivativeKlines([
      {
        symbol: "BTC",
        seriesType: "mark",
        interval: "5m",
        openTimeMs: 1_700_000_000_000,
        closeTimeMs: 1_700_000_299_999,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        source: "test",
        availableAtMs: 1_700_000_300_000,
      },
    ]);
    store.upsertFundingRates([
      {
        symbol: "BTC",
        calcTimeMs: 1_700_000_000_000,
        fundingIntervalHours: 8,
        fundingRate: 0.0001,
        source: "test",
        availableAtMs: 1_700_000_000_001,
      },
    ]);
    store.upsertDerivativeMetrics([
      {
        symbol: "BTC",
        createTimeMs: 1_700_000_000_000,
        sumOpenInterest: 1,
        sumOpenInterestValue: 2,
        countToptraderLongShortRatio: 3,
        sumToptraderLongShortRatio: 4,
        countLongShortRatio: 5,
        sumTakerLongShortVolRatio: 6,
        source: "test",
        availableAtMs: 1_700_000_300_000,
      },
    ]);
    const coverage = store.derivativeCoverage();
    expect(coverage).toHaveLength(3);
    expect(coverage.every((entry) => entry.modelInputEligible === false)).toBe(
      true
    );
  });
});
