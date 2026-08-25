const {
  GateTopSpotAssetsService,
} = require("../../../utils/cryptoGate/topSpotAssets");

describe("GateTopSpotAssetsService underlying asset identity", () => {
  test("shows GTSOL as SOL with SOL pricing and merges matching balances", async () => {
    const client = {
      getSpotAccountsRaw: jest.fn().mockResolvedValue({
        success: true,
        data: [{ currency: "SOL", available: "2", locked: "0" }],
      }),
      getEarnUniLendsRaw: jest.fn().mockResolvedValue({
        success: true,
        data: [
          { currency: "GTSOL", amount: "8" },
          { currency: "GTETH", amount: "3" },
        ],
      }),
      getSpotTickersRaw: jest.fn().mockResolvedValue({
        success: true,
        data: [
          { currency_pair: "SOL_USDT", last: "150", change_percentage: "2" },
          { currency_pair: "ETH_USDT", last: "2500" },
        ],
      }),
    };
    const result = await new GateTopSpotAssetsService({
      restClientFactory: () => client,
    }).topAssets({ exclude: ["ETH", "USDT"], quote: "USDT" });

    expect(result.assets).toEqual([
      expect.objectContaining({
        pair: "SOL_USDT",
        baseAsset: "SOL",
        symbol: "SOL/USDT",
        holdingAmountBase: "10",
        holdingValueQuote: "1500.00",
        sourceAssets: ["SOL", "GTSOL"],
      }),
    ]);
  });
});
