const { cryptoDataHub } = require("../../utils/cryptoHub");
const {
  cryptoGateEventBuffer,
  cryptoGateMarketStreamManager,
  cryptoGateWsManager,
  GateRestClient,
  getGateConfigStatus,
  getGateCredentials,
  safeErrorMessage,
} = require("../../utils/cryptoGate");
const {
  flexUserRoleValid,
  ROLES,
} = require("../../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");

let lastRestSnapshotAt = null;
const CRYPTO_CENTER_DEV_AUTH_BYPASS_HEADER = "x-crypto-center-dev-auth-bypass";

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
  const roleCheck = flexUserRoleValid([ROLES.admin]);
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

function legacyErrorResponse(response, error, fallback, extra = {}) {
  response.status(500).json({
    success: false,
    asOf: Date.now(),
    exchange: "gate",
    connectionStatus: "disconnected",
    safeErrorMessage: safeErrorMessage(error?.message || fallback),
    partialFailures: Array.isArray(error?.partialFailures)
      ? error.partialFailures
      : [],
    ...extra,
  });
}

function marketErrorResponse(request, response, error, fallback) {
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
    safeErrorMessage: safeErrorMessage(error?.message || fallback),
    partialFailures: Array.isArray(error?.partialFailures)
      ? error.partialFailures
      : [],
    candles: [],
  });
}

function cryptoGateProbeEndpoints(app) {
  if (!app) return;

  app.get(
    "/crypto/gate/portfolio/allocation",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await cryptoDataHub.getAllocation({
            quote: request.query?.quote || "USDT",
          })
        );
      } catch (error) {
        legacyErrorResponse(response, error, "Gate allocation failed", {
          marketType: "spot",
          items: [],
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
          .json(await cryptoDataHub.getOpenFuturesPositions());
      } catch (error) {
        legacyErrorResponse(response, error, "Gate futures positions failed", {
          marketType: "futures",
          settle: "usdt",
          positions: [],
          summary: {
            totalUnrealizedPnlUsd: "0.00",
            weightedPnlPct: "0.00",
            totalMarginUsd: "0.00",
            accountEquityUsd: "0.00",
            marginRatioPct: "0.00",
          },
        });
      }
    }
  );

  app.get(
    "/crypto/gate/futures/open-positions/stream",
    gateAccessMiddleware(),
    async (_request, response) => {
      await cryptoDataHub.subscribeOpenFuturesPositionsLegacy(response);
    }
  );

  app.get(
    "/crypto/gate/trade-records",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await cryptoDataHub.getTradeRecords({
            from: request.query?.from,
            to: request.query?.to,
            cursorTs: request.query?.cursorTs,
            limit: request.query?.limit,
            debugFeeFields: request.query?.debugFeeFields === "true",
          })
        );
      } catch (error) {
        legacyErrorResponse(response, error, "Gate trade records failed", {
          marketType: "all",
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
          await cryptoDataHub.getTradeRecordsFeeSummary({
            from: request.query?.from,
            to: request.query?.to,
            includeYear: request.query?.includeYear !== "false",
          })
        );
      } catch (error) {
        legacyErrorResponse(
          response,
          error,
          "Gate trade records fee summary failed",
          {
            totalFeeUsd: "0.00",
            yearTotalFeeUsd: "0.00",
            feeSources: {
              spotUsd: "0.00",
              futuresUsd: "0.00",
              gtUsd: "0.00",
              pointAmount: "0.00000000",
              unknownUsd: "0.00",
            },
          }
        );
      }
    }
  );

  app.get(
    "/crypto/gate/trade-records/stream",
    gateAccessMiddleware(),
    async (request, response) => {
      await cryptoDataHub.subscribeTradeRecordsLegacy(response, {
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
        response.status(200).json(
          await cryptoDataHub.getMarketCandles({
            pair: request.query?.pair || "BTC_USDT",
            range: request.query?.range || "1d",
            market: request.query?.market || "spot",
            beforeTs: request.query?.beforeTs,
            afterTs: request.query?.afterTs,
          })
        );
      } catch (error) {
        marketErrorResponse(
          request,
          response,
          error,
          "Gate market candles failed"
        );
      }
    }
  );

  app.get(
    "/crypto/gate/market/candles/stream",
    gateAccessMiddleware(),
    async (request, response) => {
      await cryptoDataHub.subscribeMarketCandlesLegacy(response, {
        pair: request.query?.pair || "BTC_USDT",
        range: request.query?.range || "1d",
        market: request.query?.market || "spot",
      });
    }
  );

  app.get(
    "/crypto/gate/trading-pair/detail",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await cryptoDataHub.getTradingPairDetail({
            pair: request.query?.pair || "BTC_USDT",
            market: request.query?.market || "spot",
          })
        );
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
        const {
          cryptoGateTopSpotAssetsService,
        } = require("../../utils/cryptoGate");
        response.status(200).json(
          await cryptoGateTopSpotAssetsService.topAssets({
            limit: request.query?.limit,
            exclude: request.query?.exclude,
            quote: request.query?.quote || "USDT",
          })
        );
      } catch (error) {
        legacyErrorResponse(response, error, "Gate top spot assets failed", {
          marketType: "spot",
          assets: [],
        });
      }
    }
  );

  app.get(
    "/crypto/gate/spot/btc-summary",
    gateAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await cryptoDataHub.getBtcSummary({
            range: request.query?.range || "1d",
          })
        );
      } catch (error) {
        legacyErrorResponse(response, error, "Gate BTC summary failed", {
          symbol: "BTC_USDT",
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
          hub: cryptoDataHub.getStatus(),
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
        await cryptoDataHub.getEquityHistory({ equityMode: "api_total" });
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
        const result = cryptoDataHub.start();
        response.status(200).json({
          success: true,
          config: safeConfigStatus(),
          ws: cryptoGateWsManager.status(),
          freshness: result.serviceDetails?.equity?.freshness || null,
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
        response.status(200).json(cryptoDataHub.stopIfIdle());
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

        response.status(200).json(
          await cryptoDataHub.getEquityHistory({
            equityMode: request.query?.equityMode,
            sinceTs: request.query?.sinceTs,
          })
        );
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
