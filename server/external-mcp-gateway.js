const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });
const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "external-mcp-gateway";

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
  MicroModuleServiceHost,
  installStandaloneShutdown,
} = require("./utils/microModules");
const {
  registerExternalMcpGatewayRoutes,
} = require("./utils/externalMcp/gateway");

const host = new MicroModuleServiceHost({
  manifestId: "external-mcp-gateway",
  role: "external-mcp-gateway",
  port: Number(process.env.EXTERNAL_MCP_GATEWAY_PORT || 3043),
  parseJson: true,
  jsonLimit: "160kb",
  readiness: () => ({
    enabled:
      String(process.env.ATHENA_EXTERNAL_MCP_ENABLED || "false") === "true",
  }),
  registerRoutes: (app) => {
    registerExternalMcpGatewayRoutes(app);
  },
});

installStandaloneShutdown(host, { name: "ExternalMcpGateway" });
host
  .start()
  .then(() => console.log(`[ExternalMcpGateway] listening on ${host.port}`))
  .catch((error) => {
    console.error("[ExternalMcpGateway] failed to start", error);
    process.exitCode = 1;
  });
