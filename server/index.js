const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });
const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
const {
  shutdownOpenTelemetry,
  startOpenTelemetry,
} = require("./utils/observability");
startOpenTelemetry();
const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();
const { startSecurityBootstrap } = require("./utils/security/keyLifecycle");
const { quarantineMiddleware } = require("./utils/security/keyRuntimeState");
startSecurityBootstrap({
  runtimeRole: process.env.ATHENA_RUNTIME_ROLE || "api",
  allowGenerate:
    process.env.ATHENA_KEY_AUTO_BOOTSTRAP === "true" ||
    process.env.NODE_ENV === "development",
});

const {
  ensureVectorProviderPersistenceDefaults,
  hydrateProviderSettingsBackup,
} = require("./utils/helpers/updateENV");
require("./utils/logger")();
hydrateProviderSettingsBackup();
ensureVectorProviderPersistenceDefaults();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { reqBody } = require("./utils/http");
const { systemEndpoints } = require("./endpoints/system");
const { systemPatrolEndpoints } = require("./endpoints/systemPatrol");
const { realtimeAuthEndpoints } = require("./endpoints/realtimeAuth");
const {
  characterPerformanceEndpoints,
} = require("./endpoints/characterPerformance");
const {
  runtimeDiagnosticsEndpoints,
} = require("./endpoints/runtimeDiagnostics");
const { authPasskeyEndpoints } = require("./endpoints/authPasskeys");
const {
  authTrustedDeviceEndpoints,
} = require("./endpoints/authTrustedDevices");
const { authZkLoginEndpoints } = require("./endpoints/authZkLogin");
const {
  authSessionRecoveryEndpoints,
} = require("./endpoints/authSessionRecovery");
const {
  deviceBindingRecoveryEndpoints,
} = require("./endpoints/deviceBindingRecovery");
const {
  drainWorkspaceDeleteJobs,
  workspaceEndpoints,
} = require("./endpoints/workspaces");
const { workspaceHealthEndpoints } = require("./endpoints/workspaceHealth");
const { workspaceOverviewEndpoints } = require("./endpoints/workspaceOverview");
const {
  workspaceCognitionEndpoints,
} = require("./endpoints/workspaceCognition");
const {
  workspaceMeetingDelegateEndpoints,
} = require("./endpoints/workspaceMeetingDelegate");
const { nodeSupplementEndpoints } = require("./endpoints/nodeSupplements");
const {
  workspaceSupplementEndpoints,
} = require("./endpoints/workspaceSupplements");
const {
  workspaceVisualAssetEndpoints,
} = require("./endpoints/workspaceVisualAssets");
const { mindMapEndpoints } = require("./endpoints/mindMaps");
const { quizEndpoints } = require("./endpoints/quiz");
const { knowledgeGraphEndpoints } = require("./endpoints/knowledgeGraph");
const { chatEndpoints } = require("./endpoints/chat");
const { embeddedEndpoints } = require("./endpoints/embed");
const { embedManagementEndpoints } = require("./endpoints/embedManagement");
const { getVectorDbClass } = require("./utils/helpers");
const { adminEndpoints } = require("./endpoints/admin");
const { inviteEndpoints } = require("./endpoints/invite");
const { utilEndpoints } = require("./endpoints/utils");
const { developerEndpoints } = require("./endpoints/api");
const { extensionEndpoints } = require("./endpoints/extensions");
const { bootHTTP, bootSSL } = require("./utils/boot");
const { workspaceThreadEndpoints } = require("./endpoints/workspaceThreads");
const { documentEndpoints } = require("./endpoints/document");
const { agentWebsocket } = require("./endpoints/agentWebsocket");
const {
  agentSkillWhitelistEndpoints,
} = require("./endpoints/agentSkillWhitelist");
const { agentFileServerEndpoints } = require("./endpoints/agentFileServer");
const { experimentalEndpoints } = require("./endpoints/experimental");
const { browserExtensionEndpoints } = require("./endpoints/browserExtension");
const { browserEndpoints } = require("./endpoints/browser");
const { communityHubEndpoints } = require("./endpoints/communityHub");
const { agentFlowEndpoints } = require("./endpoints/agentFlows");
const { mcpServersEndpoints } = require("./endpoints/mcpServers");
const { mobileEndpoints } = require("./endpoints/mobile");
const {
  nativeAppEndpoints,
  nativeAppPublicEndpoints,
} = require("./endpoints/nativeApp");
const { webPushEndpoints } = require("./endpoints/webPush");
const { telegramEndpoints } = require("./endpoints/telegram");
const { wechatEndpoints } = require("./endpoints/wechat");
const { advancedGatewayEndpoints } = require("./endpoints/advancedGateway");
const { scheduledJobEndpoints } = require("./endpoints/scheduledJobs");
const { cryptoCenterEndpoints } = require("./endpoints/cryptoCenter");
const { cryptoHubEndpoints } = require("./endpoints/cryptoHub");
const { cryptoGateProbeEndpoints } = require("./endpoints/cryptoGateProbe");
const { cryptoForecastingEndpoints } = require("./endpoints/cryptoForecasting");
const {
  outlookAgentEndpoints,
} = require("./endpoints/utils/outlookAgentUtils");
const {
  googleAgentSkillEndpoints,
} = require("./endpoints/utils/googleAgentSkillEndpoints");
const {
  communicationDebugEndpoints,
} = require("./endpoints/communicationDebug");
const { operationsEndpoints } = require("./endpoints/operations");
const { syncCenterEndpoints } = require("./endpoints/syncCenter");
const { clientIdentityEndpoints } = require("./endpoints/clientIdentity");
const { vaultEndpoints } = require("./endpoints/vault");
const { sensitiveSessionEndpoints } = require("./endpoints/sensitiveSessions");
const { securityKeyEndpoints } = require("./endpoints/securityKeys");
const { devControlEndpoints } = require("./endpoints/devControl");
const { readerLibraryEndpoints } = require("./endpoints/readerLibrary");
const {
  workspaceChatAttachmentEndpoints,
} = require("./endpoints/workspaceChatAttachments");
const { imageAssetEndpoints } = require("./endpoints/imageAssets");
const {
  externalMcpManagementEndpoints,
} = require("./endpoints/externalMcpManagement");
const {
  registerExternalMcpOAuthRoutes,
} = require("./endpoints/externalMcpOAuth");
const {
  registerExternalMcpGatewayRoutes,
} = require("./utils/externalMcp/gateway");
const { httpLogger } = require("./middleware/httpLogger");
const {
  applyTransportSecurity,
  corsOptionsForEnvironment,
} = require("./utils/security/transportSecurity");
const {
  setBrowserSecurityHeaders,
} = require("./utils/security/browserHeaders");
const { clientIdentityMiddleware } = require("./utils/clientIdentity");
const {
  communicationMetricsMiddleware,
} = require("./middleware/communicationMetrics");
const { apiOnlyMode } = require("./utils/runtimeRole");
const {
  requestBodyLimitErrorHandler,
  requestBodyPolicy,
} = require("./middleware/requestBodyPolicy");
const { runtimeCoordinator } = require("./utils/runtimeCoordinator");
const {
  observabilityContextMiddleware,
  operationContextBodyMiddleware,
} = require("./utils/observability/context");
const { metricsEndpoint } = require("./utils/observability/metrics");
const {
  livenessSnapshot,
  publicReadinessSnapshot,
  strictReadinessEnabled,
} = require("./utils/runtimeReadiness");
const { apiErrorMiddleware } = require("./utils/http/apiError");
const app = express();
const apiRouter = express.Router();
const distributedTopology = ["distributed", "micro-modules"].includes(
  String(process.env.ATHENA_RUNTIME_TOPOLOGY || "")
    .trim()
    .toLowerCase()
);
const endpointOwnedExternally = (name) => {
  if (!distributedTopology) return false;
  const key = `ATHENA_${String(name).toUpperCase().replace(/-/g, "_")}_INLINE`;
  return String(process.env[key] || "true").toLowerCase() === "false";
};

