/* eslint-env jest */

process.env.NODE_ENV = "test";

const {
  cryptoMarketAgent,
  executeCryptoMarketSnapshot,
  executeCryptoPrice,
  prepareCryptoMarketResultForModel,
} = require("../../../utils/agents/aibitat/plugins/crypto-market");
const {
  clearWeatherCaches,
  executeWeatherCurrent,
  executeWeatherForecast,
  normalizeLocation,
  weatherAgent,
} = require("../../../utils/agents/aibitat/plugins/weather");
const {
  executeGlobalCommodityQuote,
  executeGlobalForexRate,
  executeGlobalFundQuote,
  executeGlobalIndexQuote,
  executeGlobalStockQuote,
  globalMarketAgent,
  normalizeCnSymbol,
  normalizeHkSymbol,
  parseStooqCsv,
} = require("../../../utils/agents/aibitat/plugins/global-market");
const {
  goldMarketAgent,
} = require("../../../utils/agents/aibitat/plugins/gold-market");
const {
  fetchJson,
} = require("../../../utils/agents/aibitat/plugins/market-data/lib");

function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest
      .fn()
      .mockResolvedValue(
        typeof body === "string" ? body : JSON.stringify(body)
      ),
  };
}

function collectDefinitions(agent) {
  const definitions = [];
  const aibitat = {
    function: jest.fn((definition) => definitions.push(definition)),
    handlerProps: { log: jest.fn() },
    requestToolApproval: jest.fn(),
  };
  for (const child of agent.plugin) child.plugin().setup(aibitat);
  return { aibitat, definitions };
}

function marketCandlesFor(range, count = 200) {
  const intervalMs = {
    "1h": 60 * 60 * 1_000,
    "4h": 4 * 60 * 60 * 1_000,
    "1d": 24 * 60 * 60 * 1_000,
    "1w": 7 * 24 * 60 * 60 * 1_000,
  }[range];
  const end = Date.now() - intervalMs * 2;
  const start = end - intervalMs * (count - 1);
  return Array.from({ length: count }, (_, index) => {
    const close = 60_000 + index * 25;
    return {
      ts: start + intervalMs * index,
      open: String(close - 10),
      high: String(close + 20),
      low: String(close - 20),
      close: String(close),
      volume: String(1_000 + index * 3),
    };
  });
}

const unavailableSupportingEvidence = jest.fn().mockResolvedValue({
  formulaVersion: "crypto-market-evidence-v1",
  status: "unavailable",
  spotMicrostructure: { status: "unavailable" },
  derivatives: { status: "unavailable", reason: "test_fixture" },
});

const gateTicker = {
  success: true,
  data: [
    {
      last: "65000.5",
      base_volume: "100",
      quote_volume: "6500050",
      high_24h: "66000",
      low_24h: "64000",
      change_percentage: "1.25",
      highest_bid: "65000",
      lowest_ask: "65001",
    },
  ],
};

