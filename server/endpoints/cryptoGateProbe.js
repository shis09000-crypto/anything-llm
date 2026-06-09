const {
  cryptoGateEventBuffer,
  cryptoGateBtcSpotSummaryService,
  cryptoGateEquityHistoryService,
  cryptoGateMarketCandlesService,
  cryptoGateMarketStreamManager,
  cryptoGateOpenFuturesPositionsService,
  cryptoGateTradeRecordsFeeSummaryService,
  cryptoGateTradeRecordsService,
  cryptoGateTopSpotAssetsService,
  cryptoGateTradingPairDetailService,
  cryptoGateWsManager,
  GateRestClient,
  getGateConfigStatus,
  getGateCredentials,
  safeErrorMessage,
} = require("../utils/cryptoGate");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");

let lastRestSnapshotAt = null;
const CRYPTO_CENTER_DEV_AUTH_BYPASS_HEADER = "x-crypto-center-dev-auth-bypass";
const STABLE_ALLOCATION_ASSETS = new Set(["USDT", "GUSD", "USDC"]);
const ASSET_COLORS = {
  BTC: "#1683FF",
  ETH: "#A855F7",
  USDT: "#FF8A00",
  GUSD: "#14C8B8",
  USDC: "#2775CA",
  SOL: "#4F63FF",
  BNB: "#F6B91A",
  XRP: "#F05272",
};

function isCryptoCenterDevAuthBypassEnabled(request) {
  if (process.env.NODE_ENV === "production") return false;
  const headerValue =
    request.header?.(CRYPTO_CENTER_DEV_AUTH_BYPASS_HEADER) ||
    request.headers?.[CRYPTO_CENTER_DEV_AUTH_BYPASS_HEADER];
  const queryValue = request.query?.cryptoCenterAuthBypass;
  return (
    process.env.CRYPTO_CENTER_AUTH_BYPASS === "true" ||
    headerValue === "1" ||
    headerValue === "true" ||
    queryValue === "1" ||
    queryValue === "true"
  );
}

function gateAccessMiddleware() {
  const roleCheck = flexUserRoleValid([ROLES.admin, ROLES.manager]);
  return [
    async (request, response, next) => {
      if (isCryptoCenterDevAuthBypassEnabled(request)) {
        response.locals.multiUserMode = false;
        return next();
      }

      return validatedRequest(request, response, (error) => {
        if (error) return next(error);
        return roleCheck(request, response, next);
      });
    },
  ];
}

function safeConfigStatus() {
  try {
    return getGateConfigStatus();
  } catch (error) {
    return {
      enabled: process.env.GATE_CRYPTO_ENABLED === "true",
      env: process.env.GATE_API_ENV || "production",
      readOnly: process.env.GATE_API_READONLY === "true",
      hasApiKey: false,
      hasApiSecret: false,
      maskedApiKey: null,
      error: safeErrorMessage(error),
    };
  }
}

