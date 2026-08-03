const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const cors = require("cors");
const express = require("express");

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "realtime-gateway";

const {
  shutdownOpenTelemetry,
  startOpenTelemetry,
} = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const { bootstrapSecurityContext } = require("./utils/security/keyLifecycle");
const { quarantineMiddleware } = require("./utils/security/keyRuntimeState");
const {
  applyTransportSecurity,
  corsOptionsForEnvironment,
} = require("./utils/security/transportSecurity");
const {
  setBrowserSecurityHeaders,
} = require("./utils/security/browserHeaders");
const { clientIdentityMiddleware } = require("./utils/clientIdentity");
const { syncCenterEndpoints } = require("./endpoints/syncCenter");
const { RealtimeGatewayRuntime } = require("./utils/realtimeGateway/runtime");
const {
  requestBodyLimitErrorHandler,
  requestBodyPolicy,
} = require("./middleware/requestBodyPolicy");
const { shutdownStandaloneRuntime } = require("./utils/runtimeCoordinator");
const {
  observabilityContextMiddleware,
} = require("./utils/observability/context");
const { MicroModuleServiceHost } = require("./utils/microModules/serviceHost");
const {
  reconcileClientSecurityProjection,
} = require("./utils/syncV2/clientSecurityProjection");
const {
  reconcileUserStateProjection,
} = require("./utils/syncV2/userStateProjection");

const runtime = new RealtimeGatewayRuntime();
const host = new MicroModuleServiceHost({
  manifestId: "sync-v2",
  role: "realtime-gateway",
  port: Number(process.env.REALTIME_GATEWAY_PORT || 3013),
  enableWebSockets: true,
  parseJson: false,
  jsonLimit: "3mb",
  internalRouteCapabilities: {
    "/internal/v1/sync/security/clients/reconcile":
      "sync.security.clients.reconcile",
    "/internal/v1/sync/user-state/reconcile": "sync.user-state.reconcile",
    "/internal/v1/sync/events/append": "sync.events.append",
  },
  readiness: () => runtime.snapshot(),
  onStart: async () => {
    const security = await bootstrapSecurityContext({
      runtimeRole: "realtime-gateway",
    });
    if (security.quarantined) throw new Error("key_custody_quarantined");
    const { DataAccessCenter } = require("./utils/dataAccess");
    await DataAccessCenter.runtimeLifecycle.databaseReadiness();
    await runtime.start();
  },
  onDrain: async () => runtime.stop(),
  onCheckpoint: async () => {
    const snapshot = runtime.snapshot();
    return {
      status: snapshot.status,
      outbox: snapshot.syncOutbox,
    };
  },
  onResume: async () => {
    await runtime.start();
  },
  onStop: async () => runtime.stop(),
  registerRoutes: (app) => {
    app.post(
      "/internal/v1/sync/events/append",
      express.json({ limit: "1mb" }),
      async (request, response) => {
        if (request.body?.probe === true)
          return response.status(200).json({
            success: true,
            available: true,
            capability: "sync.events.append",
            version: "1.0",
          });
        const event =
          await require("./utils/dataAccess").DataAccessCenter.syncEvent.persist(
            request.body?.event
          );
        return response.status(200).json({ success: true, event });
      }
    );
    app.post(
      "/internal/v1/sync/security/clients/reconcile",
      express.json({ limit: "256kb" }),
      async (request, response) => {
        if (request.body?.probe === true)
          return response.status(200).json({
            success: true,
            available: true,
            capability: "sync.security.clients.reconcile",
            version: "1.0",
          });
        const result = await reconcileClientSecurityProjection(request.body);
        return response.status(200).json({ success: true, ...result });
      }
    );
    app.post(
      "/internal/v1/sync/user-state/reconcile",
      express.json({ limit: "1mb" }),
      async (request, response) => {
        if (request.body?.probe === true)
          return response.status(200).json({
            success: true,
            available: true,
            capability: "sync.user-state.reconcile",
            version: "1.0",
          });
        const result = await reconcileUserStateProjection(request.body);
        return response.status(200).json({ success: true, ...result });
      }
    );
    app.use((_request, response, next) => {
      setBrowserSecurityHeaders(response);
      next();
    });
    applyTransportSecurity(app);
    app.use(observabilityContextMiddleware);
    app.use(clientIdentityMiddleware);
    app.use(cors(corsOptionsForEnvironment()));
    app.use(requestBodyPolicy);

    const apiRouter = express.Router();
    app.use("/api", apiRouter);
    apiRouter.use(quarantineMiddleware);
    syncCenterEndpoints(apiRouter);
    app.use(requestBodyLimitErrorHandler);
  },
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[RealtimeGateway] ${signal} received; draining.`);
  const result = await shutdownStandaloneRuntime({
    name: "realtime-gateway",
    stop: async () => {
      await host.stop();
      await shutdownOpenTelemetry();
    },
  });
  process.exit(result.timedOut ? 1 : 0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

host
  .start()
  .then((snapshot) => console.log("[RealtimeGateway] started", snapshot))
  .catch((error) => {
    runtime.fail(error);
    console.error("[RealtimeGateway] failed to start", error);
    process.exitCode = 1;
  });