describe("default market data agent tools", () => {
  beforeEach(() => clearWeatherCaches());

  it("registers all ten read-only functions with strict JSON schemas", () => {
    const groups = [
      cryptoMarketAgent,
      weatherAgent,
      globalMarketAgent,
      goldMarketAgent,
    ];
    const expectedNames = [
      "crypto_price",
      "crypto_market_snapshot",
      "weather_current",
      "weather_forecast",
      "global_forex_rate",
      "global_index_quote",
      "global_stock_quote",
      "global_commodity_quote",
      "global_fund_quote",
      "gold_market_analysis",
    ];
    const definitions = groups.flatMap(
      (group) => collectDefinitions(group).definitions
    );

    expect(definitions.map(({ name }) => name)).toEqual(expectedNames);
    for (const definition of definitions) {
      expect(definition.parameters).toMatchObject({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
      });
      expect(typeof definition.handler).toBe("function");
    }
    const snapshotDefinition = definitions.find(
      ({ name }) => name === "crypto_market_snapshot"
    );
    expect(snapshotDefinition.parameters.properties.mode.enum).toEqual([
      "simple",
      "analysis",
    ]);
    expect(snapshotDefinition.continuationTask).toBe("crypto_market_analysis");
    expect(snapshotDefinition.continuationInstruction).toContain(
      "monitoring-only"
    );
    expect(snapshotDefinition.continuationInstruction).toContain(
      "Never provide a future direction"
    );
    expect(snapshotDefinition.modelResultMaxChars).toBe(20_000);
    expect(typeof snapshotDefinition.prepareResultForModel).toBe("function");
    expect(typeof snapshotDefinition.validatedContinuation).toBe("function");
  });

  it("returns a Gate price and a dual snapshot when Binance partially fails", async () => {
    const gateClient = {
      getSpotTickerRaw: jest.fn().mockResolvedValue(gateTicker),
    };
    const price = await executeCryptoPrice(
      { symbol: "btc", exchange: "gate" },
      { gateClient }
    );
    expect(price).toMatchObject({
      tool: "crypto_price",
      symbol: "BTC",
      quote: "USDT",
      price: "65000.5",
      provider: "gate",
      cache_hit: false,
    });

    const snapshot = await executeCryptoMarketSnapshot(
      { symbol: "BTC", exchange_mode: "dual" },
      {
        gateClient,
        fetchImpl: jest.fn().mockRejectedValue(new Error("offline")),
      }
    );
    expect(snapshot.ok).toBe(true);
    expect(snapshot.sources.gate).toMatchObject({ ok: true, spread: "1" });
    expect(snapshot.sources.binance).toEqual({
      ok: false,
      exchange: "binance",
      error: "provider_unavailable",
    });
    expect(snapshot).not.toHaveProperty("mode");
  });

  it("keeps explicit simple mode compatible and returns four-period quant analysis", async () => {
    const gateClient = {
      getSpotTickerRaw: jest.fn().mockResolvedValue(gateTicker),
    };
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        lastPrice: "64999.5",
        volume: "120",
        quoteVolume: "7799940",
        highPrice: "66010",
        lowPrice: "63990",
        priceChangePercent: "1.20",
        bidPrice: "64999",
        askPrice: "65000",
      })
    );
    const marketCandles = jest.fn(async ({ range }) => ({
      success: true,
      cacheHit: false,
      candles: marketCandlesFor(range),
    }));

    const implicitSimple = await executeCryptoMarketSnapshot(
      { symbol: "BTC", exchange_mode: "dual" },
      { gateClient, fetchImpl }
    );
    const explicitSimple = await executeCryptoMarketSnapshot(
      { symbol: "BTC", exchange_mode: "dual", mode: "simple" },
      { gateClient, fetchImpl }
    );
    expect({ ...explicitSimple, timestamp: implicitSimple.timestamp }).toEqual(
      implicitSimple
    );

    const analysis = await executeCryptoMarketSnapshot(
      { symbol: "BTC", exchange_mode: "dual", mode: "analysis" },
      {
        gateClient,
        fetchImpl,
        marketCandles,
        publicMarketSupportingEvidence: unavailableSupportingEvidence,
      }
    );
    expect(analysis).toMatchObject({
      tool: "crypto_market_snapshot",
      ok: true,
      mode: "analysis",
      formulaVersion: "crypto-quant-v2",
      analysisStatus: "complete",
    });
    expect(marketCandles).toHaveBeenCalledTimes(4);
    expect(
      marketCandles.mock.calls.map(([input]) => ({
        range: input.range,
        includeTicker: input.includeTicker,
        limit: input.limit,
      }))
    ).toEqual([
      { range: "1h", includeTicker: false, limit: 500 },
      { range: "4h", includeTicker: false, limit: 500 },
      { range: "1d", includeTicker: false, limit: 500 },
      { range: "1w", includeTicker: false, limit: 500 },
    ]);
    expect(Object.keys(analysis.timeframes)).toEqual(["1h", "4h", "1d", "1w"]);
    for (const timeframe of Object.values(analysis.timeframes)) {
      expect(timeframe.barsCalculated).toBe(200);
      expect(timeframe.candles).toHaveLength(120);
      expect(timeframe.levels.fibonacci).toMatchObject({
        status: "available",
        lookback: 100,
        direction: "upswing",
      });
    }
    expect(analysis.scenarios.map(({ id }) => id)).toEqual([
      "bullish_breakout",
      "bearish_breakdown",
      "range_continuation",
    ]);
    for (const timeframe of Object.values(analysis.timeframes)) {
      expect(timeframe.dataQuality.calculationInput).toMatchObject({
        closedCandlesUsed: 200,
        formingCandleExcluded: false,
        digestAlgorithm: "sha256",
        closedCandlesSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    }
    expect(analysis.scenarios[0]).toMatchObject({
      triggerMet: expect.any(Boolean),
      confirmed: expect.any(Boolean),
      confirmationChecks: expect.arrayContaining([
        expect.objectContaining({
          id: "at_least_two_bullish_timeframes",
          met: true,
          actual: 4,
          threshold: 2,
          sourcePath: "confluence.bullish.length",
        }),
      ]),
      targets: expect.arrayContaining([
        expect.objectContaining({
          basis: expect.stringContaining("daily_"),
          sourcePath: expect.stringContaining("timeframes.1d"),
        }),
      ]),
    });
    const projected = prepareCryptoMarketResultForModel(
      JSON.stringify({ ...analysis, latency_ms: 123 }),
      {
        runId: "run-quant",
        stored: true,
        resultSize: Buffer.byteLength(JSON.stringify(analysis)),
      }
    );
    const modelView = JSON.parse(projected);
    expect(Object.keys(modelView.timeframes)).toEqual(["1h", "4h", "1d", "1w"]);
    expect(modelView.timeframes["1h"]).not.toHaveProperty("candles");
    expect(modelView.timeframes["1h"].indicators.ma.relations).toMatchObject({
      ma5VsMa10: "above",
      ma10VsMa30: "above",
      alignment: "bullish",
      closeVsMa5: "above",
    });
    expect(
      modelView.timeframes["1h"].indicators.macd.relations.histogramSign
    ).toBe("zero");
    expect(
      modelView.interpretationContract.rules.some((rule) =>
        rule.includes("only confirmedByClosedData=true confirms one")
      )
    ).toBe(true);
    expect(modelView.interpretationContract.requiredCoverage).toEqual({
      timeframeIds: ["1h", "4h", "1d", "1w"],
      monitoringSignalIds: [
        "upper_breakout_condition",
        "lower_breakdown_condition",
        "range_condition",
      ],
      includeEveryObservedCondition: true,
      distinguishObservedFromClosedDataConfirmation: true,
    });
    expect(modelView).not.toHaveProperty("scenarios");
    expect(modelView).not.toHaveProperty("confluence");
    expect(modelView.monitoringSignals).toHaveLength(3);
    expect(modelView.monitoringSignals[0]).not.toHaveProperty("targets");
    expect(modelView.provenance.fullToolRunId).toBe("run-quant");
    expect(Buffer.byteLength(projected)).toBeLessThanOrEqual(16_000);
    expect(Buffer.byteLength(JSON.stringify(analysis))).toBeLessThanOrEqual(
      100 * 1024
    );
  });

  it("does not swallow invalid exchange mode in analysis requests", async () => {
    await expect(
      executeCryptoMarketSnapshot({
        symbol: "BTC",
        mode: "analysis",
        exchange_mode: "invalid",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps Gate quant analysis available when the Binance cross-check fails", async () => {
    const gateClient = {
      getSpotTickerRaw: jest.fn().mockResolvedValue(gateTicker),
    };
    const marketCandles = jest.fn(async ({ range }) => ({
      success: true,
      candles: marketCandlesFor(range),
    }));
    const result = await executeCryptoMarketSnapshot(
      { symbol: "BTC", mode: "analysis", exchange_mode: "dual" },
      {
        gateClient,
        fetchImpl: jest.fn().mockRejectedValue(new Error("offline")),
        marketCandles,
        publicMarketSupportingEvidence: unavailableSupportingEvidence,
      }
    );

    expect(result.analysisStatus).toBe("complete");
    expect(result.snapshot.sources.binance).toMatchObject({
      ok: false,
      error: "provider_unavailable",
    });
    expect(result.partialFailures).toContainEqual({
      source: "spot_ticker_crosscheck",
      exchange: "binance",
      error: "provider_unavailable",
    });
  });

  it("adds the latest auditable forecasting snapshot without changing simple mode", async () => {
    const gateClient = {
      getSpotTickerRaw: jest.fn().mockResolvedValue(gateTicker),
    };
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        lastPrice: "64999.5",
        volume: "120",
        quoteVolume: "7799940",
        highPrice: "66010",
        lowPrice: "63990",
        priceChangePercent: "1.20",
        bidPrice: "64999",
        askPrice: "65000",
      })
    );
    const forecastingProvider = jest.fn().mockResolvedValue({
      status: "shadow",
      modelVersion: "crypto-forecast-v1",
      featureSchemaVersion: "crypto-forecast-features-v1",
      asOf: "2026-07-29T00:00:00.000Z",
      datasetManifestSha256: "a".repeat(64),
      modelArtifactSha256: "b".repeat(64),
      horizons: {
        "4h": {
          probabilities: { up: 0.55, range: 0.2, down: 0.25 },
          predictedState: null,
          abstained: true,
          abstainReasons: ["model_shadow"],
          evidenceCoverage: 1,
          dataFreshnessMs: 30_000,
          drivers: [],
        },
      },
    });
    const result = await executeCryptoMarketSnapshot(
      { symbol: "BTC", mode: "analysis" },
      {
        gateClient,
        fetchImpl,
        marketCandles: jest.fn(async ({ range }) => ({
          success: true,
          candles: marketCandlesFor(range),
        })),
        publicMarketSupportingEvidence: unavailableSupportingEvidence,
        forecastingProvider,
      }
    );

    expect(forecastingProvider).toHaveBeenCalledWith({
      symbol: "BTC",
      quote: "USDT",
    });
    expect(result.forecasting).toMatchObject({
      status: "shadow",
      modelVersion: "crypto-forecast-v1",
      horizons: {
        "4h": {
          abstained: true,
          abstainReasons: ["monitoring_only_policy", "model_shadow"],
        },
      },
    });
    expect(result.forecasting.analysisPolicy).toMatchObject({
      mode: "monitoring_only",
      directDirectionalPrediction: false,
    });
    expect(result.forecasting.horizons["4h"]).not.toHaveProperty(
      "predictedState"
    );
    expect(result.forecasting.horizons["4h"]).not.toHaveProperty(
      "probabilities"
    );
    expect(JSON.parse(prepareCryptoMarketResultForModel(result))).toMatchObject(
      {
        forecasting: {
          status: "shadow",
          horizons: {
            "4h": {
              status: "shadow",
              abstained: true,
              abstainReasons: ["monitoring_only_policy", "model_shadow"],
            },
          },
        },
      }
    );
    expect(
      JSON.parse(prepareCryptoMarketResultForModel(result)).forecasting
        .horizons["4h"]
    ).not.toHaveProperty("probabilities");
  });

  it("uses persisted Binance minute evidence without promoting it to a model input", async () => {
    const forecastingMicrostructureProvider = jest.fn().mockResolvedValue({
      formulaVersion: "crypto-microstructure-evidence-v1",
      status: "available",
      source: "binance_public_ws_minute_aggregation",
      role: "supporting_only",
      modelInputEligible: false,
      tradeFlow: {
        windows: {
          "5m": { status: "available", takerBuyRatio: 0.6 },
          "15m": { status: "available", takerBuyRatio: 0.58 },
        },
      },
      orderBook: {
        synchronized: true,
        windows: {
          "5m": {
            status: "available",
            depth: {
              "25bps": {
                imbalanceMedian: 0.2,
                positiveSampleRatio: 0.8,
                negativeSampleRatio: 0.2,
              },
            },
          },
        },
      },
    });
    const result = await executeCryptoMarketSnapshot(
      { symbol: "BTC", mode: "analysis" },
      {
        gateClient: {
          getSpotTickerRaw: jest.fn().mockResolvedValue(gateTicker),
        },
        fetchImpl: jest.fn().mockResolvedValue(
          response({
            lastPrice: "64999.5",
            volume: "120",
            quoteVolume: "7799940",
            highPrice: "66010",
            lowPrice: "63990",
            priceChangePercent: "1.20",
            bidPrice: "64999",
            askPrice: "65000",
          })
        ),
        marketCandles: jest.fn(async ({ range }) => ({
          success: true,
          candles: marketCandlesFor(range),
        })),
        publicMarketSupportingEvidence: unavailableSupportingEvidence,
        forecastingMicrostructureProvider,
      }
    );
    expect(forecastingMicrostructureProvider).toHaveBeenCalledWith({
      symbol: "BTC",
      quote: "USDT",
    });
    expect(result.supportingEvidence.spotMicrostructure).toMatchObject({
      status: "available",
      source: "binance_public_ws_minute_aggregation",
      role: "supporting_only",
      modelInputEligible: false,
    });
    expect(result.supportingEvidence.status).toBe("partial");
  });

  it("adds aligned relative strength versus BTC for non-BTC assets", async () => {
    const gateClient = {
      getSpotTickerRaw: jest.fn().mockResolvedValue(gateTicker),
    };
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        lastPrice: "100",
        volume: "120",
        quoteVolume: "12000",
        highPrice: "105",
        lowPrice: "95",
        priceChangePercent: "1",
        bidPrice: "99.9",
        askPrice: "100.1",
      })
    );
    const candlesByRange = Object.fromEntries(
      ["1h", "4h", "1d", "1w"].map((range) => [range, marketCandlesFor(range)])
    );
    const marketCandles = jest.fn(async ({ pair, range }) => ({
      success: true,
      candles: candlesByRange[range].map((candle) => ({
        ...candle,
        close:
          pair === "ETH_USDT"
            ? String(Number(candle.close) * 1.01)
            : candle.close,
      })),
    }));

    const result = await executeCryptoMarketSnapshot(
      { symbol: "ETH", mode: "analysis" },
      {
        gateClient,
        fetchImpl,
        marketCandles,
        publicMarketSupportingEvidence: unavailableSupportingEvidence,
      }
    );

    expect(marketCandles).toHaveBeenCalledTimes(8);
    expect(result.timeframes["1d"].indicators.relativeStrength).toMatchObject({
      benchmark: "BTC_USDT",
      alignedBars: 200,
      status: "available",
      returnDifferencePct: {
        bars5: expect.any(Number),
        bars20: expect.any(Number),
      },
      returnCorrelation30: expect.any(Number),
    });
  });

  it("returns partial analysis for isolated timeframe failures", async () => {
    const gateClient = {
      getSpotTickerRaw: jest.fn().mockResolvedValue(gateTicker),
    };
    const marketCandles = jest.fn(async ({ range }) => {
      if (range !== "1d") {
        const error = new Error("timeout");
        error.code = "provider_timeout";
        throw error;
      }
      return {
        success: true,
        candles: marketCandlesFor(range),
      };
    });
    const result = await executeCryptoMarketSnapshot(
      { symbol: "BTC", mode: "analysis", exchange_mode: "gate" },
      {
        gateClient,
        fetchImpl: jest.fn().mockRejectedValue(new Error("offline")),
        marketCandles,
        publicMarketSupportingEvidence: unavailableSupportingEvidence,
      }
    );

    expect(result.analysisStatus).toBe("partial");
    expect(Object.keys(result.timeframes)).toEqual(["1d"]);
    expect(result.confluence.status).toBe("unavailable");
    expect(result.scenarios).toEqual([]);
    const candleFailures = result.partialFailures.filter(
      ({ source }) => source === "gate_candles"
    );
    expect(candleFailures).toHaveLength(3);
    expect(
      candleFailures.every(({ error }) => error === "provider_timeout")
    ).toBe(true);
  });

  it("uses the existing safe error when every candle period is unavailable", async () => {
    const gateClient = {
      getSpotTickerRaw: jest.fn().mockResolvedValue(gateTicker),
    };
    await expect(
      executeCryptoMarketSnapshot(
        { symbol: "BTC", mode: "analysis", exchange_mode: "gate" },
        {
          gateClient,
          fetchImpl: jest.fn().mockRejectedValue(new Error("offline")),
          marketCandles: jest.fn().mockRejectedValue(
            Object.assign(new Error("offline"), {
              code: "provider_unavailable",
            })
          ),
          publicMarketSupportingEvidence: unavailableSupportingEvidence,
        }
      )
    ).rejects.toMatchObject({
      code: "providers_unavailable",
      message: "Gate public candlestick data is unavailable.",
    });
  });

  it("normalizes weather locations and caches current conditions", async () => {
    expect(normalizeLocation("福建省")).toMatchObject({ query: "福州" });
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        response({ code: "200", location: [{ id: "101020100" }] })
      )
      .mockResolvedValueOnce(
        response({
          code: "200",
          now: {
            temp: "31",
            feelsLike: "35",
            text: "晴",
            obsTime: "2026-07-19T14:00+08:00",
          },
        })
      );

    const first = await executeWeatherCurrent(
      { location: "上海" },
      { apiKey: "test-qweather-key", fetchImpl }
    );
    const second = await executeWeatherCurrent(
      { location: "上海" },
      { apiKey: "test-qweather-key", fetchImpl }
    );
    expect(first).toMatchObject({
      tool: "weather_current",
      location_id: "101020100",
      temp: "31",
      source: "qweather_now",
      cache_hit: false,
    });
    expect(second.cache_hit).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("queries a QWeather forecast by GPS without a location lookup", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        code: "200",
        daily: [
          {
            fxDate: "2026-07-20",
            tempMax: "34",
            tempMin: "27",
            textDay: "多云",
          },
        ],
      })
    );
    const forecast = await executeWeatherForecast(
      { lat: 31.23, lon: 121.47, days: "3d" },
      { apiKey: "test-qweather-key", fetchImpl }
    );
    expect(forecast).toMatchObject({
      tool: "weather_forecast",
      location: "gps",
      days: "3d",
      source: "qweather_forecast",
      cache_hit: false,
    });
    expect(forecast.daily[0]).toMatchObject({
      date: "2026-07-20",
      temp_max: "34",
      temp_min: "27",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parses Stooq CSV and applies index, commodity, and fund aliases", async () => {
    const csv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\r\n^SPX,20260718,220000,6300,6350,6280,6340,123456\r\n";
    expect(parseStooqCsv(csv)).toMatchObject({
      open: "6300",
      price: "6340",
      change: "40",
      volume: "123456",
    });
    const dependencies = {
      fetchImpl: jest.fn().mockResolvedValue(response(csv)),
    };
    const [index, commodity, fund] = await Promise.all([
      executeGlobalIndexQuote({ symbol: "SP500" }, dependencies),
      executeGlobalCommodityQuote({ symbol: "黄金" }, dependencies),
      executeGlobalFundQuote({ symbol: "IVV" }, dependencies),
    ]);
    expect(index).toMatchObject({ mapped_symbol: "^spx", provider: "stooq" });
    expect(commodity).toMatchObject({
      mapped_symbol: "gc.f",
      provider: "stooq",
    });
    expect(fund).toMatchObject({ mapped_symbol: "ivv.us", provider: "stooq" });
  });

  it("uses fixed-domain fallbacks when the Stooq quote endpoint is unavailable", async () => {
    const indexFetch = jest
      .fn()
      .mockResolvedValueOnce(response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        response({
          error_code: 0,
          result: [
            {
              data: {
                name: "标普500指数",
                lastestpri: "7457.68",
                openpri: "7500",
                formpri: "7490",
                maxpri: "7520",
                minpri: "7430",
                limit: "-32.32",
                uppic: "-0.43%",
              },
            },
          ],
        })
      );
    const commodityFetch = jest
      .fn()
      .mockResolvedValueOnce(response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        response({
          symbol: "XAU",
          name: "Gold",
          price: 4019.3,
          updatedAt: "2026-07-19T09:35:23Z",
        })
      );
    const fundFetch = jest
      .fn()
      .mockResolvedValueOnce(response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        response({
          data: {
            companyName: "iShares Core S&P 500 ETF",
            primaryData: {
              lastSalePrice: "$746.72",
              netChange: "-7.70",
              percentageChange: "-1.02%",
              volume: "7,603,717",
              lastTradeTimestamp: "Jul 16, 2026",
            },
          },
        })
      );

    const [index, commodity, fund] = await Promise.all([
      executeGlobalIndexQuote(
        { symbol: "SP500" },
        {
          apiKey: "test-juhe-stock-key",
          fetchImpl: indexFetch,
        }
      ),
      executeGlobalCommodityQuote(
        { symbol: "GOLD" },
        { fetchImpl: commodityFetch }
      ),
      executeGlobalFundQuote({ symbol: "IVV" }, { fetchImpl: fundFetch }),
    ]);

    expect(index).toMatchObject({
      provider: "juhe",
      source: "juhe_stock_usa_index_fallback",
      price: "7457.68",
    });
    expect(commodity).toMatchObject({
      provider: "gold-api",
      source: "gold_api_public_price_fallback",
      price: "4019.3",
    });
    expect(fund).toMatchObject({
      provider: "nasdaq",
      source: "nasdaq_public_etf_quote_fallback",
      price: "746.72",
      volume: "7603717",
    });
  });

  it("normalizes stock codes and returns a Juhe stock quote", async () => {
    expect(normalizeCnSymbol("601009")).toBe("sh601009");
    expect(normalizeHkSymbol("700")).toBe("00700");
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        error_code: 0,
        result: [
          {
            data: {
              name: "Apple",
              lastestpri: "211.18",
              openpri: "210.00",
              formpri: "209.50",
              maxpri: "212.00",
              minpri: "208.00",
              limit: "1.68",
              uppic: "0.80%",
              traNumber: "1000",
              traAmount: "211180",
            },
          },
        ],
      })
    );
    const quote = await executeGlobalStockQuote(
      { market: "us", symbol: "AAPL" },
      { apiKey: "test-juhe-stock-key", fetchImpl }
    );
    expect(quote).toMatchObject({
      tool: "global_stock_quote",
      market: "us",
      symbol: "AAPL",
      price: "211.18",
      provider: "juhe",
      cache_hit: false,
    });
  });

  it("falls back from Juhe to Frankfurter for forex", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response({ error_code: 10012, reason: "limit" }))
      .mockResolvedValueOnce(
        response({ date: "2026-07-18", rates: { CNY: 7.18 } })
      );
    const rate = await executeGlobalForexRate(
      { base: "USD", quote: "CNY", provider: "auto" },
      { apiKey: "test-juhe-forex-key", fetchImpl }
    );
    expect(rate).toMatchObject({
      tool: "global_forex_rate",
      rate: "7.18",
      provider: "frankfurter",
      requested_provider: "auto",
      source: "frankfurter",
      fallback_from: "juhe",
      freshness: "daily_reference",
    });
  });

  it("returns a safe missing-key error and never requests approval", async () => {
    const previous = process.env.JUHE_STOCK_API_KEY_ENCRYPTED;
    delete process.env.JUHE_STOCK_API_KEY_ENCRYPTED;
    try {
      const { aibitat, definitions } = collectDefinitions(globalMarketAgent);
      const stockTool = definitions.find(
        ({ name }) => name === "global_stock_quote"
      );
      const result = JSON.parse(
        await stockTool.handler.call(stockTool, {
          market: "us",
          symbol: "AAPL",
        })
      );
      expect(result).toMatchObject({
        tool: "global_stock_quote",
        ok: false,
        error: "provider_not_configured",
        latency_ms: expect.any(Number),
      });
      expect(JSON.stringify(result)).not.toContain("JUHE_STOCK_API_KEY");
      expect(aibitat.requestToolApproval).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined)
        delete process.env.JUHE_STOCK_API_KEY_ENCRYPTED;
      else process.env.JUHE_STOCK_API_KEY_ENCRYPTED = previous;
    }
  });

  it("normalizes provider timeouts without exposing request details", async () => {
    const timeout = new Error("secret URL should not escape");
    timeout.name = "AbortError";
    await expect(
      fetchJson(
        "https://fixed.example.test",
        {},
        jest.fn().mockRejectedValue(timeout)
      )
    ).rejects.toMatchObject({
      code: "provider_timeout",
      message: "The data provider timed out.",
    });
  });
});
