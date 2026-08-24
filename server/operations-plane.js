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
const {
  infrastructureHealthMonitor,
} = require("./utils/operations/infrastructureHealthMonitor");
const {
  buildInfrastructureProbeProviders,
} = require("./utils/operations/infrastructureProbes");
const { operationsServiceReady } = require("./utils/operations/readiness");
const { distributedTopology } = require("./utils/microModules/serviceHost");
const { expectedServiceId } = require("./utils/security/serviceIdentity");

const port = Number(process.env.OPERATIONS_PLANE_PORT || 3015);
let localHeartbeatTimer = null;

function shadowAgentsInline() {
  return (
    String(
      process.env.ATHENA_OPERATIONS_SHADOW_AGENTS_INLINE || "true"
    ).toLowerCase() !== "false"
  );
}

function recordLocalHeartbeats() {
  const moduleIds = [
    "operations-plane",
    ...(shadowAgentsInline() ? ["operations-shadow-agents"] : []),
  ];
  for (const moduleId of moduleIds) {
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
  internalRouteCapabilities: {
    "POST /internal/v1/operations/ingest": "operations.ingest-batch",
    "POST /internal/v1/operations/ingest-batch": "operations.ingest-batch",
    "GET /internal/v1/operations/health": "operations.catalog",
    "GET /internal/v1/operations/services": "operations.catalog",
    "GET /internal/v1/operations/agents": "operations.catalog",
    "GET /internal/v1/operations/shadow-agents": "operations.catalog",
    "GET /internal/v1/operations/evaluations/latest": "operations.catalog",
    "GET /internal/v1/operations/evaluations/corpus": "operations.catalog",
    "GET /internal/v1/operations/actions/catalog": "operations.catalog",
    "POST /internal/v1/operations/actions/runs/query": "operations.catalog",
    "GET /internal/v1/operations/actions/runs/:runId": "operations.catalog",
    "POST /internal/v1/operations/actions/runs": "operations.guard",
    "POST /internal/v1/operations/actions/runs/:runId/decide":
      "operations.guard",
    "POST /internal/v1/operations/actions/runs/:runId/execute":
      "operations.guard",
    "POST /internal/v1/operations/actions/runs/:runId/reconcile":
      "operations.guard",
    "POST /internal/v1/operations/timeline": "operations.catalog",
    "POST /internal/v1/operations/state-graph": "operations.catalog",
    "GET /internal/v1/operations/aicp/topology": "operations.catalog",
    "GET /internal/v1/operations/aicp/traces/:traceId": "operations.catalog",
    "POST /internal/v1/operations/flows": "operations.catalog",
    "POST /internal/v1/operations/explain": "operations.catalog",
    "POST /internal/v1/operations/module-health/refresh": "operations.guard",
    "GET /internal/v1/operations/module-health": "operations.catalog",
    "GET /internal/v1/operations/infrastructure-health": "operations.catalog",
  },
  readiness: () => {
    const plane = operationsPlane.health();
    const moduleHealth = moduleHealthMonitor.snapshot();
    const infrastructureHealth = infrastructureHealthMonitor.snapshot();
    const coverage = operationsCoverageSnapshot();
    return {
      ...plane,
      moduleHealth: moduleHealth.summary,
      infrastructureHealth: infrastructureHealth.summary,
      coverage,
      // Readiness is the Operations Plane's ability to receive and persist
      // telemetry. The health of observed modules remains part of the public
      // health snapshot, but must not make the observer itself unavailable.
      // Otherwise adding or restarting a module creates a readiness cycle:
      // Operations waits for the module while the module waits for Operations.
      ready: operationsServiceReady({
        plane,
        infrastructureHealth: infrastructureHealth.summary,
      }),
    };
  },
  onStart: async () => {
    const health = await operationsPlane.start();
    if (!["running", "degraded"].includes(health.status))
      throw new Error(health.lastError || "operations_plane_not_ready");
    if (shadowAgentsInline()) await operationsShadowRuntime.start();
    await operationsActionRuntime.start();
    startLocalHeartbeats();
    moduleHealthMonitor.start({
      localProviders: {
        "operations-plane": () => operationsPlane.health(),
        ...(shadowAgentsInline()
          ? {
              "operations-shadow-agents": () => {
                const snapshot = operationsShadowRuntime.snapshot();
                return {
                  ...snapshot,
                  ready: snapshot.status === "running",
                };
              },
            }
          : {}),
      },
    });
    infrastructureHealthMonitor.start({
      providers: buildInfrastructureProbeProviders({
        plane: operationsPlane,
      }),
    });
    await Promise.all([
      moduleHealthMonitor.refresh(),
      infrastructureHealthMonitor.refresh(),
    ]);
  },
  onDrain: async () => {
    stopLocalHeartbeats();
    await Promise.all([
      moduleHealthMonitor.stop(),
      infrastructureHealthMonitor.stop(),
    ]);
    await operationsActionRuntime.stop();
    if (shadowAgentsInline()) await operationsShadowRuntime.stop();
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
      const caller = response.locals.serviceCaller;
      if (caller === expectedServiceId("api", process.env)) return next();
      if (
        caller === expectedServiceId("operations-shadow-agents", process.env) &&
        request.path.replace(/\/$/, "") === "/timeline" &&
        request.method === "POST"
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
    app.get(
      "/internal/v1/operations/aicp/topology",
      async (_request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.aicpTopology()),
        });
      }
    );
    app.get(
      "/internal/v1/operations/aicp/traces/:traceId",
      async (request, response) => {
        response.json({
          success: true,
          ...(await localOperationsAccess.aicpTrace(request.params.traceId)),
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
        const [moduleHealth, infrastructureHealth] = await Promise.all([
          moduleHealthMonitor.refresh(),
          infrastructureHealthMonitor.refresh(),
        ]);
        response.json({
          success: true,
          moduleHealth,
          infrastructureHealth,
        });
      }
    );
    app.get("/internal/v1/operations/module-health", (_request, response) => {
      response.json({
        success: true,
        moduleHealth: moduleHealthMonitor.snapshot(),
        infrastructureHealth: infrastructureHealthMonitor.snapshot(),
      });
    });
    app.get(
      "/internal/v1/operations/infrastructure-health",
      (_request, response) => {
        response.json({
          success: true,
          infrastructureHealth: infrastructureHealthMonitor.snapshot(),
        });
      }
    );
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
