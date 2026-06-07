const {
  cryptoGateEventBuffer,
  cryptoGateBtcSpotSummaryService,
  cryptoGateEquityHistoryService,
  cryptoGateMarketCandlesService,
  cryptoGateMarketStreamManager,
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

function cryptoGateProbeEndpoints(app) {
  if (!app) return;

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
