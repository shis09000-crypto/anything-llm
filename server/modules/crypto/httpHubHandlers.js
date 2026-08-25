const { cryptoDataHub } = require("../../utils/cryptoHub");
const { safeErrorMessage } = require("../../utils/cryptoGate");
const {
  flexUserRoleValid,
  ROLES,
} = require("../../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");

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

function cryptoHubAccessMiddleware() {
  const roleCheck = flexUserRoleValid([ROLES.admin]);
  return [
    async (request, response, next) => {
      if (isCryptoCenterDevAuthBypassEnabled(request)) {
        response.locals.multiUserMode = false;
        response.locals.cryptoCenterDevBypass = true;
        return next();
      }
      return validatedRequest(request, response, (error) => {
        if (error) return next(error);
        return roleCheck(request, response, next);
      });
    },
    async (_request, response, next) => {
      try {
        if (response.locals.cryptoCenterDevBypass) {
          response.locals.cryptoDataHub = cryptoDataHub;
          return next();
        }
        const {
          resolveCryptoHubForHttp,
        } = require("../../utils/cryptoAccount");
        const resolved = await resolveCryptoHubForHttp(response.locals.user);
        response.locals.cryptoDataHub = resolved.hub;
        response.locals.cryptoDataHubMode = resolved.mode;
        return next();
      } catch (error) {
        return response.status(403).json({
          success: false,
          safeErrorMessage: safeErrorMessage(
            error.code || "crypto_account_unavailable"
          ),
        });
      }
    },
  ];
}

function errorResponse(response, error, fallback, extra = {}) {
  response.status(error?.code?.startsWith?.("unsupported") ? 400 : 500).json({
    success: false,
    asOf: Date.now(),
    connectionStatus: "disconnected",
    safeErrorMessage: safeErrorMessage(error?.message || fallback),
    ...extra,
  });
}

