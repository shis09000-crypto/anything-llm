const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "coordination-plane";

const {
  shutdownOpenTelemetry,
  startOpenTelemetry,
} = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  secureDatabaseStart,
} = require("./utils/microModules");
const { CoordinationRuntime } = require("./utils/coordination");
const { disconnectRuntimeDatabases } = require("./utils/runtimeCoordinator");

const runtime = new CoordinationRuntime();
const port = Number(process.env.COORDINATION_PLANE_PORT || 3032);

const host = new MicroModuleServiceHost({
  manifestId: "coordination-plane",
  role: "coordination-plane",
  port,
  internalRouteCapabilities: {
    "/internal/v1/coordination/modules/heartbeat":
      "coordination.lifecycle.heartbeat",
    "/internal/v1/coordination/modules/lifecycle-events":
      "coordination.lifecycle.event",
    "/internal/v1/coordination/modules": "coordination.status",
  },
  readiness: () => runtime.snapshot(),
  onStart: async () =>
    secureDatabaseStart("coordination-plane", async () => runtime.start()),
  onDrain: async () => runtime.stop(),
  onCheckpoint: async () => ({
    durableLineage: true,
    activeBusinessExecutors: 0,
  }),
  onResume: async () => runtime.start(),
  onLifecycleTransition: (event) => {
    void runtime.recordLifecycleEvent(event).catch(() => {});
  },
  onHeartbeat: (heartbeat) => {
    void runtime
      .recordModuleHeartbeat({
        ...heartbeat,
        runtimeRole: "coordination-plane",
        version: host.manifest.version,
        manifestFingerprint: host.manifest.fingerprint,
        sequence: host.lifecycle.sequence,
        lastReasonCode: host.lifecycle.lastReasonCode,
        metadata: {
          authorityMode: runtime.authorityMode(),
        },
      })
      .catch(() => {});
  },
  onStop: async () => {
    await disconnectRuntimeDatabases();
    await shutdownOpenTelemetry();
  },
  registerRoutes: (app) => {
    app.post("/internal/v1/coordination/runs", async (request, response) => {
      const run = await runtime.plan(request.body || {});
      response.status(201).json({ success: true, run });
    });
    app.post(
      "/internal/v1/coordination/runs/:runId/start",
      async (request, response) => {
        response.json({
          success: true,
          run: await runtime.startRun(request.params.runId),
        });
      }
    );
    app.get(
      "/internal/v1/coordination/runs/:runId",
      async (request, response) => {
        response.json({
          success: true,
          run: await runtime.statusForRun(request.params.runId),
        });
      }
    );
    app.post(
      "/internal/v1/coordination/runs/:runId/autonomy-attempts",
      async (request, response) => {
        response.json({
          success: true,
          run: await runtime.recordAutonomyAttempt(
            request.params.runId,
            request.body || {}
          ),
        });
      }
    );
    app.post(
      "/internal/v1/coordination/runs/:runId/escalations",
      async (request, response) => {
        response.json({
          success: true,
          ...(await runtime.requestEscalation({
            ...(request.body || {}),
            runId: request.params.runId,
          })),
        });
      }
    );
    app.post(
      "/internal/v1/coordination/runs/:runId/cancel",
      async (request, response) => {
        response.json({
          success: true,
          run: await runtime.cancel(
            request.params.runId,
            request.body?.reasonCode
          ),
        });
      }
    );
    app.post(
      "/internal/v1/coordination/modules/heartbeat",
      async (request, response) => {
        await runtime.recordModuleHeartbeat(request.body || {});
        response.status(202).json({ success: true });
      }
    );
    app.post(
      "/internal/v1/coordination/modules/lifecycle-events",
      async (request, response) => {
        await runtime.recordLifecycleEvent(request.body || {});
        response.status(202).json({ success: true });
      }
    );
    app.get("/internal/v1/coordination/modules", async (_request, response) => {
      response.json({
        success: true,
        coverage: await runtime.moduleCoverage(),
      });
    });
  },
});

installStandaloneShutdown(host, { name: "CoordinationPlane" });

host
  .start()
  .then((snapshot) =>
    console.log(`[CoordinationPlane] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[CoordinationPlane] failed to start", error);
    process.exitCode = 1;
  });
