/* eslint-env jest */

const {
  collectCoinMetrics,
  collectDefiLlama,
  collectDeribitDvol,
  collectFredMacro,
} = require("../../../utils/cryptoForecasting/candidateSignals");

function response(data, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => data,
  };
}

describe("crypto forecast low-frequency candidate signals", () => {
  it("records source time separately from first availability time", async () => {
    const now = Date.parse("2026-07-29T00:05:00Z");
    const result = await collectCoinMetrics({
      symbol: "BTC",
      now,
      fetchImpl: jest.fn().mockResolvedValue(
        response({
          data: [
            {
              asset: "btc",
              time: "2026-07-28T00:00:00.000000000Z",
              AdrActCnt: "100",
              TxCnt: "200",
              CapMrktCurUSD: "300",
            },
          ],
        })
      ),
    });
    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "coinmetrics_community",
          symbol: "BTC",
          observedAtMs: Date.parse("2026-07-28T00:00:00Z"),
          availableAtMs: now,
          availabilityQuality: "organic_only",
          status: "supporting_only_until_180d_point_in_time",
        }),
      ])
    );
    expect(result.observations[0].payload).toMatchObject({
      activeAddresses: "100",
      transactionCount: "200",
      marketCapUsd: "300",
      exchangeNetflowNative: null,
    });
  });

  it("keeps DefiLlama inapplicable for BTC and stores only the latest ETH row", async () => {
    await expect(collectDefiLlama({ symbol: "BTC" })).resolves.toEqual({
      status: "not_applicable",
      observations: [],
    });
    const result = await collectDefiLlama({
      symbol: "ETH",
      now: 1_800_000_000_000,
      fetchImpl: jest.fn().mockResolvedValue(
        response([
          { date: 1_700_000_000, tvl: 10 },
          { date: 1_700_086_400, tvl: 11 },
        ])
      ),
    });
    expect(result.observations[0]).toMatchObject({
      source: "defillama_free",
      symbol: "ETH",
      observedAtMs: 1_700_086_400_000,
      availableAtMs: 1_800_000_000_000,
      payload: { chain: "Ethereum", tvlUsd: 11 },
    });
  });

  it("keeps Deribit DVOL point-in-time and does not invent SOL options data", async () => {
    await expect(collectDeribitDvol({ symbol: "SOL" })).resolves.toEqual({
      status: "not_applicable",
      observations: [],
    });
    const now = Date.parse("2026-07-30T12:00:00Z");
    const result = await collectDeribitDvol({
      symbol: "BTC",
      now,
      fetchImpl: jest.fn().mockResolvedValue(
        response({
          result: {
            data: [[now - 3_600_000, 50, 55, 48, 52]],
          },
        })
      ),
    });
    expect(result.observations[0]).toMatchObject({
      source: "deribit_dvol",
      symbol: "BTC",
      availabilityQuality: "organic_only",
      payload: { interval: "1h", close: 52 },
    });
  });

  it("marks FRED values estimated and applies the conservative lag", async () => {
    const now = Date.parse("2026-07-30T12:00:00Z");
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response("DATE,DTWEXBGS\n2026-07-28,121.4\n"))
      .mockResolvedValueOnce(response("DATE,VIXCLS\n2026-07-28,18.2\n"));
    const result = await collectFredMacro({ symbol: "BTC", now, fetchImpl });
    expect(result.status).toBe("candidate");
    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "fred_dxy",
          availabilityQuality: "estimated",
          availabilityEstimated: true,
          payload: expect.objectContaining({
            conservativeAvailabilityLagMs: 36 * 60 * 60 * 1_000,
          }),
        }),
      ])
    );
  });
});
