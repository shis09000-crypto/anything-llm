const {
  DEFAULT_SPOT_PAIR,
  GATE_REST_BASE_URL,
  GATE_REST_PREFIX,
} = require("./constants");
const { getGateCredentials } = require("./secretProvider");
const { signRestRequest } = require("./signer");
const { rawLength, safeErrorMessage, samplePayload } = require("./sanitizer");
const { GatePublicMarketClient } = require("./publicMarketClient");

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

function rateLimitFromHeaders(headers) {
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
    remaining,
    limit,
    remainPct:
      remainPct === null ? null : Number(Math.max(0, remainPct).toFixed(2)),
  };
}

class GatePrivateAccountClient {
  constructor(credentials = getGateCredentials()) {
    this.credentials = credentials;
  }

  async request(endpoint, { method = "GET", query = {}, body = null } = {}) {
    const result = await this.requestRaw(endpoint, { method, query, body });
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

  async requestRaw(endpoint, { method = "GET", query = {}, body = null } = {}) {
    const queryString = new URLSearchParams(query).toString();
    const requestPath = `${GATE_REST_PREFIX}${endpoint}`;
    const url = `${GATE_REST_BASE_URL}${endpoint}${
      queryString ? `?${queryString}` : ""
    }`;
    const bodyString =
      body === null || body === undefined ? "" : JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = signRestRequest({
      method,
      requestPath,
      queryString,
      body: bodyString,
      timestamp,
      secret: this.credentials.apiSecret,
    });

    try {
      const response = await fetch(url, {
        method,
        headers: {
          KEY: this.credentials.apiKey,
          SIGN: sign,
          Timestamp: String(timestamp),
          "Content-Type": "application/json",
        },
        body: bodyString || undefined,
      });
      const rateLimit = rateLimitFromHeaders(response.headers);
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

  getTotalBalance() {
    return this.request("/wallet/total_balance");
  }

  getTotalBalanceRaw() {
    return this.requestRaw("/wallet/total_balance");
  }

  getSpotAccounts() {
    return this.request("/spot/accounts");
  }

  getSpotAccountsRaw() {
    return this.requestRaw("/spot/accounts");
  }

  getEarnUniLendsRaw({ currency } = {}) {
    return this.requestRaw("/earn/uni/lends", {
      query: {
        ...(currency ? { currency: String(currency).toUpperCase() } : {}),
      },
    });
  }

  getFuturesUsdtAccount() {
    return this.request("/futures/usdt/accounts");
  }

  getFuturesUsdtPositions() {
    return this.request("/futures/usdt/positions");
  }

  getFuturesUsdtAccountRaw() {
    return this.requestRaw("/futures/usdt/accounts");
  }

  getFuturesUsdtPositionsRaw({ holding = true } = {}) {
    return this.requestRaw("/futures/usdt/positions", {
      query: {
        ...(holding === undefined ? {} : { holding: String(holding) }),
      },
    });
  }

  getOpenOrders() {
    return this.request("/spot/open_orders");
  }

  getRecentTrades() {
    return this.request("/spot/my_trades", {
      query: {
        currency_pair: process.env.GATE_PROBE_SPOT_PAIR || DEFAULT_SPOT_PAIR,
        limit: "20",
      },
    });
  }

  getSpotMyTradesRaw({
    currencyPair = null,
    limit = "100",
    page,
    from,
    to,
  } = {}) {
    return this.requestRaw("/spot/my_trades", {
      query: {
        ...(currencyPair ? { currency_pair: currencyPair } : {}),
        limit: String(limit),
        ...(page ? { page: String(page) } : {}),
        ...(from ? { from: String(from) } : {}),
        ...(to ? { to: String(to) } : {}),
      },
    });
  }

  getFuturesUsdtMyTradesRaw({
    contract,
    limit = "100",
    offset,
    from,
    to,
  } = {}) {
    return this.requestRaw("/futures/usdt/my_trades", {
      query: {
        ...(contract ? { contract: String(contract).toUpperCase() } : {}),
        limit: String(limit),
        ...(offset ? { offset: String(offset) } : {}),
        ...(from ? { from: String(from) } : {}),
        ...(to ? { to: String(to) } : {}),
      },
    });
  }

  getFuturesUsdtPositionCloseRaw({
    contract,
    limit = "100",
    offset,
    from,
    to,
    side,
    pnl,
  } = {}) {
    return this.requestRaw("/futures/usdt/position_close", {
      query: {
        ...(contract ? { contract: String(contract).toUpperCase() } : {}),
        limit: String(limit),
        ...(offset ? { offset: String(offset) } : {}),
        ...(from ? { from: String(from) } : {}),
        ...(to ? { to: String(to) } : {}),
        ...(side ? { side: String(side).toLowerCase() } : {}),
        ...(pnl ? { pnl: String(pnl) } : {}),
      },
    });
  }

  getFuturesUsdtOrderRaw({ contract, orderId } = {}) {
    return this.requestRaw(
      `/futures/usdt/orders/${encodeURIComponent(String(orderId || ""))}`,
      {
        query: {
          ...(contract ? { contract: String(contract).toUpperCase() } : {}),
        },
      }
    );
  }

  getWalletHistory() {
    return this.request("/wallet/deposits", {
      query: { limit: "20" },
    });
  }

  getSpotAccountBook({
    currency,
    from,
    to,
    page,
    limit = "100",
    type,
    code,
  } = {}) {
    return this.requestRaw("/spot/account_book", {
      query: {
        ...(currency ? { currency: String(currency).toUpperCase() } : {}),
        ...(from ? { from: String(from) } : {}),
        ...(to ? { to: String(to) } : {}),
        ...(page ? { page: String(page) } : {}),
        limit: String(limit),
        ...(type ? { type: String(type) } : {}),
        ...(code ? { code: String(code) } : {}),
      },
    });
  }

  getFuturesUsdtAccountBook({ from, to, limit = "100", offset, type } = {}) {
    return this.requestRaw("/futures/usdt/account_book", {
      query: {
        ...(from ? { from: String(from) } : {}),
        ...(to ? { to: String(to) } : {}),
        limit: String(limit),
        ...(offset ? { offset: String(offset) } : {}),
        ...(type ? { type: String(type) } : {}),
      },
    });
  }

  async snapshot() {
    const [
      totalBalance,
      spotAccounts,
      futuresAccount,
      futuresPositions,
      openOrders,
      recentTrades,
      walletHistory,
    ] = await Promise.all([
      this.getTotalBalance(),
      this.getSpotAccounts(),
      this.getFuturesUsdtAccount(),
      this.getFuturesUsdtPositions(),
      this.getOpenOrders(),
      this.getRecentTrades(),
      this.getWalletHistory(),
    ]);

    return {
      success: [
        totalBalance,
        spotAccounts,
        futuresAccount,
        futuresPositions,
        openOrders,
        recentTrades,
        walletHistory,
      ].every((item) => item.success),
      receivedAt: Date.now(),
      totalBalance,
      spotAccounts,
      futuresAccount,
      futuresPositions,
      openOrders,
      recentTrades,
      walletHistory,
      summary: {
        totalBalanceLoaded: totalBalance.success,
        spotAccountsCount: spotAccounts.rawDataLength || 0,
        futuresPositionsCount: futuresPositions.rawDataLength || 0,
        openOrdersCount: openOrders.rawDataLength || 0,
        recentTradesCount: recentTrades.rawDataLength || 0,
      },
    };
  }
}

class GateRestClient extends GatePrivateAccountClient {
  constructor(credentials = getGateCredentials()) {
    super(credentials);
    this.publicMarketClient = new GatePublicMarketClient();
  }

  getSpotTickerRaw(options = {}) {
    return this.publicMarketClient.getSpotTickerRaw(options);
  }

  getSpotTickersRaw() {
    return this.publicMarketClient.getSpotTickersRaw();
  }

  getSpotCandlesticksRaw(options = {}) {
    return this.publicMarketClient.getSpotCandlesticksRaw(options);
  }

  getFuturesUsdtContractRaw(options = {}) {
    return this.publicMarketClient.getFuturesUsdtContractRaw(options);
  }
}

module.exports = {
  GatePrivateAccountClient,
  GateRestClient,
  rateLimitFromHeaders,
};
