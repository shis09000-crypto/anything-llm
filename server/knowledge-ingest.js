const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });
const express = require("express");

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
const { DataAccessCenter } = require("./utils/dataAccess");
const { CollectorApi } = require("./utils/collectorApi");
const {
  assertDocumentPipelineStorage,
} = require("./utils/files/storageWriteContract");
const { resumeActiveBatchJobs } = require("./utils/DocumentEmbeddingBatch");
const {
  recomputeKnowledgeMetrics,
} = require("./utils/knowledgeGraph/metricsCapabilityClient");

const Workspace = DataAccessCenter.workspace;
const User = DataAccessCenter.user;
const Document = DataAccessCenter.document;

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
    /^\/workspace\/[^/]+\/(?:upload|upload-and-embed|upload-link|update-embeddings)$/,
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
    assertDocumentPipelineStorage({ includeUploadHotdir: true });
    await secureDatabaseStart(role);
    await resumeActiveBatchJobs();
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
    app.post(
      "/internal/v1/knowledge/browser-ingest",
      express.json({ limit: "256kb" }),
      async (request, response) => {
        const userId = Number(request.body?.userId);
        const workspaceId = Number(request.body?.workspaceId);
        const textContent = String(request.body?.textContent || "").trim();
        if (
          !Number.isSafeInteger(userId) ||
          !Number.isSafeInteger(workspaceId) ||
          !textContent
        )
          return response.status(400).json({
            success: false,
            error: "browser_knowledge_ingest_input_invalid",
          });
        const user = await User.get({ id: userId });
        if (!user)
          return response.status(403).json({
            success: false,
            error: "browser_knowledge_workspace_denied",
          });
        const workspace = await Workspace.getWithUser(user, {
          id: workspaceId,
        });
        if (!workspace)
          return response.status(403).json({
            success: false,
            error: "browser_knowledge_workspace_denied",
          });
        const collector = new CollectorApi();
        const parsed = await collector.processRawText(textContent, {
          ...(request.body?.metadata || {}),
          docSource: "Athena Browser Plane",
        });
        if (!parsed?.success || !parsed.documents?.[0]?.location)
          return response.status(502).json({
            success: false,
            error: "browser_knowledge_collector_failed",
          });
        const embedded = await Document.addDocuments(
          workspace,
          [parsed.documents[0].location],
          user.id
        );
        if (embedded.failedToEmbed?.length)
          return response.status(500).json({
            success: false,
            error: "browser_knowledge_embedding_failed",
          });
        return response.json({
          success: true,
          result: {
            workspaceId,
            documentLocation: parsed.documents[0].location,
            status: embedded.batchJob ? "processing" : "completed",
            batchJobId: embedded.batchJob?.jobId || null,
          },
        });
      }
    );
    app.post(
      "/internal/v1/knowledge/metrics/recompute",
      express.json({ limit: "16kb" }),
      async (request, response) => {
        const batchSize = Math.max(
          1,
          Math.min(Number(request.body?.batchSize) || 200, 1_000)
        );
        const lockTtlMs = Math.max(
          60_000,
          Math.min(Number(request.body?.lockTtlMs) || 900_000, 3_600_000)
        );
        const result = await recomputeKnowledgeMetrics({
          trigger: String(request.body?.trigger || "worker").slice(0, 64),
          batchSize,
          lockTtlMs,
        });
        return response.status(200).json({ success: true, result });
      }
    );
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