app.disable("x-powered-by");
app.use((_, response, next) => {
  setBrowserSecurityHeaders(response);
  next();
});

// Only log HTTP requests in development mode and if the ENABLE_HTTP_LOGGER environment variable is set to true
if (
  process.env.NODE_ENV === "development" &&
  !!process.env.ENABLE_HTTP_LOGGER
) {
  app.use(
    httpLogger({
      enableTimestamps: !!process.env.ENABLE_HTTP_LOGGER_TIMESTAMPS,
    })
  );
}
applyTransportSecurity(app);
app.use(observabilityContextMiddleware);
app.use(communicationMetricsMiddleware);
app.use(clientIdentityMiddleware);
app.use(cors(corsOptionsForEnvironment()));
app.use(requestBodyPolicy);
app.use(operationContextBodyMiddleware);
app.use(requestBodyLimitErrorHandler);
app.get("/metrics", metricsEndpoint);
app.get("/live", (_request, response) =>
  response.status(200).json(livenessSnapshot())
);
apiRouter.get("/live", (_request, response) =>
  response.status(200).json(livenessSnapshot())
);
app.use((request, response, next) => {
  const status = runtimeCoordinator.status;
  const operational = status === "running";
  const healthPath = [
    "/live",
    "/api/live",
    "/ready",
    "/api/ready",
    "/api/ping",
    "/ping",
    "/metrics",
    "/api/system/runtime-diagnostics",
  ].includes(String(request.path || request.url || "").split("?")[0]);
  const ready =
    healthPath || !strictReadinessEnabled() || publicReadinessSnapshot().ready;
  if ((operational && ready) || healthPath) return next();
  return response.status(503).json({
    success: false,
    error: "runtime_not_ready",
    reasonCode: operational ? "control_plane_unhealthy" : `runtime_${status}`,
  });
});