function cryptoHubEndpoints(app) {
  if (!app) return;

  app.get("/crypto-hub/status", cryptoHubAccessMiddleware(), (_req, res) => {
    res.status(200).json(res.locals.cryptoDataHub.getStatus());
  });

  app.get(
    "/crypto-hub/loading-progress",
    cryptoHubAccessMiddleware(),
    (_req, res) => {
      res.status(200).json(res.locals.cryptoDataHub.getLoadingProgress());
    }
  );

  app.post(
    "/crypto-hub/init",
    cryptoHubAccessMiddleware(),
    async (_req, res) => {
      try {
        res.status(200).json(await res.locals.cryptoDataHub.init());
      } catch (error) {
        errorResponse(res, error, "Crypto Hub init failed");
      }
    }
  );

  app.get(
    "/crypto-hub/dashboard-snapshot",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      try {
        if (
          typeof response.locals.cryptoDataHub.dashboardSnapshot !== "function"
        ) {
          const error = new Error("crypto_dashboard_account_scope_required");
          error.code = "crypto_dashboard_account_scope_required";
          throw error;
        }
        response.status(200).json(
          await response.locals.cryptoDataHub.dashboardSnapshot({
            force: request.query?.force === "true",
          })
        );
      } catch (error) {
        errorResponse(response, error, "Crypto dashboard snapshot failed", {
          portfolio: null,
          risk: null,
        });
      }
    }
  );

  app.get(
    "/crypto-hub/dashboard-stream",
    cryptoHubAccessMiddleware(),
    async (_request, response) => {
      try {
        if (
          typeof response.locals.cryptoDataHub.subscribeDashboard !== "function"
        ) {
          throw new Error("crypto_dashboard_account_scope_required");
        }
        await response.locals.cryptoDataHub.subscribeDashboard(response);
      } catch (error) {
        if (response.headersSent) {
          response.write("event: error\n");
          response.write(
            `data: ${JSON.stringify({
              success: false,
              safeErrorMessage: safeErrorMessage(error),
            })}\n\n`
          );
          response.end();
          return;
        }
        errorResponse(response, error, "Crypto dashboard stream failed");
      }
    }
  );

  app.post(
    "/crypto-hub/rebalance-simulation",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      try {
        if (
          typeof response.locals.cryptoDataHub.rebalanceSimulation !==
          "function"
        ) {
          throw new Error("crypto_dashboard_account_scope_required");
        }
        response
          .status(200)
          .json(
            await response.locals.cryptoDataHub.rebalanceSimulation(
              request.body?.targets || {}
            )
          );
      } catch (error) {
        const status =
          error?.code === "crypto_rebalance_targets_invalid" ? 400 : 500;
        response.status(status).json({
          success: false,
          readOnly: true,
          safeErrorMessage: safeErrorMessage(error),
        });
      }
    }
  );

  app.get(
    "/crypto-hub/portfolio-performance",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      try {
        if (
          !response.locals.cryptoDataHub?.accountScoped ||
          typeof response.locals.cryptoDataHub.portfolioPerformance !==
            "function"
        ) {
          return response.status(503).json({
            success: false,
            safeErrorMessage: "crypto_account_dashboard_unavailable",
          });
        }
        return response.status(200).json(
          await response.locals.cryptoDataHub.portfolioPerformance({
            window: request.query.window || "30d",
          })
        );
      } catch (error) {
        return response.status(error?.code ? 400 : 503).json({
          success: false,
          safeErrorMessage: String(
            error?.code || "crypto_portfolio_performance_failed"
          ),
        });
      }
    }
  );

  app.get(
    "/crypto-hub/equity-history",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      try {
        const window = request.query?.window || "today";
        if (!["today", "7d", "30d", "90d", "365d"].includes(window)) {
          response.status(400).json({
            success: false,
            error: "Unsupported equity history window.",
          });
          return;
        }
        response.status(200).json(
          await response.locals.cryptoDataHub.getEquityHistory({
            window,
            equityMode: request.query?.equityMode,
            sinceTs: request.query?.sinceTs,
          })
        );
      } catch (error) {
        errorResponse(response, error, "Crypto Hub equity history failed");
      }
    }
  );

  app.get(
    "/crypto-hub/allocation",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await response.locals.cryptoDataHub.getAllocation({
            quote: request.query?.quote || "USDT",
          })
        );
      } catch (error) {
        errorResponse(response, error, "Crypto Hub allocation failed", {
          items: [],
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );

  app.get(
    "/crypto-hub/open-futures-positions",
    cryptoHubAccessMiddleware(),
    async (_request, response) => {
      try {
        response
          .status(200)
          .json(await response.locals.cryptoDataHub.getOpenFuturesPositions());
      } catch (error) {
        errorResponse(response, error, "Crypto Hub open futures failed", {
          exchange: "gate",
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
          partialFailures: [],
        });
      }
    }
  );

  app.get(
    "/crypto-hub/top-assets",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await response.locals.cryptoDataHub.getTopAssets({
            limit: request.query?.limit,
            exclude: request.query?.exclude,
            quote: request.query?.quote || "USDT",
          })
        );
      } catch (error) {
        errorResponse(response, error, "Crypto Hub top assets failed", {
          exchange: "gate",
          marketType: "spot",
          assets: [],
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );

  app.get(
    "/crypto-hub/open-futures-positions/stream",
    cryptoHubAccessMiddleware(),
    async (_request, response) => {
      await response.locals.cryptoDataHub.subscribeOpenFuturesPositions(
        response
      );
    }
  );

  app.get(
    "/crypto-hub/market-candles",
    cryptoHubAccessMiddleware(),
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
            error?.message || "Crypto Hub market candles failed"
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
    "/crypto-hub/market-candles/stream",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      await cryptoDataHub.subscribeMarketCandles(response, {
        pair: request.query?.pair || "BTC_USDT",
        range: request.query?.range || "1d",
        market: request.query?.market || "spot",
      });
    }
  );

  app.get(
    "/crypto-hub/trade-records",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await response.locals.cryptoDataHub.getTradeRecords({
            from: request.query?.from,
            to: request.query?.to,
            cursorTs: request.query?.cursorTs,
            limit: request.query?.limit,
            debugFeeFields: request.query?.debugFeeFields === "true",
          })
        );
      } catch (error) {
        errorResponse(response, error, "Crypto Hub trade records failed", {
          exchange: "gate",
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
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );

  app.get(
    "/crypto-hub/trade-records/fee-summary",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await response.locals.cryptoDataHub.getTradeRecordsFeeSummary({
            from: request.query?.from,
            to: request.query?.to,
            includeYear: request.query?.includeYear !== "false",
          })
        );
      } catch (error) {
        errorResponse(
          response,
          error,
          "Crypto Hub trade records fee summary failed",
          {
            exchange: "gate",
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
          }
        );
      }
    }
  );

  app.get(
    "/crypto-hub/trade-records/stream",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      await response.locals.cryptoDataHub.subscribeTradeRecords(response, {
        from: request.query?.from,
        to: request.query?.to,
        limit: request.query?.limit,
      });
    }
  );

  app.get(
    "/crypto-hub/trading-pair-detail",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await response.locals.cryptoDataHub.getTradingPairDetail({
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
            error?.message || "Crypto Hub trading pair detail failed"
          ),
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );

  app.get(
    "/crypto-hub/btc-summary",
    cryptoHubAccessMiddleware(),
    async (request, response) => {
      try {
        response.status(200).json(
          await response.locals.cryptoDataHub.getBtcSummary({
            range: request.query?.range || "1d",
          })
        );
      } catch (error) {
        errorResponse(response, error, "Crypto Hub BTC summary failed", {
          exchange: "gate",
          symbol: "BTC_USDT",
          partialFailures: Array.isArray(error?.partialFailures)
            ? error.partialFailures
            : [],
        });
      }
    }
  );
}

module.exports = {
  cryptoHubEndpoints,
};
