const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "tool-broker";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const {
  agentSkillWhitelistEndpoints,
} = require("./endpoints/agentSkillWhitelist");
const { agentSkillsFromSystemSettings } = require("./utils/agents/defaults");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  registerCompatibleApi,
  secureDatabaseStart,
} = require("./utils/microModules");
const {
  BROWSER_TOOLS,
  dispatchBrowser,
  dispatchCryptoAccount,
} = require("./utils/toolRuntime/broker");

const state = {
  accepting: true,
  active: 0,
  completed: 0,
  failed: 0,
};

async function invoke(request = {}) {
  if (!state.accepting) {
    const error = new Error("tool_broker_draining");
    error.httpStatus = 503;
    throw error;
  }
  state.active += 1;
  try {
    const result = BROWSER_TOOLS.has(String(request.toolName || ""))
      ? await dispatchBrowser(request)
      : await dispatchCryptoAccount(request);
    state.completed += 1;
    return result;
  } catch (error) {
    state.failed += 1;
    throw error;
  } finally {
    state.active = Math.max(0, state.active - 1);
  }
}

const role = "tool-broker";
const host = new MicroModuleServiceHost({
  manifestId: "tool-runtime",
  role,
  port: Number(process.env.TOOL_BROKER_PORT || 3019),
  parseJson: false,
  readiness: () => ({ ...state }),
  onStart: () => secureDatabaseStart(role),
  onDrain: async () => {
    state.accepting = false;
    const deadline =
      Date.now() +
      Number(process.env.ATHENA_RUNTIME_DRAIN_TIMEOUT_MS || 120_000);
    while (state.active > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
  },
  registerRoutes: (app) => {
    registerCompatibleApi(app, agentSkillWhitelistEndpoints);
    app.get("/internal/v1/tools/catalog", async (_request, response) => {
      const functions = await agentSkillsFromSystemSettings(null, {
        registryMode: true,
      });
      response.json({
        success: true,
        functions,
        conditional: ["crypto-account-agent", "browser-agent"],
      });
    });
    app.post("/internal/v1/tools/invoke", async (request, response) => {
      const result = await invoke(request.body || {});
      response.json({ success: true, result });
    });
  },
});

installStandaloneShutdown(host, { name: "ToolBroker" });
host
  .start()
  .then((snapshot) =>
    console.log(`[ToolBroker] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[ToolBroker] failed to start", error);
    process.exitCode = 1;
  });