if (!!process.env.ENABLE_HTTPS) {
  bootSSL(app, process.env.SERVER_PORT || 3001);
} else {
  require("@mintplex-labs/express-ws").default(app); // load WebSockets in non-SSL mode.
}

nativeAppPublicEndpoints(app);
if (!endpointOwnedExternally("external-mcp-gateway")) {
  registerExternalMcpGatewayRoutes(app);
  registerExternalMcpOAuthRoutes(app, {
    includePublic: true,
    includeInternal: false,
  });
}
app.use("/api", apiRouter);
app.get("/ready", (_request, response) => {
  const snapshot = publicReadinessSnapshot();
  response.status(snapshot.ready ? 200 : 503).json(snapshot);
});
apiRouter.get("/ready", (_request, response) => {
  const snapshot = publicReadinessSnapshot();
  response.status(snapshot.ready ? 200 : 503).json(snapshot);
});
runtimeDiagnosticsEndpoints(apiRouter);
apiRouter.use(quarantineMiddleware);
systemEndpoints(apiRouter);
systemPatrolEndpoints(apiRouter);
clientIdentityEndpoints(apiRouter);
realtimeAuthEndpoints(apiRouter);
characterPerformanceEndpoints(apiRouter);
vaultEndpoints(apiRouter);
sensitiveSessionEndpoints(apiRouter);
securityKeyEndpoints(apiRouter);
devControlEndpoints(apiRouter);
readerLibraryEndpoints(apiRouter);
workspaceChatAttachmentEndpoints(apiRouter);
imageAssetEndpoints(apiRouter);
externalMcpManagementEndpoints(apiRouter);
syncCenterEndpoints(apiRouter);
authPasskeyEndpoints(apiRouter);
authTrustedDeviceEndpoints(apiRouter);
authZkLoginEndpoints(apiRouter);
authSessionRecoveryEndpoints(apiRouter);
deviceBindingRecoveryEndpoints(apiRouter);
extensionEndpoints(apiRouter);
workspaceEndpoints(apiRouter);
workspaceHealthEndpoints(apiRouter);
workspaceOverviewEndpoints(apiRouter);
workspaceCognitionEndpoints(apiRouter);
workspaceMeetingDelegateEndpoints(apiRouter);
nodeSupplementEndpoints(apiRouter);
workspaceSupplementEndpoints(apiRouter);
workspaceVisualAssetEndpoints(apiRouter);
mindMapEndpoints(apiRouter);
quizEndpoints(apiRouter);
knowledgeGraphEndpoints(apiRouter);
workspaceThreadEndpoints(apiRouter);
if (!endpointOwnedExternally("chat-runtime")) chatEndpoints(apiRouter);
adminEndpoints(apiRouter);
inviteEndpoints(apiRouter);
embedManagementEndpoints(apiRouter);
utilEndpoints(apiRouter);
documentEndpoints(apiRouter);
if (!endpointOwnedExternally("agent-runtime")) agentWebsocket(apiRouter);
if (!endpointOwnedExternally("tool-runtime"))
  agentSkillWhitelistEndpoints(apiRouter);
