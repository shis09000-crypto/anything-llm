const { User } = require("../models/user");
const { SystemSettings } = require("../models/systemSettings");
const { decodeJWT, reqBody, safeJsonParse } = require("../utils/http");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  cryptoCenterSnapshot,
  cryptoCenterDelta,
} = require("../utils/cryptoCenter/mockSnapshot");

const CRYPTO_COMPONENT_EXPERIMENT_CONFIG_KEY =
  "anythingllm_crypto_trading_pair_detail_config_v1";
const ASSET_ALLOCATION_DONUT_CONFIG_KEY =
  "anythingllm_crypto_asset_allocation_donut_config_v1";
const OPEN_FUTURES_POSITIONS_CONFIG_KEY =
  "anythingllm_crypto_open_futures_positions_config_v1";
const TRADE_RECORDS_CONFIG_KEY = "anythingllm_crypto_trade_records_config_v1";
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

function cryptoCenterAccessMiddleware(roles = [ROLES.admin]) {
  const roleCheck = flexUserRoleValid(roles);
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

function sendSocket(socket, payload) {
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify(payload));
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function isCryptoSocketAuthorized(request) {
  if (isCryptoCenterDevAuthBypassEnabled(request)) return true;

  const multiUserMode = await SystemSettings.isMultiUserMode();
  if (!multiUserMode) return true;

  const rawToken =
    request.query?.token ||
    request.headers?.authorization?.replace(/^Bearer\s+/i, "");
  const token = rawToken ? decodeURIComponent(String(rawToken)) : null;
  if (!token) return false;

  const valid = decodeJWT(token);
  if (!valid?.id) return false;

  const user = await User.get({ id: valid.id });
  return user?.role === ROLES.admin && !user?.suspended;
}

function cryptoCenterEndpoints(app) {
  if (!app) return;

  app.get(
    "/crypto-component-experiment/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (_request, response) => {
      try {
        const setting = await SystemSettings.get({
          label: CRYPTO_COMPONENT_EXPERIMENT_CONFIG_KEY,
        });
        response.status(200).json({
          success: true,
          config: safeJsonParse(setting?.value, null),
        });
      } catch (error) {
        console.error(
          "[crypto-component-experiment] Failed to load config",
          error
        );
        response.status(500).json({
          success: false,
          error: "failed_to_load_crypto_component_experiment_config",
        });
      }
    }
  );

  app.post(
    "/crypto-component-experiment/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (request, response) => {
      try {
        const body = reqBody(request);
        const config = body?.config;
        if (!isRecord(config)) {
          response.status(400).json({
            success: false,
            error: "invalid_crypto_component_experiment_config",
          });
          return;
        }

        const result = await SystemSettings._updateSettings({
          [CRYPTO_COMPONENT_EXPERIMENT_CONFIG_KEY]: JSON.stringify(config),
        });
        if (result.error) throw new Error(result.error);

        response.status(200).json({ success: true, error: null });
      } catch (error) {
        console.error(
          "[crypto-component-experiment] Failed to save config",
          error
        );
        response.status(500).json({
          success: false,
          error: "failed_to_save_crypto_component_experiment_config",
        });
      }
    }
  );

  app.delete(
    "/crypto-component-experiment/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (_request, response) => {
      try {
        await SystemSettings.delete({
          label: CRYPTO_COMPONENT_EXPERIMENT_CONFIG_KEY,
        });
        response.status(200).json({ success: true, error: null });
      } catch (error) {
        console.error(
          "[crypto-component-experiment] Failed to delete config",
          error
        );
        response.status(500).json({
          success: false,
          error: "failed_to_delete_crypto_component_experiment_config",
        });
      }
    }
  );

  app.get(
    "/crypto-component-experiment/asset-allocation-donut/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (_request, response) => {
      try {
        const setting = await SystemSettings.get({
          label: ASSET_ALLOCATION_DONUT_CONFIG_KEY,
        });
        response.status(200).json({
          success: true,
          config: safeJsonParse(setting?.value, null),
        });
      } catch (error) {
        console.error("[asset-allocation-donut] Failed to load config", error);
        response.status(500).json({
          success: false,
          error: "failed_to_load_asset_allocation_donut_config",
        });
      }
    }
  );

  app.post(
    "/crypto-component-experiment/asset-allocation-donut/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (request, response) => {
      try {
        const body = reqBody(request);
        const config = body?.config;
        if (!isRecord(config)) {
          response.status(400).json({
            success: false,
            error: "invalid_asset_allocation_donut_config",
          });
          return;
        }

        const result = await SystemSettings._updateSettings({
          [ASSET_ALLOCATION_DONUT_CONFIG_KEY]: JSON.stringify(config),
        });
        if (result.error) throw new Error(result.error);

        response.status(200).json({ success: true, error: null });
      } catch (error) {
        console.error("[asset-allocation-donut] Failed to save config", error);
        response.status(500).json({
          success: false,
          error: "failed_to_save_asset_allocation_donut_config",
        });
      }
    }
  );

  app.delete(
    "/crypto-component-experiment/asset-allocation-donut/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (_request, response) => {
      try {
        await SystemSettings.delete({
          label: ASSET_ALLOCATION_DONUT_CONFIG_KEY,
        });
        response.status(200).json({ success: true, error: null });
      } catch (error) {
        console.error(
          "[asset-allocation-donut] Failed to delete config",
          error
        );
        response.status(500).json({
          success: false,
          error: "failed_to_delete_asset_allocation_donut_config",
        });
      }
    }
  );

  app.get(
    "/crypto-component-experiment/open-futures-positions/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (_request, response) => {
      try {
        const setting = await SystemSettings.get({
          label: OPEN_FUTURES_POSITIONS_CONFIG_KEY,
        });
        response.status(200).json({
          success: true,
          config: safeJsonParse(setting?.value, null),
        });
      } catch (error) {
        console.error("[open-futures-positions] Failed to load config", error);
        response.status(500).json({
          success: false,
          error: "failed_to_load_open_futures_positions_config",
        });
      }
    }
  );

  app.post(
    "/crypto-component-experiment/open-futures-positions/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (request, response) => {
      try {
        const body = reqBody(request);
        const config = body?.config;
        if (!isRecord(config)) {
          response.status(400).json({
            success: false,
            error: "invalid_open_futures_positions_config",
          });
          return;
        }

        const result = await SystemSettings._updateSettings({
          [OPEN_FUTURES_POSITIONS_CONFIG_KEY]: JSON.stringify(config),
        });
        if (result.error) throw new Error(result.error);

        response.status(200).json({ success: true, error: null });
      } catch (error) {
        console.error("[open-futures-positions] Failed to save config", error);
        response.status(500).json({
          success: false,
          error: "failed_to_save_open_futures_positions_config",
        });
      }
    }
  );

  app.delete(
    "/crypto-component-experiment/open-futures-positions/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (_request, response) => {
      try {
        await SystemSettings.delete({
          label: OPEN_FUTURES_POSITIONS_CONFIG_KEY,
        });
        response.status(200).json({ success: true, error: null });
      } catch (error) {
        console.error(
          "[open-futures-positions] Failed to delete config",
          error
        );
        response.status(500).json({
          success: false,
          error: "failed_to_delete_open_futures_positions_config",
        });
      }
    }
  );

  app.get(
    "/crypto-component-experiment/trade-records/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (_request, response) => {
      try {
        const setting = await SystemSettings.get({
          label: TRADE_RECORDS_CONFIG_KEY,
        });
        response.status(200).json({
          success: true,
          config: safeJsonParse(setting?.value, null),
        });
      } catch (error) {
        console.error("[trade-records] Failed to load config", error);
        response.status(500).json({
          success: false,
          error: "failed_to_load_trade_records_config",
        });
      }
    }
  );

  app.post(
    "/crypto-component-experiment/trade-records/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (request, response) => {
      try {
        const body = reqBody(request);
        const config = body?.config;
        if (!isRecord(config)) {
          response.status(400).json({
            success: false,
            error: "invalid_trade_records_config",
          });
          return;
        }

        const result = await SystemSettings._updateSettings({
          [TRADE_RECORDS_CONFIG_KEY]: JSON.stringify(config),
        });
        if (result.error) throw new Error(result.error);

        response.status(200).json({ success: true, error: null });
      } catch (error) {
        console.error("[trade-records] Failed to save config", error);
        response.status(500).json({
          success: false,
          error: "failed_to_save_trade_records_config",
        });
      }
    }
  );

  app.delete(
    "/crypto-component-experiment/trade-records/config",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (_request, response) => {
      try {
        await SystemSettings.delete({
          label: TRADE_RECORDS_CONFIG_KEY,
        });
        response.status(200).json({ success: true, error: null });
      } catch (error) {
        console.error("[trade-records] Failed to delete config", error);
        response.status(500).json({
          success: false,
          error: "failed_to_delete_trade_records_config",
        });
      }
    }
  );

  app.get(
    "/crypto-center/snapshot",
    cryptoCenterAccessMiddleware([ROLES.admin]),
    async (request, response) => {
      try {
        const range = request.query?.range || "24h";
        response.status(200).json({
          success: true,
          snapshot: cryptoCenterSnapshot(range),
        });
      } catch (error) {
        console.error("[crypto-center] Failed to create snapshot", error);
        response.status(500).json({
          success: false,
          error: "failed_to_create_crypto_center_snapshot",
        });
      }
    }
  );

  if (typeof app.ws !== "function") return;

  app.ws("/crypto-center/stream", async (socket, request) => {
    let interval = null;
    try {
      const authorized = await isCryptoSocketAuthorized(request);
      if (!authorized) {
        socket.close();
        return;
      }

      const range = request.query?.range || "24h";
      const snapshot = cryptoCenterSnapshot(range);
      let tick = 0;

      sendSocket(socket, { type: "snapshot", data: snapshot });
      interval = setInterval(() => {
        tick += 1;
        for (const event of cryptoCenterDelta(snapshot, tick)) {
          sendSocket(socket, event);
        }
      }, 2_500);

      socket.on("close", () => {
        if (interval) clearInterval(interval);
      });
      socket.on("error", () => {
        if (interval) clearInterval(interval);
      });
    } catch (error) {
      console.error("[crypto-center] WebSocket stream failed", error);
      if (interval) clearInterval(interval);
      socket.close();
    }
  });
}

module.exports = {
  cryptoCenterEndpoints,
};
