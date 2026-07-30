/* eslint-env jest */

process.env.NODE_ENV = "test";

const Database = require("better-sqlite3");
const {
  FACTOR_REGISTRY,
  FACTOR_REGISTRY_SHA256,
} = require("../../../utils/goldAnalysis/contracts");
const {
  applyCftcAvailabilityRepairs,
  planCftcAvailabilityRepairs,
} = require("../../../utils/goldAnalysis/cftcAvailabilityRepair");
const {
  resolveCotRelease,
} = require("../../../utils/goldAnalysis/cftcReleaseCalendar");
const {
  marketDataEnvelope,
} = require("../../../utils/goldAnalysis/marketDataEnvelope");
const {
  cotRowsFromText,
  easternReleaseAt,
  parseGldIssuer,
  parseIauIssuer,
  parseSgeRows,
} = require("../../../utils/goldAnalysis/providers");
const {
  _internals,
  buildGoldAnalysis,
  closedBars,
} = require("../../../utils/goldAnalysis/quantAnalysis");
const { GoldAnalysisRuntime } = require("../../../utils/goldAnalysis/runtime");
const {
  buildShadowResearch,
  publicShadowResearch,
} = require("../../../utils/goldAnalysis/shadowResearch");
const {
  prepareGoldResultForModel,
  renderGoldMonitoringReport,
} = require("../../../utils/agents/aibitat/plugins/gold-market/interpretation");
const {
  goldMarketAgent,
} = require("../../../utils/agents/aibitat/plugins/gold-market");

const NOW = Date.parse("2026-07-30T12:00:00.000Z");

function bars({
  count,
  intervalMs,
  start = NOW - count * intervalMs,
  interval,
  symbol = "XAU/USD",
  base = 2_300,
  volume = null,
}) {
  return Array.from({ length: count }, (_, index) => {
    const open = base + index * 0.8;
    return {
      source: "twelve_data",
      providerVersion: "fixture-v1",
      symbol,
      interval,
      openTimeMs: start + index * intervalMs,
      closeTimeMs: start + (index + 1) * intervalMs,
      open,
      high: open + 2,
      low: open - 1,
      close: open + 1,
      volume,
      backfilled: true,
      forming: false,
    };
  });
}

function fredSeries(value, delta = 0.1) {
  return {
    seriesId: "fixture",
    rows: Array.from({ length: 70 }, (_, index) => ({
      observedAtMs: NOW - (70 - index) * 86_400_000,
      value: value + index * delta,
    })),
  };
}

function cotRows(count = 160) {
  return Array.from({ length: count }, (_, index) => ({
    reportDate: new Date(NOW - (count - index) * 7 * 86_400_000)
      .toISOString()
      .slice(0, 10),
    reportAtMs: NOW - (count - index) * 7 * 86_400_000,
    availableAtMs: NOW - (count - index) * 7 * 86_400_000 + 3 * 86_400_000,
    openInterest: 500_000,
    producerLong: 50_000,
    producerShort: 150_000,
    managedLong: 200_000 + index * 100,
    managedShort: 80_000,
    managedSpreading: 30_000,
    managedNetRatio: (120_000 + index * 100) / 500_000,
    commercialNetRatio: -0.2,
    managedLongRatio: (200_000 + index * 100) / 500_000,
    managedShortRatio: 0.16,
    spreadingRatio: 0.06,
  }));
}

function fixtureData() {
  const xau5m = bars({
    count: 9_000,
    intervalMs: 300_000,
    interval: "5min",
  });
  const xauDaily = bars({
    count: 400,
    intervalMs: 86_400_000,
    interval: "1day",
    base: 1_900,
  });
  const xagDaily = bars({
    count: 400,
    intervalMs: 86_400_000,
    interval: "1day",
    symbol: "XAG/USD",
    base: 24,
  });
  return {
    collectedAtMs: NOW,
    xau5m: { status: "available", bars: xau5m },
    xauDaily: { status: "available", bars: xauDaily },
    xagDaily: { status: "available", bars: xagDaily },
    gold: {
      status: "available",
      price: xau5m.at(-1).close,
      observedAtMs: xau5m.at(-1).closeTimeMs,
    },
    fred: {
      status: "available",
      series: {
        dxy: fredSeries(100, 0.02),
        realYield10y: fredSeries(1.8, 0.002),
        nominal10y: fredSeries(4, 0.002),
        nominal2y: fredSeries(3.8, 0.001),
        breakeven10y: fredSeries(2.2, 0.001),
        vix: fredSeries(16, 0.01),
        gvz: fredSeries(18, 0.01),
        oilWti: fredSeries(80, 0.02),
      },
    },
    cot: { status: "available", rows: cotRows() },
    etf: {
      status: "available",
      receivedAtMs: NOW,
      gld: { nav: 210, tonnesInTrust: 820 },
      iau: { nav: 45, tonnesInTrust: 400, premiumDiscountPercent: 0.02 },
    },
    sge: {
      status: "available",
      rows: [{ date: "20260730", session: "pm", priceCnyPerGram: 560 }],
    },
    usdCny: {
      status: "available",
      rate: 7.2,
      observedAtMs: NOW - 86_400_000,
    },
    sourceStatuses: {
      twelve_data: "available",
      gold_api: "available",
      fred: "available",
      cftc: "available",
      etf_issuers: "available",
      sge: "available",
      usd_cny: "available",
    },
  };
}

