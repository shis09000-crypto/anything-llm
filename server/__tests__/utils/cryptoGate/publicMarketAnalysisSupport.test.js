/* eslint-env jest */

process.env.NODE_ENV = "test";

const {
  GatePublicMarketClient,
  normalizedPublicMarketTimeoutMs,
} = require("../../../utils/cryptoGate/publicMarketClient");
const {
  intervalToMs,
  rangeMeta,
} = require("../../../utils/cryptoGate/marketCandles");

describe("public market analysis support", () => {
  it("maps the natural-week range without changing existing 7d behavior", () => {
    expect(rangeMeta("1w")).toMatchObject({
      id: "1w",
      interval: "1w",
      limit: 200,
    });
    expect(rangeMeta("7d")).toMatchObject({
      id: "7d",
      interval: "7d",
      limit: 200,
    });
    expect(intervalToMs("1w")).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it("uses a bounded eight-second provider timeout by default", () => {
    expect(normalizedPublicMarketTimeoutMs(undefined)).toBe(8_000);
    expect(normalizedPublicMarketTimeoutMs(999)).toBe(8_000);
    expect(normalizedPublicMarketTimeoutMs(8_500)).toBe(8_500);
    expect(normalizedPublicMarketTimeoutMs(25_001)).toBe(8_000);
  });

  it("classifies an aborted provider request as a recoverable timeout", async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn((_url, { signal }) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    const client = new GatePublicMarketClient({
      fetchImpl,
      timeoutMs: 1_000,
    });
    const pending = client.getSpotCandlesticksRaw({
      currencyPair: "BTC_USDT",
      interval: "1h",
      limit: 200,
    });

    jest.advanceTimersByTime(1_000);
    const result = await pending;
    expect(result).toMatchObject({
      success: false,
      errorCode: "provider_timeout",
      safeErrorMessage: "Gate public market request timed out.",
    });
    jest.useRealTimers();
  });
});