function normalizeAsset(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function decimalString(value, fractionDigits = 2) {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(fractionDigits);
}

function addAllocationBalance(balances, asset, amount) {
  const symbol = normalizeAsset(asset);
  const value = numberValue(amount);
  if (!symbol || value <= 0) return;
  balances.set(symbol, (balances.get(symbol) || 0) + value);
}

function collectAllocationBalances(accounts = [], earns = []) {
  const balances = new Map();
  if (Array.isArray(accounts)) {
    for (const account of accounts) {
      addAllocationBalance(
        balances,
        account?.currency,
        numberValue(account?.available) + numberValue(account?.locked)
      );
    }
  }
  if (Array.isArray(earns)) {
    for (const lend of earns) {
      addAllocationBalance(
        balances,
        lend?.currency,
        lend?.amount || lend?.lent_amount
      );
    }
  }
  return balances;
}

function tickerMapByPair(tickers = []) {
  const map = new Map();
  if (!Array.isArray(tickers)) return map;
  for (const ticker of tickers) {
    const pair = normalizeAsset(ticker?.currency_pair);
    if (!pair) continue;
    const price = numberValue(ticker?.last || ticker?.close);
    if (price <= 0) continue;
    map.set(pair, {
      price,
      change24hPct:
        ticker?.change_percentage ??
        ticker?.change_utc0 ??
        ticker?.change_utc8 ??
        ticker?.change,
    });
  }
  return map;
}

function allocationItemFor({ symbol, amount, quoteAsset, ticker }) {
  const stable = STABLE_ALLOCATION_ASSETS.has(symbol);
  const priceUsd = stable ? 1 : ticker?.price;
  if (!priceUsd || priceUsd <= 0) return null;
  const valueUsd = amount * priceUsd;
  if (valueUsd <= 0) return null;

  return {
    symbol,
    name: stable ? "USD Stablecoin" : symbol,
    nameCn: stable ? symbol : symbol,
    color: ASSET_COLORS[symbol] || "#9CA3AF",
    valueUsd: decimalString(valueUsd, 2),
    percentage: "0",
    amount: decimalString(amount, stable ? 2 : 8),
    priceUsd: decimalString(priceUsd, stable ? 2 : 8),
    change24hPct:
      ticker?.change24hPct === undefined || ticker?.change24hPct === null
        ? null
        : String(ticker.change24hPct),
    quoteAsset,
  };
}

function cryptoGateProbeEndpoints(app) {
  if (!app) return;

  app.get(
    "/crypto/gate/portfolio/allocation",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        const quoteAsset = normalizeAsset(request.query?.quote || "USDT");
        const client = new GateRestClient();
        const [spotResult, earnResult, tickersResult] =
          await Promise.allSettled([
            client.getSpotAccountsRaw(),
            client.getEarnUniLendsRaw(),
            client.getSpotTickersRaw(),
          ]);

        if (spotResult.status !== "fulfilled" || !spotResult.value.success) {
          throw new Error(
            spotResult.status === "fulfilled"
              ? spotResult.value.safeErrorMessage ||
                "Gate spot accounts failed."
              : safeErrorMessage(spotResult.reason)
          );
        }
        if (
          tickersResult.status !== "fulfilled" ||
          !tickersResult.value.success
        ) {
          throw new Error(
            tickersResult.status === "fulfilled"
              ? tickersResult.value.safeErrorMessage ||
                "Gate spot tickers failed."
              : safeErrorMessage(tickersResult.reason)
          );
        }

        const partialFailures = [];
        if (earnResult.status !== "fulfilled" || !earnResult.value.success) {
          partialFailures.push({
            source: "earn_uni_lends",
            message:
              earnResult.status === "fulfilled"
                ? earnResult.value.safeErrorMessage ||
                  "Gate earn balance failed."
                : safeErrorMessage(earnResult.reason),
          });
        }

        const balances = collectAllocationBalances(
          spotResult.value.data,
          earnResult.status === "fulfilled" && earnResult.value.success
            ? earnResult.value.data
            : []
        );
        const tickers = tickerMapByPair(tickersResult.value.data);
        const rawItems = [];

        for (const [symbol, amount] of balances.entries()) {
          const ticker = tickers.get(`${symbol}_${quoteAsset}`);
          const item = allocationItemFor({
            symbol,
            amount,
            quoteAsset,
            ticker,
          });
          if (item) rawItems.push(item);
        }

        const totalValue = rawItems.reduce(
          (sum, item) => sum + numberValue(item.valueUsd),
          0
        );
        const items = rawItems
          .map((item) => ({
            ...item,
            percentage:
              totalValue > 0
                ? decimalString(
                    (numberValue(item.valueUsd) / totalValue) * 100,
                    2
                  )
                : "0.00",
          }))
          .sort(
            (left, right) =>
              numberValue(right.valueUsd) - numberValue(left.valueUsd)
          );

        response.status(200).json({
          success: true,
          asOf: Date.now(),
          exchange: "gate",
          marketType: "spot",
          scope: "all",
          quoteAsset,
          totalValueUsd: decimalString(totalValue, 2),
          items,
          connectionStatus: partialFailures.length ? "degraded" : "connected",
          config: safeConfigStatus(),
          partialFailures,
        });
      } catch (error) {
        response.status(500).json({
          success: false,
          asOf: Date.now(),
          exchange: "gate",
          marketType: "spot",
          connectionStatus: "disconnected",
          safeErrorMessage: safeErrorMessage(
            error?.message || "Gate allocation failed"
          ),
          items: [],
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );

  app.get(
    "/crypto/gate/futures/open-positions",
    gateAccessMiddleware(),
    async (_request, response) => {
      try {
        response
          .status(200)
          .json(await cryptoGateOpenFuturesPositionsService.snapshot());
      } catch (error) {
        response.status(500).json({
          success: false,
          asOf: Date.now(),
          exchange: "gate",
          marketType: "futures",
          settle: "usdt",
          connectionStatus: "disconnected",
          safeErrorMessage: safeErrorMessage(
            error?.message || "Gate futures positions failed"
          ),
          positions: [],
          summary: {
            totalUnrealizedPnlUsd: "0.00",
            weightedPnlPct: "0.00",
            totalMarginUsd: "0.00",
            accountEquityUsd: "0.00",
            marginRatioPct: "0.00",
          },
          partialFailures: [],
        });
      }
    }
  );

  app.get(
    "/crypto/gate/futures/open-positions/stream",
    gateAccessMiddleware(),
    async (_request, response) => {
      await cryptoGateOpenFuturesPositionsService.subscribe(response);
    }
  );

  app.get(
    "/crypto/gate/trade-records",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await cryptoGateTradeRecordsService.snapshot({
            from: request.query?.from,
            to: request.query?.to,
            cursorTs: request.query?.cursorTs,
            limit: request.query?.limit,
            debugFeeFields: request.query?.debugFeeFields === "true",
          })
        );
      } catch (error) {
        response.status(500).json({
          success: false,
          asOf: Date.now(),
          exchange: "gate",
          marketType: "all",
          connectionStatus: "disconnected",
          safeErrorMessage: safeErrorMessage(
            error?.message || "Gate trade records failed"
          ),
          records: [],
          summary: {
            totalNotionalUsd: "0.00",
            totalFeeUsd: "0.00",
            totalRealizedPnlUsd: "0.00",
            winRatePct: "0.00",
            tradeCount: 0,
            spotNotionalUsd: "0.00",
            futuresNotionalUsd: "0.00",
          },
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );

  app.get(
    "/crypto/gate/trade-records/fee-summary",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await cryptoGateTradeRecordsFeeSummaryService.snapshot({
            from: request.query?.from,
            to: request.query?.to,
            includeYear: request.query?.includeYear !== "false",
          })
        );
      } catch (error) {
        response.status(500).json({
          success: false,
          exchange: "gate",
          asOf: Date.now(),
          connectionStatus: "disconnected",
          safeErrorMessage: safeErrorMessage(
            error?.message || "Gate trade records fee summary failed"
          ),
          range: {
            from: Number(request.query?.from) || 0,
            to: Number(request.query?.to) || 0,
          },
          totalFeeUsd: "0.00",
          yearTotalFeeUsd: "0.00",
          feeSources: {
            spotUsd: "0.00",
            futuresUsd: "0.00",
            gtUsd: "0.00",
            pointAmount: "0.00000000",
            unknownUsd: "0.00",
          },
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );

  app.get(
    "/crypto/gate/trade-records/stream",
    gateAccessMiddleware(),
    async (request, response) => {
      await cryptoGateTradeRecordsService.subscribe(response, {
        from: request.query?.from,
        to: request.query?.to,
        limit: request.query?.limit,
      });
    }
  );

  app.get(
    "/crypto/gate/market/candles",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        const result = await cryptoGateMarketCandlesService.marketCandles({
          pair: request.query?.pair || "BTC_USDT",
          range: request.query?.range || "1d",
          market: request.query?.market || "spot",
          beforeTs: request.query?.beforeTs,
          afterTs: request.query?.afterTs,
        });
        response.status(200).json(result);
      } catch (error) {
        const statusCode =
          error?.code === "invalid_pair" ||
          error?.code === "unsupported_range" ||
          error?.code === "unsupported_market"
            ? 400
            : 500;
        response.status(statusCode).json({
          success: false,
          asOf: Date.now(),
          exchange: "gate",
          gateCurrencyPair: String(request.query?.pair || "BTC_USDT")
            .trim()
            .toUpperCase(),
          range: String(request.query?.range || "1d")
            .trim()
            .toLowerCase(),
          marketType: String(request.query?.market || "spot").toLowerCase(),
          connectionStatus: "disconnected",
          safeErrorMessage: safeErrorMessage(
            error?.message || "Gate market candles failed"
          ),
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
          candles: [],
        });
      }
    }
  );

  app.get(
    "/crypto/gate/market/candles/stream",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        cryptoGateMarketStreamManager.subscribe({
          pair: request.query?.pair || "BTC_USDT",
          range: request.query?.range || "1d",
          market: request.query?.market || "spot",
          response,
        });
      } catch (error) {
        const statusCode =
          error?.code === "invalid_pair" ||
          error?.code === "unsupported_range" ||
          error?.code === "unsupported_market"
            ? 400
            : 500;
        response.status(statusCode).json({
          success: false,
          asOf: Date.now(),
          exchange: "gate",
          safeErrorMessage: safeErrorMessage(
            error?.message || "Gate market candles stream failed"
          ),
        });
      }
    }
  );

  app.get(
    "/crypto/gate/trading-pair/detail",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        const pair = request.query?.pair || "BTC_USDT";
        const market = request.query?.market || "spot";
        const detail = await cryptoGateTradingPairDetailService.detail({
          pair,
          market,
        });
        response.status(200).json(detail);
      } catch (error) {
        const statusCode =
          error?.code === "invalid_pair" || error?.code === "unsupported_market"
            ? 400
            : 500;
        response.status(statusCode).json({
          success: false,
          asOf: Date.now(),
          exchange: "gate",
          gateCurrencyPair: String(request.query?.pair || "BTC_USDT")
            .trim()
            .toUpperCase(),
          marketType: String(request.query?.market || "spot").toLowerCase(),
          connectionStatus: "disconnected",
          safeErrorMessage: safeErrorMessage(
            error?.message || "Gate trading pair detail failed"
          ),
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );

  app.get(
    "/crypto/gate/spot/top-assets",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        const result = await cryptoGateTopSpotAssetsService.topAssets({
          limit: request.query?.limit,
          exclude: request.query?.exclude,
          quote: request.query?.quote || "USDT",
        });
        response.status(200).json(result);
      } catch (error) {
        response.status(500).json({
          success: false,
          asOf: Date.now(),
          exchange: "gate",
          marketType: "spot",
          connectionStatus: "disconnected",
          safeErrorMessage: safeErrorMessage(
            error?.message || "Gate top spot assets failed"
          ),
          assets: [],
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );

  app.get(
    "/crypto/gate/spot/btc-summary",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        const range = request.query?.range || "1d";
        const summary = await cryptoGateBtcSpotSummaryService.summary({
          range,
        });
        response.status(200).json(summary);
      } catch (error) {
        response.status(500).json({
          success: false,
          asOf: Date.now(),
          exchange: "gate",
          symbol: "BTC_USDT",
          connectionStatus: "disconnected",
          safeErrorMessage: safeErrorMessage(
            error?.message || "Gate BTC summary failed"
          ),
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );

  app.get(
    "/crypto/gate/probe/status",
    gateAccessMiddleware(),
    async (_request, response) => {
      try {
        response.status(200).json({
          success: true,
          config: safeConfigStatus(),
          ws: cryptoGateWsManager.status(),
          marketStreams: cryptoGateMarketStreamManager.status(),
          lastRestSnapshotAt,
          recentEventCount: cryptoGateEventBuffer.recent(500).length,
        });
      } catch (error) {
        response.status(500).json({
          success: false,
          error: safeErrorMessage(error),
        });
      }
    }
  );

  app.post(
    "/crypto/gate/probe/rest-snapshot",
    gateAccessMiddleware(),
    async (_request, response) => {
      try {
        const credentials = getGateCredentials();
        const snapshot = await new GateRestClient(credentials).snapshot();
        await cryptoGateEquityHistoryService.recordSnapshot("snapshot");
        lastRestSnapshotAt = Date.now();
        cryptoGateEventBuffer.push({
          source: "rest",
          eventType: "snapshot",
          channel: "rest.snapshot",
          payload: snapshot,
        });
        response.status(200).json({
          success: true,
          config: safeConfigStatus(),
          snapshot,
        });
      } catch (error) {
        response.status(500).json({
          success: false,
          error: safeErrorMessage(error),
          config: safeConfigStatus(),
        });
      }
    }
  );

  app.post(
    "/crypto/gate/probe/ws/start",
    gateAccessMiddleware(),
    async (_request, response) => {
      try {
        const credentials = getGateCredentials();
        cryptoGateEquityHistoryService.startPolling();
        cryptoGateWsManager.setEventHandler((event) =>
          cryptoGateEquityHistoryService.markDirty(
            `${event?.source || "ws"}:${event?.eventType || "event"}`
          )
        );
        const ws = cryptoGateWsManager.start(credentials);
        response.status(200).json({
          success: true,
          config: safeConfigStatus(),
          ws,
          freshness: cryptoGateEquityHistoryService.freshness(),
        });
      } catch (error) {
        response.status(500).json({
          success: false,
          error: safeErrorMessage(error),
          config: safeConfigStatus(),
        });
      }
    }
  );

  app.post(
    "/crypto/gate/probe/ws/stop",
    gateAccessMiddleware(),
    async (_request, response) => {
      try {
        cryptoGateEquityHistoryService.stopPolling();
        response.status(200).json({
          success: true,
          ws: cryptoGateWsManager.stop(),
        });
      } catch (error) {
        response.status(500).json({
          success: false,
          error: safeErrorMessage(error),
        });
      }
    }
  );

  app.get(
    "/crypto/gate/probe/events",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        const limit = Number(request.query?.limit || 100);
        response.status(200).json({
          success: true,
          events: cryptoGateEventBuffer.recent(
            Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100
          ),
        });
      } catch (error) {
        response.status(500).json({
          success: false,
          error: safeErrorMessage(error),
        });
      }
    }
  );

  app.get(
    "/crypto/gate/probe/equity-history",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        const window = request.query?.window || "today";
        if (window !== "today") {
          response.status(400).json({
            success: false,
            error: "Only the today equity history window is supported.",
          });
          return;
        }

        response.status(200).json({
          success: true,
          config: safeConfigStatus(),
          history: await cryptoGateEquityHistoryService.today({
            equityMode: request.query?.equityMode,
            sinceTs: request.query?.sinceTs,
          }),
        });
      } catch (error) {
        response.status(500).json({
          success: false,
          error: safeErrorMessage(error),
          config: safeConfigStatus(),
        });
      }
    }
  );
}

module.exports = {
  cryptoGateProbeEndpoints,
};
