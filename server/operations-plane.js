const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "operations-plane";
const {
  shutdownOpenTelemetry,
  startOpenTelemetry,
} = require("./utils/observability");
const { semanticEvent } = require("./utils/observability/semanticEvents");
startOpenTelemetry();
require("./utils/logger")();

const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();
const { MicroModuleServiceHost } = require("./utils/microModules");
const { operationsPlane } = require("./utils/operations/operationsPlane");
const {
  operationsShadowRuntime,
} = require("./utils/operations/shadowAgents/runtime");
const {
  operationsActionRuntime,
} = require("./utils/operations/actions/orchestrator");
const {
  localOperationsAccess,
  operationsCoverageSnapshot,
} = require("./utils/operations/access");
const {
  moduleHealthMonitor,
} = require("./utils/operations/moduleHealthMonitor");
const { distributedTopology } = require("./utils/microModules/serviceHost");
const { expectedServiceId } = require("./utils/security/serviceIdentity");

const port = Number(process.env.OPERATIONS_PLANE_PORT || 3015);
let localHeartbeatTimer = null;

function recordLocalHeartbeats() {
  for (const moduleId of ["operations-plane", "operations-shadow-agents"]) {
    const event = semanticEvent({
      eventType: "module.telemetry.heartbeat",
      category: "module_health",
      severity: "info",
      outcome: "observed",
      subject: {
        type: "service",
        id: moduleId,
        component: moduleId,
        operation: "local_runtime_heartbeat",
      },
      impact: { scope: "operations_plane", status: "connected" },
      sensitivity: "metadata_only",
    });
    operationsPlane.observeProducer(event);
    void operationsPlane.ingest(event);
  }
}

function startLocalHeartbeats() {
  recordLocalHeartbeats();
  if (localHeartbeatTimer) return;
  localHeartbeatTimer = setInterval(recordLocalHeartbeats, 60_000);
  localHeartbeatTimer.unref?.();
}

function stopLocalHeartbeats() {
  if (localHeartbeatTimer) clearInterval(localHeartbeatTimer);
  localHeartbeatTimer = null;
}