agentFileServerEndpoints(apiRouter);
experimentalEndpoints(apiRouter);
developerEndpoints(app, apiRouter);
communityHubEndpoints(apiRouter);
agentFlowEndpoints(apiRouter);
mcpServersEndpoints(apiRouter);
nativeAppEndpoints(apiRouter);
mobileEndpoints(apiRouter);
webPushEndpoints(apiRouter);
telegramEndpoints(apiRouter);
wechatEndpoints(apiRouter);
advancedGatewayEndpoints(apiRouter);
scheduledJobEndpoints(apiRouter);
cryptoCenterEndpoints(apiRouter);
if (!endpointOwnedExternally("crypto-account")) cryptoHubEndpoints(apiRouter);
cryptoGateProbeEndpoints(apiRouter);
if (!endpointOwnedExternally("crypto-forecast"))
  cryptoForecastingEndpoints(apiRouter);
outlookAgentEndpoints(apiRouter);
googleAgentSkillEndpoints(apiRouter);
communicationDebugEndpoints(apiRouter);
operationsEndpoints(apiRouter);
// Externally facing embedder endpoints
embeddedEndpoints(apiRouter);

// Externally facing browser extension endpoints
browserExtensionEndpoints(apiRouter);
browserEndpoints(apiRouter);
apiRouter.use(apiErrorMiddleware);
app.use(apiErrorMiddleware);

const {
  startSyncV2OutboxDispatcher,
  stopSyncV2OutboxDispatcher,
} = require("./utils/syncV2/outboxDispatcher");
const { resumeActiveBatchJobs } = require("./utils/DocumentEmbeddingBatch");
const {
  startWorkspaceCognitionWorker,
  stopWorkspaceCognitionWorker,
} = require("./models/workspaceCognitionBatch");
const {
  startMutationReceiptSweeper,
  stopMutationReceiptSweeper,
} = require("./utils/mutationReceiptSweeper");
const {
  startSecurityAuditMaintenance,
  stopSecurityAuditMaintenance,
} = require("./utils/security/auditLedgerRuntime");
const {
  startAuthSessionSyncReconciler,
  stopAuthSessionSyncReconciler,
} = require("./utils/security/authSessionSyncReconciler");
const {
  identityMaintenanceOwnedLocally,
} = require("./utils/security/identityMaintenanceOwnership");
const { operationsPlane } = require("./utils/operations/operationsPlane");
const {
  operationsShadowRuntime,
} = require("./utils/operations/shadowAgents/runtime");
const {
  operationsActionRuntime,
} = require("./utils/operations/actions/orchestrator");
const {
  cryptoForecastingRuntime,
} = require("./utils/cryptoForecasting/runtime");
const { goldAnalysisRuntime } = require("./utils/goldAnalysis/runtime");
const distributedRuntime = distributedTopology;
const apiProbeHost = distributedRuntime
  ? require("./utils/modulePlatform/apiProbeHost").createApiProbeHost()
  : null;