function attachShadow(result) {
  const shadow = buildShadowResearch({
    datasetSha256: result.provenance.datasetManifestSha256,
    timeframes: result.timeframes,
    volatilityRisk: result.volatilityRisk,
    now: NOW,
  });
  return { ...result, shadowResearch: publicShadowResearch(shadow) };
}

describe("GQSS gold market analysis", () => {
  it("registers exactly 65 versioned factors and a zero-argument tool", () => {
    expect(FACTOR_REGISTRY.factors).toHaveLength(65);
    expect(
      FACTOR_REGISTRY.factors.every(
        (factor) =>
          factor.formula &&
          factor.sources.length &&
          factor.frequency &&
          Number.isFinite(factor.maximumUsableDelayMs) &&
          factor.missingStrategy &&
          factor.modelEligibility
      )
    ).toBe(true);
    expect(FACTOR_REGISTRY.factors.map((factor) => factor.name)).toEqual(
      expect.arrayContaining([
        "ema_12_26",
        "atr_14",
        "adx_14",
        "bollinger_20_2",
      ])
    );
    expect(FACTOR_REGISTRY_SHA256).toMatch(/^[a-f0-9]{64}$/);
    const captured = [];
    goldMarketAgent.plugin[0].plugin().setup({
      function: (definition) => captured.push(definition),
    });
    expect(captured[0]).toMatchObject({
      name: "gold_market_analysis",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      modelResultMaxChars: 20_000,
    });
    expect(typeof captured[0].validatedContinuation).toBe("function");
  });

  it("uses a conservative CFTC release calendar and preserves positioning ratios", () => {
    const fields = Array(20).fill("0");
    fields[0] = "GOLD - COMMODITY EXCHANGE INC.";
    fields[2] = "2026-07-28";
    fields[3] = "088691";
    fields[7] = "500000";
    fields[8] = "50000";
    fields[9] = "150000";
    fields[13] = "200000";
    fields[14] = "80000";
    fields[15] = "30000";
    const parsed = cotRowsFromText(fields.join(","));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].managedNetRatio).toBeCloseTo(0.24, 10);
    expect(parsed[0].commercialNetRatio).toBeCloseTo(-0.2, 10);
    expect(parsed[0].spreadingRatio).toBeCloseTo(0.06, 10);
    expect(parsed[0].availableAtMs).toBe(easternReleaseAt("2026-07-28"));
    expect(new Date(parsed[0].availableAtMs).getUTCDay()).toBe(5);
    expect(parsed[0].availabilityQuality).toBe("estimated");

    const shutdown = resolveCotRelease("2025-09-30");
    expect(new Date(shutdown.availableAtMs).toISOString()).toBe(
      "2025-11-19T20:30:00.000Z"
    );
    expect(shutdown.availabilityQuality).toBe("exact");
    expect(shutdown.availabilityEstimated).toBe(false);

    const holidaySchedule = resolveCotRelease("2026-06-16");
    expect(new Date(holidaySchedule.availableAtMs).toISOString()).toBe(
      "2026-06-22T19:30:00.000Z"
    );
    expect(holidaySchedule.availabilityQuality).toBe("official_schedule");
    expect(holidaySchedule.availabilityEstimated).toBe(true);

    const mondayFallback = resolveCotRelease("2027-01-04");
    expect(new Date(mondayFallback.availableAtMs).toISOString()).toBe(
      "2027-01-08T20:30:00.000Z"
    );
    expect(mondayFallback.availabilityQuality).toBe("estimated");
  });

  it("repairs persisted CFTC release clocks without duplicating observations", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE normalized_observations (
        source TEXT NOT NULL,
        event_id TEXT PRIMARY KEY,
        observed_at_ms INTEGER NOT NULL,
        available_at_ms INTEGER NOT NULL,
        envelope_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      )
    `);
    const observedAtMs = Date.parse("2025-09-30T00:00:00.000Z");
    const oldAvailableAtMs = Date.parse("2025-10-03T19:30:00.000Z");
    const envelope = marketDataEnvelope({
      source: "cftc",
      market: "comex_gold",
      eventType: "cot_disaggregated",
      observedAtMs,
      receivedAtMs: NOW,
      availableAtMs: oldAvailableAtMs,
      availabilityQuality: "exact",
      revisionStatus: "not_revisable",
      backfilled: true,
      providerVersion: "cftc-disaggregated-v1",
    });
    db.prepare(
      `INSERT INTO normalized_observations (
         source, event_id, observed_at_ms, available_at_ms,
         envelope_json, payload_json, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "cftc",
      envelope.eventId,
      observedAtMs,
      oldAvailableAtMs,
      JSON.stringify(envelope),
      JSON.stringify({ openInterest: 500_000 }),
      NOW
    );

    const plan = planCftcAvailabilityRepairs(db);
    expect(plan).toMatchObject({
      scanned: 1,
      changed: 1,
      timestampShifted: 1,
      futureLeakCorrections: 1,
      exact: 1,
    });
    expect(plan.candidates[0].timestampShiftMs).toBeGreaterThan(0);
    expect(applyCftcAvailabilityRepairs(db, plan.candidates)).toEqual({
      applied: 1,
      merged: 0,
    });
    expect(planCftcAvailabilityRepairs(db).changed).toBe(0);
    const repaired = db.prepare(`SELECT * FROM normalized_observations`).get();
    const repairedEnvelope = JSON.parse(repaired.envelope_json);
    expect(repaired.available_at_ms).toBe(
      Date.parse("2025-11-19T20:30:00.000Z")
    );
    expect(repairedEnvelope.availabilityQuality).toBe("exact");
    expect(repairedEnvelope.providerVersion).toBe("cftc-disaggregated-v2");
    expect(repaired.event_id).toBe(repairedEnvelope.eventId);
    db.close();
  });

  it("excludes forming candles and never fabricates centralized XAU volume", () => {
    const data = fixtureData();
    data.xau5m.bars.push({
      ...data.xau5m.bars.at(-1),
      openTimeMs: NOW,
      closeTimeMs: NOW + 300_000,
      close: 99_999,
      forming: true,
    });
    expect(closedBars(data.xau5m.bars, NOW).at(-1).close).not.toBe(99_999);
    const result = buildGoldAnalysis({ data, now: NOW });
    expect(result.analysisStatus).toBe("complete");
    expect(result.currentMarket.price).not.toBe(99_999);
    for (const timeframe of Object.values(result.timeframes)) {
      expect(timeframe.volumeAvailability).toBe(
        "unavailable_no_central_xau_volume"
      );
      expect(timeframe.indicators).not.toHaveProperty("obv");
      expect(timeframe.indicators).not.toHaveProperty("cmf");
      expect(timeframe.indicators).not.toHaveProperty("vpin");
    }
    expect(result.factorFamilies.liquidityAndOrderFlow).toMatchObject({
      status: "unavailable",
      state: "insufficient",
    });
  });

  it("calculates technical and realized-volatility families deterministically", () => {
    const data = fixtureData();
    const result = buildGoldAnalysis({ data, now: NOW });
    expect(
      result.timeframes["1h"].indicators.movingAverages.sma20
    ).toBeGreaterThan(0);
    expect(result.timeframes["4h"].indicators.rsi14).toBeGreaterThanOrEqual(0);
    expect(result.timeframes["1d"].indicators.macd.histogram).not.toBeNull();
    expect(result.timeframes["1w"].indicators.parkinson20).toBeGreaterThan(0);
    expect(result.volatilityRisk).toMatchObject({
      status: "complete",
      observations: expect.any(Number),
    });
    expect(result.volatilityRisk.dailyRealizedVariance).toBeGreaterThanOrEqual(
      result.volatilityRisk.bipowerVariation
        ? 0
        : result.volatilityRisk.dailyRealizedVariance
    );
    expect(result.positioning.managedMoney.netRatio).toBeCloseTo(
      cotRows().at(-1).managedNetRatio,
      6
    );
    expect(result.chinaMarket.convertedUsdPerOunce).toBeCloseTo(
      (560 * 31.1034768) / 7.2,
      5
    );
  });

  it("renders a deterministic, traceable monitoring report without a model", () => {
    const result = attachShadow(
      buildGoldAnalysis({ data: fixtureData(), now: NOW })
    );
    const report = renderGoldMonitoringReport({ result });
    expect(report).toContain("字段：`currentMarket`");
    expect(report).toContain("字段：`timeframes.1h`");
    expect(report).toContain("字段：`macroContext.series.dxy`");
    expect(report).toContain(result.provenance.resultSha256);
    expect(report).not.toMatch(/建议(?:买入|卖出|做多|做空)/);
    expect(report).not.toMatch(/目标价|上涨概率|下跌概率|下一步将/);
    const projection = prepareGoldResultForModel(JSON.stringify(result));
    expect(projection.length).toBeLessThanOrEqual(20_000);
    expect(JSON.parse(projection).shadowResearch).not.toHaveProperty(
      "probabilities"
    );
  });

  it("returns partial evidence when Twelve Data is not configured", async () => {
    const store = {
      latestSnapshot: () => null,
      setSourceHealth: jest.fn(),
      saveObservations: jest.fn(() => true),
      saveSnapshot: jest.fn(() => true),
      saveShadowResearch: jest.fn(() => true),
      recentBars: jest.fn(() => []),
      stats: () => ({ bytes: 1 }),
      close: jest.fn(),
    };
    const notConfigured = Object.assign(new Error("missing"), {
      code: "provider_not_configured",
    });
    const runtime = new GoldAnalysisRuntime({
      store,
      now: () => NOW,
      providers: {
        twelve: jest.fn(async () => {
          throw notConfigured;
        }),
        gold: jest.fn(async () => ({
          status: "available",
          price: 2_400,
          observedAtMs: NOW,
        })),
        fred: jest.fn(async () => ({
          status: "available",
          series: { dxy: fredSeries(100) },
        })),
        cot: jest.fn(async () => ({ status: "available", rows: cotRows() })),
        etf: jest.fn(async () => null),
        sge: jest.fn(async () => null),
        usdCny: jest.fn(async () => null),
      },
    });
    const result = await runtime.analyze({ force: true });
    expect(result.analysisStatus).toBe("partial");
    expect(result.ok).toBe(true);
    expect(result.currentMarket).toMatchObject({
      status: "degraded",
      primarySource: "gold_api",
      price: 2_400,
    });
    expect(result.partialFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "twelve_data",
          errorCode: "provider_not_configured",
        }),
      ])
    );
    expect(result.shadowResearch.horizons["1d"]).toMatchObject({
      abstained: true,
    });
  });

  it("parses official SGE rows and enforces point-in-time envelopes", () => {
    expect(parseSgeRows("2026-07-30 SHAU 午盘 2 560.18")).toEqual([
      {
        date: "20260730",
        session: "pm",
        priceCnyPerGram: 560.18,
      },
    ]);
    expect(() =>
      marketDataEnvelope({
        source: "fixture",
        market: "xau_usd_spot",
        eventType: "price",
        observedAtMs: NOW,
        receivedAtMs: NOW,
        availableAtMs: NOW + 1,
        availabilityQuality: "received",
      })
    ).toThrow("gold_market_data_received_before_available");
  });

  it("uses issuer structured fields and never mistakes dates or basket NAV for NAV", () => {
    const gld = parseGldIssuer(`
      <table>
        <tr><th class="label">NAV Per Basket</th><td class="data">$36,704,037.29</td></tr>
        <tr><th class="label">NAV <span>NAV definition</span></th><td class="data">$367.04</td></tr>
        <tr><th class="label">Shares Outstanding</th><td class="data">353.60 M</td></tr>
        <tr><th class="label">Assets Under Management</th><td class="data">$129,785.48 M</td></tr>
        <tr><th class="label">LBMA Gold Price PM</th><td class="data">$4,000.85</td></tr>
      </table>
    `);
    expect(gld).toMatchObject({
      nav: 367.04,
      sharesOutstanding: 353_600_000,
      assetsUnderManagement: 129_785_480_000,
      tonnesInTrust: null,
    });
    expect(gld).not.toHaveProperty("lbmaGoldPrice");

    const component = JSON.stringify({
      dataPointsByNameMap: {
        closingPrice: { name: "closingPrice", formattedValue: "76.04" },
        tonnes: { name: "tonnes", formattedValue: "461.88" },
        ounces: { name: "ounces", formattedValue: "14,849,859.50" },
        consolidatedVolume: {
          name: "consolidatedVolume",
          formattedValue: "4,203,184.00",
        },
      },
    }).replace(/"/g, "&quot;");
    const iau = parseIauIssuer(`
      <script type="application/ld+json">
        {"additionalProperty":[{"name":"NAV as of","value":"75.23"}]}
      </script>
      <walrus-render-on-client componentprops="${component}"></walrus-render-on-client>
    `);
    expect(iau).toMatchObject({
      nav: 75.23,
      closingPrice: 76.04,
      tonnesInTrust: 461.88,
      ouncesInTrust: 14_849_859.5,
      dailyVolume: 4_203_184,
    });
  });

  it("keeps volatility primitives finite on zero-return intervals", () => {
    const flat = bars({
      count: 100,
      intervalMs: 3_600_000,
      interval: "1h",
      base: 2_300,
    }).map((bar) => ({
      ...bar,
      open: 2_300,
      high: 2_301,
      low: 2_299,
      close: 2_300,
    }));
    const volatility = _internals.dailyRealizedVolatility(flat);
    expect(volatility.dailyRealizedVariance).toBe(0);
    expect(volatility.downsideSemivariance).toBe(0);
    expect(volatility.jumpIntensity).toBe(0);
  });
});
