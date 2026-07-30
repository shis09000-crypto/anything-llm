const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "crypto-market";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const {
  executeCryptoMarketSnapshot,
  executeCryptoPrice,
} = require("./utils/agents/aibitat/plugins/crypto-market");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
} = require("./utils/microModules");

const state = { accepting: true, active: 0, completed: 0, failed: 0 };
const handlers = {
  crypto_price: executeCryptoPrice,
  crypto_market_snapshot: executeCryptoMarketSnapshot,
};

const host = new MicroModuleServiceHost({
  manifestId: "crypto-market",
  role: "crypto-market",
  port: Number(process.env.CRYPTO_MARKET_PORT || 3020),
  readiness: () => ({ ...state }),
  onDrain: async () => {
    state.accepting = false;
    const deadline =
      Date.now() +
      Number(process.env.ATHENA_RUNTIME_DRAIN_TIMEOUT_MS || 120_000);
    while (state.active > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
  },
  registerRoutes: (app) => {
    app.post("/internal/v1/crypto/market", async (request, response) => {
      const toolName = String(request.body?.toolName || "");
      const execute = handlers[toolName];
      if (!execute)
        return response.status(400).json({
          success: false,
          error: "crypto_market_tool_denied",
        });
      state.active += 1;
      try {
        const result = await execute(request.body?.args || {});
        state.completed += 1;
        return response.json({ success: true, result });
      } catch (error) {
        state.failed += 1;
        throw error;
      } finally {
        state.active = Math.max(0, state.active - 1);
      }
    });
  },
});

installStandaloneShutdown(host, { name: "CryptoMarket" });
host
  .start()
  .then((snapshot) =>
    console.log(`[CryptoMarket] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[CryptoMarket] failed to start", error);
    process.exitCode = 1;
  });
