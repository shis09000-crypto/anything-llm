const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const cors = require("cors");
const express = require("express");
const http = require("http");
const https = require("https");

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
const { metricsEndpoint } = require("./utils/observability/metrics");
const { distributedTopology } = require("./utils/microModules/serviceHost");
const { loadServiceIdentity } = require("./utils/security/serviceIdentity");

const app = express();
const runtime = new RealtimeGatewayRuntime();
let stopping = false;
const identity = loadServiceIdentity("realtime-gateway", {
  required: distributedTopology(process.env),
});
const server = identity
  ? https.createServer(
      {
        ca: identity.ca,
        cert: identity.cert,
        key: identity.key,
        minVersion: "TLSv1.3",
        requestCert: true,
        rejectUnauthorized: false,
      },
      app
    )
  : http.createServer(app);
require("@mintplex-labs/express-ws").default(app, server);

app.use((_request, response, next) => {
  setBrowserSecurityHeaders(response);
  next();
});
applyTransportSecurity(app);
app.use(observabilityContextMiddleware);
app.use(clientIdentityMiddleware);
app.use(cors(corsOptionsForEnvironment()));
app.use(requestBodyPolicy);
app.use(requestBodyLimitErrorHandler);
app.get("/metrics", metricsEndpoint);

const apiRouter = express.Router();
app.use("/api", apiRouter);
apiRouter.use((_request, response, next) => {
  if (runtime.status === "running") return next();
  return response.status(503).json({
    success: false,
    error: runtime.lastError || "realtime_gateway_not_ready",
    status: runtime.status,
  });
});
apiRouter.use(quarantineMiddleware);
syncCenterEndpoints(apiRouter);

app.get("/health", (_request, response) => {
  const snapshot = runtime.snapshot();
  const ready = snapshot.ready;
  response.status(ready ? 200 : 503).json({
    success: ready,
    ...snapshot,
  });
});

app.get("/snapshot", (_request, response) => {
  response.status(200).json(runtime.snapshot());
});

const port = Number(process.env.REALTIME_GATEWAY_PORT || 3013);
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[RealtimeGateway] ${signal} received; draining.`);
  const result = await shutdownStandaloneRuntime({
    name: "realtime-gateway",
    stop: async () => {
      await runtime.stop();
      await shutdownOpenTelemetry();
    },
    closeServer: () =>
      server
        ? new Promise((resolve) => server.close(() => resolve()))
        : Promise.resolve(),
  });
  if (result.timedOut) server?.closeAllConnections?.();
  process.exit(result.timedOut ? 1 : 0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

bootstrapSecurityContext({ runtimeRole: "realtime-gateway" })
  .then(async (security) => {
    if (!security.quarantined) {
      const { DataAccessCenter } = require("./utils/dataAccess");
      await DataAccessCenter.runtimeLifecycle.databaseReadiness();
      await runtime.start();
    } else runtime.fail(new Error("key_custody_quarantined"));
    server.listen(port, () => {
      console.log(`[RealtimeGateway] listening on ${port}`);
    });
  })
  .catch((error) => {
    runtime.fail(error);
    console.error("[RealtimeGateway] failed to start", error);
    process.exitCode = 1;
  });
