const { DEFAULT_SPOT_PAIR, GATE_REST_BASE_URL } = require("./constants");
const { rawLength, safeErrorMessage, samplePayload } = require("./sanitizer");

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

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
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
        safeErrorMessage: safeErrorMessage(error),
      };
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
}

module.exports = {
  GatePublicMarketClient,
  publicRateLimitFromHeaders,
};