const inlineRuntime = (name, defaultValue = !distributedRuntime) => {
  const key = `ATHENA_${String(name).toUpperCase().replace(/-/g, "_")}_INLINE`;
  if (process.env[key] === undefined) return defaultValue;
  return String(process.env[key]).toLowerCase() === "true";
};
runtimeCoordinator.register({
  name: "database-readiness",
  order: 1,
  stopOrder: 110,
  start: async () => {
    const { DataAccessCenter } = require("./utils/dataAccess");
    await DataAccessCenter.runtimeLifecycle.databaseReadiness();
  },
});
runtimeCoordinator.register({
  name: "module-readiness-probe",
  order: 2,
  stopOrder: 5,
  start: async () => apiProbeHost?.start(),
  stop: async () => apiProbeHost?.stop(),
});
runtimeCoordinator.register({
  name: "application-capability-closure",
  order: 3,
  stopOrder: 6,
  start: async () => {
    const {
      assertApplicationCapabilityClosure,
    } = require("./utils/coordination/applicationCapabilityClosure");
    await assertApplicationCapabilityClosure();
  },
});
runtimeCoordinator.register({
  name: "sync-v2-outbox",
  order: 10,
  stopOrder: 80,
  start: async () =>
    inlineRuntime("sync-v2-outbox") ? startSyncV2OutboxDispatcher() : undefined,
  stop: async () =>
    inlineRuntime("sync-v2-outbox") ? stopSyncV2OutboxDispatcher() : undefined,
});
runtimeCoordinator.register({
  name: "ai-operations-plane",
  order: 11,
  stopOrder: 85,
  start: async () =>
    inlineRuntime("operations-plane") ? operationsPlane.start() : undefined,
  stop: async () =>
    inlineRuntime("operations-plane") ? operationsPlane.stop() : undefined,
});
runtimeCoordinator.register({
  name: "ai-operations-shadow-agents",
  order: 11.5,
  stopOrder: 84,
  start: async () =>
    inlineRuntime("operations-plane")
      ? operationsShadowRuntime.start()
      : undefined,
  stop: async () =>
    inlineRuntime("operations-plane")
      ? operationsShadowRuntime.stop()
      : undefined,
});
runtimeCoordinator.register({
  name: "ai-operations-actions",
  order: 11.75,
  stopOrder: 83,
  start: async () =>
    inlineRuntime("operations-plane")
      ? operationsActionRuntime.start()
      : undefined,
  stop: async () =>
    inlineRuntime("operations-plane")
      ? operationsActionRuntime.stop()
      : undefined,
});
runtimeCoordinator.register({
  name: "opentelemetry",
  order: 5,
  stopOrder: 100,
  stop: shutdownOpenTelemetry,
});
runtimeCoordinator.register({
  name: "mutation-receipt-sweeper",
  order: 12,
  stopOrder: 75,
  start: async () => startMutationReceiptSweeper(),
  stop: stopMutationReceiptSweeper,
});
runtimeCoordinator.register({
  name: "security-audit-maintenance",
  order: 14,
  stopOrder: 74,
  start: async () =>
    identityMaintenanceOwnedLocally()
      ? startSecurityAuditMaintenance()
      : undefined,
  stop: async () =>
    identityMaintenanceOwnedLocally()
      ? stopSecurityAuditMaintenance()
      : undefined,
});
runtimeCoordinator.register({
  name: "auth-session-sync-reconciler",
  order: 13,
  stopOrder: 73,
  start: async () =>
    identityMaintenanceOwnedLocally()
      ? startAuthSessionSyncReconciler()
      : undefined,
  stop: async () =>
    identityMaintenanceOwnedLocally()
      ? stopAuthSessionSyncReconciler()
      : undefined,
});
runtimeCoordinator.register({
  name: "crypto-forecasting",
  order: 13.5,
  stopOrder: 73.5,
  start: async () => {
    if (!inlineRuntime("crypto-forecast")) return;
    try {
      return cryptoForecastingRuntime.start();
    } catch (error) {
      console.warn("[CryptoForecasting] startup deferred", {
        code: error?.code || error?.message || "startup_failed",
      });
      return { started: false, reason: "startup_deferred" };
    }
  },
  stop: async () =>
    inlineRuntime("crypto-forecast")
      ? cryptoForecastingRuntime.stop()
      : undefined,
});
runtimeCoordinator.register({
  name: "gold-market-analysis",
  order: 13.6,
  stopOrder: 73.6,
  start: async () => {
    if (!inlineRuntime("gold-market")) return;
    try {
      return goldAnalysisRuntime.start();
    } catch (error) {
      console.warn("[GoldAnalysis] startup deferred", {
        code: error?.code || error?.message || "startup_failed",
      });
      return { started: false, reason: "startup_deferred" };
    }
  },
  stop: async () =>
    inlineRuntime("gold-market") ? goldAnalysisRuntime.stop() : undefined,
});
runtimeCoordinator.register({
  name: "workspace-delete-jobs",
  order: 15,
  stopOrder: 72,
  stop: drainWorkspaceDeleteJobs,
});
runtimeCoordinator.register({
  name: "workspace-cognition",
  order: 20,
  stopOrder: 20,
  start: async () => startWorkspaceCognitionWorker(),
  stop: stopWorkspaceCognitionWorker,
});
runtimeCoordinator.register({
  name: "embedding-batch-recovery",
  order: 25,
  stopOrder: 25,
  start: async () => {
    if (inlineRuntime("knowledge-ingest")) await resumeActiveBatchJobs();
  },
});

