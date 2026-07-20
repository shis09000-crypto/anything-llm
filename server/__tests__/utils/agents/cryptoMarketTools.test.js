/* eslint-env jest */

process.env.NODE_ENV = "test";

const {
  cryptoMarketAgent,
  executeCryptoMarketSnapshot,
  executeCryptoPrice,
} = require("../../../utils/agents/aibitat/plugins/crypto-market");

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

describe("crypto market agent tools", () => {
  it("registers the two specialized read-only tools", () => {
    const definitions = [];
    const aibitat = {
      function: jest.fn((definition) => definitions.push(definition)),
      handlerProps: { log: jest.fn() },
    };

    for (const child of cryptoMarketAgent.plugin) child.plugin().setup(aibitat);

    expect(definitions.map(({ name }) => name)).toEqual([
      "crypto_price",
      "crypto_market_snapshot",
    ]);
    for (const definition of definitions) {
      expect(definition.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  it("uses Gate data and preserves the dual-source fallback", async () => {
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
    expect(snapshot.sources.binance).toMatchObject({
      ok: false,
      error: "provider_unavailable",
    });
  });
});
