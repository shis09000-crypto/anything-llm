const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "key-custody";
process.env.ATHENA_KEY_CUSTODY_CUTOVER = "false";

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
  auditKeyDescriptor,
  custodyStatus,
  mcpAccessTokenDescriptor,
  signAuditCheckpoint,
  signMcpAccessToken,
  unwrapMaterial,
  wrapMaterial,
} = require("./utils/security/keyCustody/serviceRuntime");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  secureDatabaseStart,
} = require("./utils/microModules");

const state = {
  accepting: true,
  active: 0,
  wrapped: 0,
  unwrapped: 0,
  auditDescribed: 0,
  auditSigned: 0,
  denied: 0,
  failed: 0,
};

function execute(operation, request, response) {
  if (!state.accepting) {
    return response.status(503).json({
      success: false,
      error: "key_custody_draining",
    });
  }
  state.active += 1;
  try {
    const result = operation(request.body || {}, {
      caller: response.locals.serviceCaller,
      env: process.env,
    });
    if (operation === wrapMaterial) state.wrapped += 1;
    else if (operation === unwrapMaterial) state.unwrapped += 1;
    else if (operation === auditKeyDescriptor) state.auditDescribed += 1;
    else if (operation === signAuditCheckpoint) state.auditSigned += 1;
    return response.json({ success: true, ...result });
  } catch (error) {
    if (error?.httpStatus === 403) state.denied += 1;
    else state.failed += 1;
    throw error;
  } finally {
    state.active = Math.max(0, state.active - 1);
  }
}

const role = "key-custody";
const host = new MicroModuleServiceHost({
  manifestId: "key-custody",
  role,
  port: Number(process.env.KEY_CUSTODY_PORT || 3023),
  parseJson: true,
  jsonLimit: "128kb",
  readiness: () => ({ ...state, custody: custodyStatus() }),
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
    app.post("/internal/v1/keys/wrap", (request, response) =>
      execute(wrapMaterial, request, response)
    );
    app.post("/internal/v1/keys/unwrap", (request, response) =>
      execute(unwrapMaterial, request, response)
    );
    app.post("/internal/v1/keys/audit-descriptor", (request, response) =>
      execute(auditKeyDescriptor, request, response)
    );
    app.post("/internal/v1/keys/audit-sign", (request, response) =>
      execute(signAuditCheckpoint, request, response)
    );
    app.post("/internal/v1/keys/mcp-token-descriptor", (request, response) =>
      execute(mcpAccessTokenDescriptor, request, response)
    );
    app.post("/internal/v1/keys/mcp-token-sign", (request, response) =>
      execute(signMcpAccessToken, request, response)
    );
    app.get("/internal/v1/keys/status", (_request, response) =>
      response.json({ success: true, ...custodyStatus() })
    );
  },
});

installStandaloneShutdown(host, { name: "KeyCustody" });
host
  .start()
  .then((snapshot) =>
    console.log(`[KeyCustody] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[KeyCustody] failed to start", error);
    process.exitCode = 1;
  });
