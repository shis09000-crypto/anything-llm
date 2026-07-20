/* eslint-env jest */

process.env.NODE_ENV = "test";

const {
  cryptoMarketAgent,
  executeCryptoMarketSnapshot,
  executeCryptoPrice,
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

  it("registers all nine read-only functions with strict JSON schemas", () => {
    const groups = [cryptoMarketAgent, weatherAgent, globalMarketAgent];
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
