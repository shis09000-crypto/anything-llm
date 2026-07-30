const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "crypto-account";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const { registerCryptoHubRoutes } = require("./modules/crypto/httpAdapter");
const { accountCryptoHubRegistry } = require("./utils/cryptoAccount");
const { invokeAccountTool } = require("./utils/cryptoAccount/serviceRuntime");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  registerCompatibleApi,
  secureDatabaseStart,
} = require("./utils/microModules");

const state = {
  accepting: true,
  active: 0,
  completed: 0,
  denied: 0,
  failed: 0,
};

const role = "crypto-account";
const host = new MicroModuleServiceHost({
  manifestId: "crypto-account-access",
  role,
  port: Number(process.env.CRYPTO_ACCOUNT_PORT || 3021),
  parseJson: false,
  readiness: () => ({
    ...state,
    privateHubCount: accountCryptoHubRegistry.size(),
  }),
  onStart: () => secureDatabaseStart(role),
  onDrain: async () => {
    state.accepting = false;
    const deadline =
      Date.now() +
      Number(process.env.ATHENA_RUNTIME_DRAIN_TIMEOUT_MS || 120_000);
    while (state.active > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    accountCryptoHubRegistry.clear();
  },
  registerRoutes: (app) => {
    registerCompatibleApi(app, registerCryptoHubRoutes);
    app.post("/internal/v1/crypto/account/read", async (request, response) => {
      if (!state.accepting) {
        return response.status(503).json({
          success: false,
          error: "crypto_account_draining",
        });
      }
      state.active += 1;
      try {
        const result = await invokeAccountTool(request.body || {});
        state.completed += 1;
        return response.json({ success: true, result });
      } catch (error) {
        if (
          error?.httpStatus === 403 ||
          String(error?.code || "").includes("denied")
        )
          state.denied += 1;
        else state.failed += 1;
        throw error;
      } finally {
        state.active = Math.max(0, state.active - 1);
      }
    });
  },
});

installStandaloneShutdown(host, { name: "CryptoAccount" });
host
  .start()
  .then((snapshot) =>
    console.log(`[CryptoAccount] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[CryptoAccount] failed to start", error);
    process.exitCode = 1;
  });