const host = new MicroModuleServiceHost({
  manifestId: "operations-plane",
  role: "operations-plane",
  port,
  readiness: () => {
    const plane = operationsPlane.health();
    const moduleHealth = moduleHealthMonitor.snapshot();
    const coverage = operationsCoverageSnapshot();
    return {
      ...plane,
      moduleHealth: moduleHealth.summary,
      coverage,
      ready: plane.ready && moduleHealth.summary.complete && coverage.complete,
    };
  },
  onStart: async () => {
    const health = await operationsPlane.start();
    if (!["running", "degraded"].includes(health.status))
      throw new Error(health.lastError || "operations_plane_not_ready");
    await operationsShadowRuntime.start();
    await operationsActionRuntime.start();
    startLocalHeartbeats();
    moduleHealthMonitor.start({
      localProviders: {
        "operations-plane": () => operationsPlane.health(),
        "operations-shadow-agents": () => {
          const snapshot = operationsShadowRuntime.snapshot();
          return {
            ...snapshot,
            ready: snapshot.status === "running",
          };
        },
      },
    });
    await moduleHealthMonitor.refresh();
  },
  onDrain: async () => {
    stopLocalHeartbeats();
    await moduleHealthMonitor.stop();
    await operationsActionRuntime.stop();
    await operationsShadowRuntime.stop();
    await operationsPlane.stop();
  },
  onStop: shutdownOpenTelemetry,
  registerRoutes: (app) => {
    app.post("/internal/v1/operations/ingest", async (request, response) => {
      const result = await operationsPlane.ingest(request.body);
      response.status(result?.accepted === false ? 202 : 200).json({
        success: true,
        accepted: result?.accepted !== false,
        queued: Boolean(result?.queued),
      });
    });
    app.post(
      "/internal/v1/operations/ingest-batch",
      async (request, response) => {
        const result = await operationsPlane.ingestBatch(
          request.body?.events || []
        );
        response.status(result.queued ? 202 : 200).json({
          success: true,
          ...result,
        });
      }
    );

    const controlCaller = (request, response, next) => {
      if (!distributedTopology(process.env)) return next();
      if (
        response.locals.serviceCaller === expectedServiceId("api", process.env)
      )
        return next();
      return response.status(403).json({
        success: false,
        error: "operations_control_caller_rejected",
      });
    };

    app.use("/internal/v1/operations", (request, response, next) => {
      if (
        ["/ingest", "/ingest-batch"].includes(request.path.replace(/\/$/, ""))
      )
        return next();
      return controlCaller(request, response, next);
    });

    app.get("/internal/v1/operations/health", async (_request, response) => {
      response.json({
        success: true,
        ...(await localOperationsAccess.health()),
      });
    });
    app.get("/internal/v1/operations/services", async (_request, response) => {
      response.json({
        success: true,
        ...(await localOperationsAccess.services()),
      });
    });
    app.get("/internal/v1/operations/agents", async (request, response) => {
      response.json({
        success: true,
        ...(await localOperationsAccess.agents(
          Math.max(1, Math.min(Number(request.query.limit) || 100, 500))
        )),
      });
    });
    app.get(
      "/internal/v1/operations/shadow-agents",
      async (_request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.shadowAgents()),
        });
      }
    );
    app.get(
      "/internal/v1/operations/evaluations/latest",
      async (_request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.evaluationLatest()),
        });
      }
    );
    app.get(
      "/internal/v1/operations/evaluations/corpus",
      async (_request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.evaluationCorpus()),
        });
      }
    );
    app.get(
      "/internal/v1/operations/actions/catalog",
      async (_request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.actionsCatalog()),
        });
      }
    );
    app.post(
      "/internal/v1/operations/actions/runs/query",
      async (request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.actionRuns(request.body || {})),
        });
      }
    );
    app.get(
      "/internal/v1/operations/actions/runs/:runId",
      async (request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.actionRun(request.params.runId)),
        });
      }
    );
    app.post(
      "/internal/v1/operations/actions/runs",
      async (request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.proposeAction(request.body || {})),
        });
      }
    );
    app.post(
      "/internal/v1/operations/actions/runs/:runId/decide",
      async (request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.decideAction({
            ...(request.body || {}),
            runId: request.params.runId,
          })),
        });
      }
    );
    app.post(
      "/internal/v1/operations/actions/runs/:runId/execute",
      async (request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.executeAction({
            ...(request.body || {}),
            runId: request.params.runId,
          })),
        });
      }
    );
    app.post(
      "/internal/v1/operations/actions/runs/:runId/reconcile",
      async (request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.reconcileAction({
            ...(request.body || {}),
            runId: request.params.runId,
          })),
        });
      }
    );
    app.post("/internal/v1/operations/timeline", async (request, response) => {
      response.json({
        success: true,
        ...(await localOperationsAccess.timeline(request.body || {})),
      });
    });
    app.post(
      "/internal/v1/operations/state-graph",
      async (request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.stateGraph(request.body || {})),
        });
      }
    );
    app.post("/internal/v1/operations/flows", async (request, response) => {
      response.json({
        success: true,
        ...(await localOperationsAccess.flows(request.body || {})),
      });
    });
    app.post("/internal/v1/operations/explain", async (request, response) => {
      response.json({
        success: true,
        ...(await localOperationsAccess.explain(request.body || {})),
      });
    });
    app.post(
      "/internal/v1/operations/module-health/refresh",
      async (_request, response) => {
        response.json({
          success: true,
          moduleHealth: await moduleHealthMonitor.refresh(),
        });
      }
    );
    app.get("/internal/v1/operations/module-health", (_request, response) => {
      response.json({
        success: true,
        moduleHealth: moduleHealthMonitor.snapshot(),
      });
    });
  },
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[OperationsPlane] ${signal} received; draining.`);
  await host.stop();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

host
  .start()
  .then((snapshot) =>
    console.log(`[OperationsPlane] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[OperationsPlane] failed to start", error);
    process.exitCode = 1;
  });
