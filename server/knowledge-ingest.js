const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "knowledge-ingest";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const { documentEndpoints } = require("./endpoints/document");
const { workspaceEndpoints } = require("./endpoints/workspaces");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  registerCompatibleApi,
  secureDatabaseStart,
} = require("./utils/microModules");
const { createApiScope } = require("./utils/microModules/scopedApi");

const role = "knowledge-ingest";
const state = {
  ready: false,
  status: "starting",
  database: "pending",
  acceptsNewWork: true,
};

const ingestApiScope = createApiScope({
  prefixes: ["/document"],
  patterns: [
    /^\/workspace\/[^/]+\/(?:upload|upload-link|update-embeddings)$/,
    /^\/workspace\/[^/]+\/(?:embed-progress|embed-queue)$/,
    /^\/workspace\/[^/]+\/(?:remove-and-unembed|reset-vector-db)$/,
  ],
});

const host = new MicroModuleServiceHost({
  manifestId: "knowledge-ingest",
  role,
  port: Number(process.env.KNOWLEDGE_INGEST_PORT || 3027),
  parseJson: false,
  readiness: () => ({ ...state }),
  onStart: async () => {
    await secureDatabaseStart(role);
    state.database = "ready";
    state.status = "running";
    state.ready = true;
  },
  onDrain: async () => {
    state.acceptsNewWork = false;
    state.ready = false;
    state.status = "draining";
  },
  registerRoutes: (app) => {
    registerCompatibleApi(app, (api) => {
      api.use(ingestApiScope);
      documentEndpoints(api);
      workspaceEndpoints(api);
    });
    app.post("/internal/v1/knowledge/ingest", (_request, response) => {
      response.status(405).json({
        success: false,
        error: "knowledge_ingest_uses_compatible_http_contract",
      });
    });
  },
});

installStandaloneShutdown(host, { name: "KnowledgeIngest" });
host
  .start()
  .then((snapshot) =>
    console.log(`[KnowledgeIngest] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[KnowledgeIngest] failed to start", error);
    process.exitCode = 1;
  });