if (process.env.NODE_ENV !== "development" && !apiOnlyMode()) {
  const { MetaGenerator } = require("./utils/boot/MetaGenerator");
  const IndexPage = new MetaGenerator();
  const publicDir = path.resolve(__dirname, "public");
  const ONE_YEAR_SECONDS = 31_536_000;

  function isLongLivedStaticAsset(filePath = "") {
    const relativePath = path
      .relative(publicDir, filePath)
      .split(path.sep)
      .join("/");
    const fileName = path.basename(relativePath);
    if (relativePath.startsWith("assets/")) return true;
    if (/[-.][a-f0-9]{8,}\.(?:js|mjs|css)$/i.test(fileName)) return true;
    if (relativePath.startsWith("pdfjs/")) return true;
    if (/\.(?:wasm|data)$/i.test(fileName)) return true;
    return false;
  }

  app.get("/_index.html", function (_, response) {
    response.status(404).json({ error: "Not found." });
  });

  app.use(
    express.static(publicDir, {
      extensions: ["js"],
      setHeaders: (res, filePath) => {
        // Disable I-framing of entire site UI
        setBrowserSecurityHeaders(res);
        if (isLongLivedStaticAsset(filePath)) {
          res.setHeader(
            "Cache-Control",
            `public, max-age=${ONE_YEAR_SECONDS}, immutable`
          );
        } else {
          res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
        }
      },
    })
  );

  app.get("/robots.txt", function (_, response) {
    response.type("text/plain");
    response.send("User-agent: *\nDisallow: /").end();
  });

  app.get("/manifest.json", async function (_, response) {
    setBrowserSecurityHeaders(response);
    response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    IndexPage.generateManifest(response);
    return;
  });

  app.use("/", function (_, response) {
    setBrowserSecurityHeaders(response);
    IndexPage.generate(response);
    return;
  });
} else if (apiOnlyMode()) {
  app.get("/", function (_, response) {
    response.status(200).json({
      success: true,
      role: "api",
      staticFrontend: false,
    });
  });
} else {
  // Debug route for development connections to vectorDBs
  apiRouter.post("/v/:command", async (request, response) => {
    try {
      const VectorDb = getVectorDbClass();
      const { command } = request.params;
      if (!Object.getOwnPropertyNames(VectorDb).includes(command)) {
        response.status(500).json({
          message: "invalid interface command",
          commands: Object.getOwnPropertyNames(VectorDb),
        });
        return;
      }

      try {
        const body = reqBody(request);
        const resBody = await VectorDb[command](body);
        response.status(200).json({ ...resBody });
      } catch (e) {
        // console.error(e)
        console.error(JSON.stringify(e));
        response.status(500).json({ error: e.message });
      }
      return;
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });
}

app.all("*", function (_, response) {
  response.sendStatus(404);
});

// In non-https mode we need to boot at the end since the server has not yet
// started and is `.listen`ing.
if (!process.env.ENABLE_HTTPS) bootHTTP(app, process.env.SERVER_PORT || 3001);
