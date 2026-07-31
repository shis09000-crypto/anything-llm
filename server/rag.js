const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "rag";

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
  getEmbeddingEngineSelection,
  getVectorDbClass,
} = require("./utils/helpers");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  secureDatabaseStart,
} = require("./utils/microModules");
const { serializableSearchOptions } = require("./utils/rag/remoteProvider");

const role = "rag";
const state = {
  ready: false,
  status: "starting",
  database: "pending",
  active: 0,
  completed: 0,
  failed: 0,
};

const host = new MicroModuleServiceHost({
  manifestId: "rag",
  role,
  port: Number(process.env.RAG_PORT || 3028),
  readiness: () => ({ ...state }),
  onStart: async () => {
    await secureDatabaseStart(role);
    state.database = "ready";
    state.status = "running";
    state.ready = true;
  },
  onDrain: async () => {
    state.ready = false;
    state.status = "draining";
    const deadline =
      Date.now() +
      Math.max(
        1_000,
        Number(process.env.ATHENA_RUNTIME_DRAIN_TIMEOUT_MS || 120_000)
      );
    while (state.active > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
  },
  registerRoutes: (app) => {
    app.get("/internal/v1/rag/dependencies", async (_request, response) => {
      const vectorDb = getVectorDbClass();
      const embedder = getEmbeddingEngineSelection();
      let vectorReady = false;
      let vectorReasonCode = null;
      try {
        await vectorDb.heartbeat();
        vectorReady = true;
      } catch (error) {
        vectorReasonCode = String(
          error?.code || error?.message || "vector_database_unavailable"
        ).slice(0, 160);
      }
      const embeddingReady =
        typeof embedder?.embedTextInput === "function" &&
        typeof embedder?.embedChunks === "function";
      response.json({
        success: true,
        ready: vectorReady && embeddingReady,
        dependencies: {
          vectorDatabase: {
            ready: vectorReady,
            reasonCode: vectorReasonCode,
          },
          embeddingProvider: {
            ready: embeddingReady,
            reasonCode: embeddingReady
              ? null
              : "embedding_provider_contract_invalid",
          },
        },
      });
    });
    app.post("/internal/v1/rag/retrieve", async (request, response) => {
      state.active += 1;
      try {
        const options = serializableSearchOptions(request.body || {});
        if (!options.namespace || !options.input)
          return response.status(400).json({
            success: false,
            error: "rag_request_invalid",
          });
        const vectorDb = getVectorDbClass();
        const embedder = getEmbeddingEngineSelection();
        const result = await vectorDb.performSimilaritySearch({
          ...options,
          LLMConnector: {
            embedTextInput: (input) => embedder.embedTextInput(input),
          },
        });
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

installStandaloneShutdown(host, { name: "Rag" });
host
  .start()
  .then((snapshot) => console.log(`[Rag] listening on ${host.port}`, snapshot))
  .catch((error) => {
    console.error("[Rag] failed to start", error);
    process.exitCode = 1;
  });
