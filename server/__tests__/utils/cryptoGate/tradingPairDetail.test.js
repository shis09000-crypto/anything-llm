const {
  GateTradingPairDetailService,
} = require("../../../utils/cryptoGate/tradingPairDetail");

describe("GateTradingPairDetailService", () => {
  test("returns trusted price and balance while average cost is still loading", async () => {
    const neverFinishes = new Promise(() => {});
    const client = {
      getSpotTickerRaw: jest.fn(async () => ({
        success: true,
        data: [
          {
            currency_pair: "SOL_USDT",
            last: "100",
            change_percentage: "2",
          },
        ],
      })),
      getSpotAccountsRaw: jest.fn(async () => ({
        success: true,
        data: [{ currency: "SOL", available: "2", locked: "0" }],
      })),
      getEarnUniLendsRaw: jest.fn(async () => ({
        success: true,
        data: [],
      })),
      getSpotMyTradesRaw: jest.fn(() => neverFinishes),
    };
    const service = new GateTradingPairDetailService({
      restClientFactory: () => client,
    });

    const detail = await Promise.race([
      service.detail({ pair: "SOL_USDT", market: "spot" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("detail response blocked")), 250)
      ),
    ]);

    expect(detail).toMatchObject({
      success: true,
      gateCurrencyPair: "SOL_USDT",
      holdingAmountBase: "2",
      holdingValueQuote: "200.00",
      currentPriceQuote: "100",
      averageBuyPriceQuote: null,
      averageBuyPriceScope: "calculating",
    });
    expect(client.getSpotMyTradesRaw).toHaveBeenCalledTimes(1);
  });
});
