const {
  AllocationHubService,
  collectAllocationBalances,
} = require("../../../utils/cryptoHub/services/allocationHubService");

describe("AllocationHubService holding source semantics", () => {
  test("keeps spot and Earn quantities separate while preserving combined totals", () => {
    const balances = collectAllocationBalances(
      [
        { currency: "BTC", available: "0.002", locked: "0.001" },
        { currency: "USDT", available: "2", locked: "1" },
      ],
      [
        { currency: "BTC", amount: "0.247", lent_amount: "0.247" },
        { currency: "USDT", amount: "100", lent_amount: "100" },
      ]
    );

    expect(balances.get("BTC")).toEqual({
      symbol: "BTC",
      spotAmount: 0.003,
      earnAmount: 0.247,
    });
    expect(balances.get("USDT")).toEqual({
      symbol: "USDT",
      spotAmount: 3,
      earnAmount: 100,
    });
  });

  test("returns explicit spot, Earn, and combined valuation fields", async () => {
    const client = {
      getSpotAccountsRaw: jest.fn().mockResolvedValue({
        success: true,
        data: [
          { currency: "BTC", available: "0.002", locked: "0.001" },
          { currency: "USDT", available: "2", locked: "1" },
        ],
      }),
      getEarnUniLendsRaw: jest.fn().mockResolvedValue({
        success: true,
        data: [
          {
            currency: "BTC",
            amount: "0.247",
            lent_amount: "0.247",
            interest_status: "interest_reinvest",
          },
          {
            currency: "USDT",
            amount: "100",
            lent_amount: "100",
            interest_status: "interest_reinvest",
          },
        ],
      }),
      getSpotTickersRaw: jest.fn().mockResolvedValue({
        success: true,
        data: [{ currency_pair: "BTC_USDT", last: "50000" }],
      }),
    };
    const service = new AllocationHubService({
      restClientFactory: () => client,
    });

    const snapshot = await service.snapshot({ quote: "USDT" });
    const btc = snapshot.items.find((item) => item.symbol === "BTC");
    const usdt = snapshot.items.find((item) => item.symbol === "USDT");

    expect(snapshot).toMatchObject({
      holdingScope: "spot_and_earn",
      spotValueUsd: "153.00",
      earnValueUsd: "12450.00",
      combinedValueUsd: "12603.00",
      totalValueUsd: "12603.00",
    });
    expect(btc).toMatchObject({
      amountScope: "spot_plus_earn",
      amount: "0.25000000",
      totalAmount: "0.250000000000",
      spotAmount: "0.003000000000",
      earnAmount: "0.247000000000",
      spotValueUsd: "150.00",
      earnValueUsd: "12350.00",
      holdingSources: ["spot", "earn"],
    });
    expect(usdt).toMatchObject({
      totalAmount: "103.000000000000",
      spotAmount: "3.000000000000",
      earnAmount: "100.000000000000",
      holdingSources: ["spot", "earn"],
    });
  });
});
