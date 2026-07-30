/* eslint-env jest */

process.env.NODE_ENV = "test";

const mockGetSpotCandlesticksRaw = jest.fn();
const mockGetSpotTickerRaw = jest.fn();

jest.mock("../../../utils/cryptoGate/publicMarketClient", () => ({
  GatePublicMarketClient: jest.fn().mockImplementation(() => ({
    getSpotCandlesticksRaw: mockGetSpotCandlesticksRaw,
    getSpotTickerRaw: mockGetSpotTickerRaw,
  })),
}));

const { marketCandles } = require("../../../utils/cryptoGate/marketCandles");

function gateCandles(count = 200, intervalSeconds = 7 * 24 * 60 * 60) {
  const start = 1_700_000_000;
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    return [
      String(start + intervalSeconds * index),
      String(1_000 + index),
      String(close),
      String(close + 1),
      String(close - 1),
      String(close - 0.5),
    ];
  });
}

describe("market candle analysis cache", () => {
  beforeEach(() => {
    mockGetSpotCandlesticksRaw.mockReset();
    mockGetSpotTickerRaw.mockReset();
  });

  it("requests 200 natural-week candles and marks the five-second cache hit", async () => {
    mockGetSpotCandlesticksRaw.mockResolvedValue({
      success: true,
      data: gateCandles(),
      rateLimit: null,
    });

    const first = await marketCandles({
      pair: "ADA_USDT",
      range: "1w",
      includeTicker: false,
    });
    const second = await marketCandles({
      pair: "ADA_USDT",
      range: "1w",
      includeTicker: false,
    });

    expect(mockGetSpotCandlesticksRaw).toHaveBeenCalledTimes(1);
    expect(mockGetSpotCandlesticksRaw).toHaveBeenCalledWith({
      currencyPair: "ADA_USDT",
      interval: "1w",
      limit: 200,
    });
    expect(mockGetSpotTickerRaw).not.toHaveBeenCalled();
    expect(first).toMatchObject({
      success: true,
      range: "1w",
      gateInterval: "1w",
      cacheHit: false,
    });
    expect(second.cacheHit).toBe(true);
    expect(second.candles).toHaveLength(200);
  });

  it("coalesces concurrent requests for the same pair and period", async () => {
    let resolveRequest;
    mockGetSpotCandlesticksRaw.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );

    const first = marketCandles({
      pair: "XRP_USDT",
      range: "4h",
      includeTicker: false,
    });
    const second = marketCandles({
      pair: "XRP_USDT",
      range: "4h",
      includeTicker: false,
    });
    expect(mockGetSpotCandlesticksRaw).toHaveBeenCalledTimes(1);

    resolveRequest({
      success: true,
      data: gateCandles(200, 4 * 60 * 60),
      rateLimit: null,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.candles).toHaveLength(200);
    expect(secondResult.candles).toEqual(firstResult.candles);
  });

  it("honors the bounded 500-bar analysis limit without changing defaults", async () => {
    mockGetSpotCandlesticksRaw.mockResolvedValue({
      success: true,
      data: gateCandles(500, 60 * 60),
      rateLimit: null,
    });

    const result = await marketCandles({
      pair: "BTC_USDT",
      range: "1h",
      includeTicker: false,
      limit: 500,
    });

    expect(mockGetSpotCandlesticksRaw).toHaveBeenCalledWith({
      currencyPair: "BTC_USDT",
      interval: "1h",
      limit: 500,
    });
    expect(result.candles).toHaveLength(500);
  });

  it("refetches when a larger analysis limit follows a smaller cached snapshot", async () => {
    mockGetSpotCandlesticksRaw
      .mockResolvedValueOnce({
        success: true,
        data: gateCandles(200, 60 * 60),
        rateLimit: null,
      })
      .mockResolvedValueOnce({
        success: true,
        data: gateCandles(500, 60 * 60),
        rateLimit: null,
      });

    await marketCandles({
      pair: "AVAX_USDT",
      range: "1h",
      includeTicker: false,
    });
    const analysis = await marketCandles({
      pair: "AVAX_USDT",
      range: "1h",
      includeTicker: false,
      limit: 500,
    });

    expect(mockGetSpotCandlesticksRaw).toHaveBeenCalledTimes(2);
    expect(analysis.cacheHit).toBe(false);
    expect(analysis.candles).toHaveLength(500);
  });

  it("does not let a candle-only analysis cache suppress a later ticker request", async () => {
    mockGetSpotCandlesticksRaw.mockResolvedValue({
      success: true,
      data: gateCandles(200, 60 * 60),
      rateLimit: null,
    });
    mockGetSpotTickerRaw.mockResolvedValue({
      success: true,
      data: [{ last: "299", change_percentage: "2.5" }],
      rateLimit: null,
    });

    await marketCandles({
      pair: "SOL_USDT",
      range: "1h",
      includeTicker: false,
    });
    const withTicker = await marketCandles({
      pair: "SOL_USDT",
      range: "1h",
      includeTicker: true,
    });

    expect(mockGetSpotCandlesticksRaw).toHaveBeenCalledTimes(2);
    expect(mockGetSpotTickerRaw).toHaveBeenCalledTimes(1);
    expect(withTicker).toMatchObject({
      cacheHit: false,
      currentPriceQuote: "299",
      change24hPct: "2.5",
    });
  });
});
