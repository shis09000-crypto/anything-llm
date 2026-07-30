const { DEFAULT_SPOT_PAIR, GATE_REST_BASE_URL } = require("./constants");
const { rawLength, safeErrorMessage, samplePayload } = require("./sanitizer");

const DEFAULT_PUBLIC_MARKET_TIMEOUT_MS = 8_000;

function normalizedPublicMarketTimeoutMs(value) {
  const parsed = Number(value ?? process.env.AGENT_MARKET_DATA_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 1_000 || parsed > 25_000)
    return DEFAULT_PUBLIC_MARKET_TIMEOUT_MS;
  return Math.floor(parsed);
}

function normalizedSummary(data) {
  if (Array.isArray(data)) {
    return {
      count: data.length,
      sampleKeys:
        data[0] && typeof data[0] === "object" ? Object.keys(data[0]) : [],
    };
  }
  if (data && typeof data === "object") {
    return {
      keys: Object.keys(data),
    };
  }
  return { valueType: typeof data };
}

function numericHeader(headers, candidates = [], matcher = null) {
  for (const name of candidates) {
    const value = Number(headers.get(name));
    if (Number.isFinite(value)) return value;
  }

  if (!matcher) return null;
  for (const [key, rawValue] of headers.entries()) {
    if (!matcher(key.toLowerCase())) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function publicRateLimitFromHeaders(headers) {
  if (!headers) return null;

  const remaining = numericHeader(
    headers,
    [
      "x-gate-ratelimit-requests-remain",
      "x-gate-ratelimit-remaining",
      "x-ratelimit-remaining",
      "ratelimit-remaining",
    ],
    (key) => key.includes("ratelimit") && key.includes("remain")
  );
  const limit = numericHeader(
    headers,
    [
      "x-gate-ratelimit-requests-limit",
      "x-gate-ratelimit-limit",
      "x-ratelimit-limit",
      "ratelimit-limit",
    ],
    (key) =>
      key.includes("ratelimit") &&
      key.includes("limit") &&
      !key.includes("reset")
  );

  if (remaining === null && limit === null) return null;
  const remainPct =
    Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0
      ? (remaining / limit) * 100
      : null;

  return {
    kind: "public",
    remaining,
    limit,
    remainPct:
      remainPct === null ? null : Number(Math.max(0, remainPct).toFixed(2)),
  };
}

class GatePublicMarketClient {
  constructor({ fetchImpl = null, timeoutMs } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = normalizedPublicMarketTimeoutMs(timeoutMs);
  }

  async request(endpoint, { query = {} } = {}) {
    const result = await this.requestRaw(endpoint, { query });
    if (!result.success) return result;

    return {
      success: true,
      endpoint,
      receivedAt: result.receivedAt,
      rawDataLength: rawLength(result.data),
      sanitizedSample: samplePayload(result.data),
      normalizedSummary: normalizedSummary(result.data),
    };
  }

  async requestRaw(endpoint, { query = {} } = {}) {
    const queryString = new URLSearchParams(query).toString();
    const url = `${GATE_REST_BASE_URL}${endpoint}${
      queryString ? `?${queryString}` : ""
    }`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await (this.fetchImpl || global.fetch)(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      });
      const rateLimit = publicRateLimitFromHeaders(response.headers);
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text || null;
      }

      if (!response.ok) {
        return {
          success: false,
          endpoint,
          statusCode: response.status,
          rateLimit,
          safeErrorMessage: safeErrorMessage(
            typeof data === "object" ? data?.message || text : data || text
          ),
        };
      }

      return {
        success: true,
        endpoint,
        receivedAt: Date.now(),
        rateLimit,
        data,
      };
    } catch (error) {
      return {
        success: false,
        endpoint,
        statusCode: null,
        errorCode:
          error?.name === "AbortError"
            ? "provider_timeout"
            : "provider_unavailable",
        safeErrorMessage:
          error?.name === "AbortError"
            ? "Gate public market request timed out."
            : safeErrorMessage(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  getSpotTickerRaw({ currencyPair = DEFAULT_SPOT_PAIR } = {}) {
    return this.requestRaw("/spot/tickers", {
      query: { currency_pair: currencyPair },
    });
  }

  getSpotTickersRaw() {
    return this.requestRaw("/spot/tickers");
  }

  getSpotCandlesticksRaw({
    currencyPair = DEFAULT_SPOT_PAIR,
    interval = "30m",
    limit = "48",
    from,
    to,
  } = {}) {
    return this.requestRaw("/spot/candlesticks", {
      query: {
        currency_pair: currencyPair,
        interval,
        limit: String(limit),
        ...(from ? { from: String(from) } : {}),
        ...(to ? { to: String(to) } : {}),
      },
    });
  }

  getSpotTradesRaw({
    currencyPair = DEFAULT_SPOT_PAIR,
    limit = 1_000,
    from,
    to,
  } = {}) {
    return this.requestRaw("/spot/trades", {
      query: {
        currency_pair: currencyPair,
        limit: String(limit),
        ...(from ? { from: String(from) } : {}),
        ...(to ? { to: String(to) } : {}),
      },
    });
  }

  getSpotOrderBookRaw({
    currencyPair = DEFAULT_SPOT_PAIR,
    limit = 100,
    withId = true,
  } = {}) {
    return this.requestRaw("/spot/order_book", {
      query: {
        currency_pair: currencyPair,
        limit: String(limit),
        with_id: withId ? "true" : "false",
      },
    });
  }

  getFuturesUsdtContractRaw({ contract } = {}) {
    const normalized = String(contract || "")
      .trim()
      .toUpperCase()
      .replace(/-/g, "_");
    return this.requestRaw(
      `/futures/usdt/contracts/${encodeURIComponent(normalized)}`
    );
  }

  getFuturesUsdtContractStatsRaw({
    contract,
    interval = "5m",
    limit = 300,
    from,
  } = {}) {
    const normalized = String(contract || "")
      .trim()
      .toUpperCase()
      .replace(/-/g, "_");
    return this.requestRaw("/futures/usdt/contract_stats", {
      query: {
        contract: normalized,
        interval,
        limit: String(limit),
        ...(from ? { from: String(from) } : {}),
      },
    });
  }

  getFuturesUsdtFundingRatesRaw({ contract, limit = 30, from, to } = {}) {
    const normalized = String(contract || "")
      .trim()
      .toUpperCase()
      .replace(/-/g, "_");
    return this.requestRaw("/futures/usdt/funding_rate", {
      query: {
        contract: normalized,
        limit: String(limit),
        ...(from ? { from: String(from) } : {}),
        ...(to ? { to: String(to) } : {}),
      },
    });
  }
}

module.exports = {
  DEFAULT_PUBLIC_MARKET_TIMEOUT_MS,
  GatePublicMarketClient,
  normalizedPublicMarketTimeoutMs,
  publicRateLimitFromHeaders,
};
