const { DataAccessCenter } = require("../dataAccess");
const { requestInternalService } = require("../microModules/internalClient");
const { distributedTopology } = require("../microModules/serviceHost");
const { agentDefinitions, agentRegistrySnapshot } = require("./agentRegistry");
const { operationsPlane } = require("./operationsPlane");
const { serviceCatalog } = require("./serviceCatalog");
const {
  buildStateGraph,
  eventComponent,
  explainEvent,
} = require("./stateGraph");
const { operationsShadowRuntime } = require("./shadowAgents/runtime");
const {
  operationsActionOrchestrator,
  operationsActionRuntime,
} = require("./actions/orchestrator");
const { moduleHealthMonitor } = require("./moduleHealthMonitor");
const {
  infrastructureHealthMonitor,
} = require("./infrastructureHealthMonitor");
const { projectFlows } = require("./flowProjection");

function operationsRemoteMode(env = process.env) {
  return (
    distributedTopology(env) &&
    String(env.ATHENA_RUNTIME_ROLE || "api") !== "operations-plane" &&
    String(env.ATHENA_OPERATIONS_PLANE_INLINE || "true").toLowerCase() ===
      "false" &&
    Boolean(String(env.ATHENA_OPERATIONS_INTERNAL_URL || "").trim())
  );
}

function coordinationRemoteMode(env = process.env) {
  return (
    distributedTopology(env) &&
    String(env.ATHENA_RUNTIME_ROLE || "") === "operations-plane" &&
    Boolean(String(env.ATHENA_COORDINATION_INTERNAL_URL || "").trim())
  );
}

async function coordinationLifecycleHealth(
  env = process.env,
  request = requestInternalService
) {
  if (!coordinationRemoteMode(env))
    return {
      enabled: false,
      status: "not-configured",
      coverage: null,
    };
  try {
    const result = await request({
      callerRole: "operations-plane",
      callerModule: "operations-plane",
      targetModule: "coordination-plane",
      capability: "coordination.status",
      url: `${String(env.ATHENA_COORDINATION_INTERNAL_URL).replace(
        /\/+$/,
        ""
      )}/internal/v1/coordination/modules`,
      method: "GET",
      env,
      timeoutMs: 5_000,
    });
    return {
      enabled: true,
      status: result.coverage?.complete ? "healthy" : "degraded",
      coverage: result.coverage || null,
    };
  } catch (error) {
    return {
      enabled: true,
      status: "unavailable",
      reasonCode: String(
        error?.code || error?.message || "coordination_unavailable"
      ).slice(0, 160),
      coverage: null,
    };
  }
}

function runtimeStateById() {
  return new Map([
    ...moduleHealthMonitor
      .snapshot()
      .modules.map((state) => [state.moduleId, state]),
    ...infrastructureHealthMonitor
      .snapshot()
      .components.map((state) => [state.componentId, state]),
  ]);
}

function operationsCoverageSnapshot() {
  const plane = operationsPlane.health();
  const moduleHealth = moduleHealthMonitor.snapshot();
  const infrastructureHealth = infrastructureHealthMonitor.snapshot();
  const infrastructureRequired = distributedTopology(process.env);
  const freshHeartbeatIds = new Set(
    (plane.moduleHeartbeatCoverage?.heartbeats || [])
      .filter((heartbeat) => !heartbeat.stale)
      .map((heartbeat) => heartbeat.moduleId)
  );
  const healthyProbeIds = new Set(
    moduleHealth.modules
      .filter((module) => module.status === "healthy" && module.ready)
      .map((module) => module.moduleId)
  );
  const expected = moduleHealth.modules
    .filter((module) => (module.expectedState || "running") === "running")
    .map((module) => module.moduleId);
  const covered = expected.filter(
    (moduleId) =>
      freshHeartbeatIds.has(moduleId) || healthyProbeIds.has(moduleId)
  );
  const missing = expected.filter((moduleId) => !covered.includes(moduleId));
  return {
    expected: expected.length,
    covered: covered.length,
    coverageRatio: expected.length ? covered.length / expected.length : 0,
    complete:
      expected.length > 0 &&
      missing.length === 0 &&
      (!infrastructureRequired || infrastructureHealth.summary.complete),
    missing,
    freshHeartbeatModules: [...freshHeartbeatIds].sort(),
    healthyProbeModules: [...healthyProbeIds].sort(),
    infrastructureRequired,
    infrastructure: infrastructureHealth.summary,
  };
}

function operationsShadowRemoteMode(env = process.env) {
  return (
    distributedTopology(env) &&
    String(env.ATHENA_RUNTIME_ROLE || "") === "operations-plane" &&
    String(
      env.ATHENA_OPERATIONS_SHADOW_AGENTS_INLINE || "true"
    ).toLowerCase() === "false" &&
    Boolean(String(env.ATHENA_OPERATIONS_SHADOW_AGENTS_URL || "").trim())
  );
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function aicpTraceEntryFromEvent(event = {}) {
  if (event.eventType === "aicp.rpc.observed")
    return {
      observationId: `rpc:${event.subject?.id || event.eventId}`,
      kind: "rpc",
      from: event.subject?.component || null,
      to: event.impact?.scope || null,
      capability: event.subject?.operation || null,
      operationId: event.correlation?.operationId || null,
      occurredAt: event.occurredAt,
      observedAt: event.observedAt,
      outcome: event.outcome,
      statusCode: finiteOrNull(event.metadata?.statusCode),
      errorCode: event.metadata?.errorCode || null,
      durationMs: finiteOrNull(event.metadata?.durationMs),
      contractConformant: event.metadata?.validationStatus !== "contract_drift",
      linkIds: [],
    };
  return {
    observationId: `event:${event.eventId}`,
    kind: "event",
    eventId: event.eventId,
    eventType: event.eventType,
    moduleId: eventComponent(event),
    operationId: event.correlation?.operationId || null,
    occurredAt: event.occurredAt,
    observedAt: event.observedAt,
    outcome: event.outcome,
    linkIds: [],
  };
}

async function remoteShadowCall(path, env = process.env) {
  return requestInternalService({
    callerRole: "operations-plane",
    targetModule: "operations-shadow-agents",
    capability: "operations.shadow.evaluate",
    contractVersion: "1.0",
    url: `${String(env.ATHENA_OPERATIONS_SHADOW_AGENTS_URL).replace(
      /\/+$/,
      ""
    )}${path}`,
    method: "GET",
    env,
    timeoutMs: 10_000,
  });
}

async function operationsShadowSnapshot(
  env = process.env,
  request = remoteShadowCall
) {
  if (!operationsShadowRemoteMode(env))
    return operationsShadowRuntime.snapshot();
  try {
    return await request("/internal/v1/operations/shadow", env);
  } catch (error) {
    return {
      success: false,
      ready: false,
      status: "degraded",
      reasonCode: "operations_shadow_agents_unavailable",
      retryable: true,
      lastError: String(error?.code || "shadow_runtime_unavailable").slice(
        0,
        96
      ),
    };
  }
}

const localOperationsAccess = {
  async health() {
    const plane = operationsPlane.health();
    const moduleHealth = moduleHealthMonitor.snapshot();
    const infrastructureHealth = infrastructureHealthMonitor.snapshot();
    const coverage = operationsCoverageSnapshot();
    const coordination = await coordinationLifecycleHealth();
    const ready =
      plane.ready &&
      moduleHealth.summary.complete &&
      coverage.complete &&
      (!coverage.infrastructureRequired ||
        infrastructureHealth.summary.complete);
    return {
      ...plane,
      ready,
      status: !ready
        ? moduleHealth.summary.degraded
          ? "degraded"
          : "coverage-incomplete"
        : plane.status,
      actions: operationsActionRuntime.snapshot(),
      shadowAgents: await operationsShadowSnapshot(),
      moduleHealth,
      infrastructureHealth,
      coverage,
      coordination,
    };
  },

  async services() {
    const runtime = runtimeStateById();
    return {
      generatedAt: new Date().toISOString(),
      services: serviceCatalog().map((service) => ({
        ...service,
        ...(runtime.has(service.id)
          ? { runtime: runtime.get(service.id) }
          : {}),
      })),
      moduleHealth: moduleHealthMonitor.snapshot(),
      infrastructureHealth: infrastructureHealthMonitor.snapshot(),
    };
  },

  async agents(limit) {
    return agentRegistrySnapshot({ invocationLimit: limit });
  },

  async shadowAgents() {
    return operationsShadowSnapshot();
  },

  async evaluationLatest() {
    if (operationsShadowRemoteMode())
      return remoteShadowCall(
        "/internal/v1/operations/shadow/evaluations/latest"
      );
    return { report: operationsShadowRuntime.evaluation() };
  },

  async evaluationCorpus() {
    if (operationsShadowRemoteMode())
      return remoteShadowCall(
        "/internal/v1/operations/shadow/evaluations/corpus"
      );
    return { manifest: operationsShadowRuntime.corpus() };
  },

  async actionsCatalog() {
    return {
      mode: "human-approved",
      agentExecutionAllowed: false,
      actions: operationsActionOrchestrator.catalog(),
    };
  },

  async actionRuns(filters = {}) {
    return {
      runs: await DataAccessCenter.operationsAction.listRuns(filters),
    };
  },

  async actionRun(runId) {
    const run = await DataAccessCenter.operationsAction.getRun(runId);
    return {
      run,
      approvals: run
        ? await DataAccessCenter.operationsAction.approvalsForRun(run.id)
        : [],
    };
  },

  async proposeAction(input) {
    return {
      run: await operationsActionOrchestrator.propose(input),
    };
  },

  async decideAction(input) {
    return {
      run: await operationsActionOrchestrator.decide(input),
    };
  },

  async executeAction({ runId, actor }) {
    const run = await DataAccessCenter.operationsAction.getRun(runId);
    if (!run) return { run: null, accepted: false };
    if (run.status !== "approved") {
      const error = new Error("operations_action_not_approved");
      error.code = "operations_action_not_approved";
      throw error;
    }
    return {
      run,
      accepted: operationsActionRuntime.executeAsync(run.id, actor),
    };
  },

  async reconcileAction({ runId, actor }) {
    return {
      run: await operationsActionOrchestrator.reconcile(runId, actor),
    };
  },

  async timeline(filters = {}) {
    return {
      generatedAt: new Date().toISOString(),
      ...(await operationsPlane.timelineWithMetadata(filters)),
    };
  },

  async stateGraph({ limit = 250 } = {}) {
    const [events, agents, syncState] = await Promise.all([
      operationsPlane.timeline({ limit }),
      agentDefinitions(),
      DataAccessCenter.syncV2.snapshot(),
    ]);
    return {
      graph: buildStateGraph({
        events,
        agents,
        syncState,
        moduleHealth: moduleHealthMonitor.snapshot(),
        infrastructureHealth: infrastructureHealthMonitor.snapshot(),
      }),
      runtimeTopology: operationsPlane.aicpTopology(),
    };
  },

  async aicpTopology() {
    return {
      generatedAt: new Date().toISOString(),
      topology: operationsPlane.aicpTopology(),
      shadow: operationsPlane.health().aicpShadow,
    };
  },

  async aicpTrace(traceId) {
    const runtimeTrace = operationsPlane.aicpTrace(traceId);
    if (runtimeTrace.found)
      return {
        generatedAt: new Date().toISOString(),
        trace: {
          ...runtimeTrace,
          source: "runtime-shadow",
          completeness: "bounded-live-window",
        },
      };
    const timeline = await operationsPlane.timelineWithMetadata({
      traceId: String(traceId || "").slice(0, 64),
      limit: 500,
    });
    return {
      generatedAt: new Date().toISOString(),
      trace: {
        traceId: String(traceId || "").slice(0, 64),
        found: timeline.events.length > 0,
        entries: timeline.events
          .map(aicpTraceEntryFromEvent)
          .sort(
            (left, right) =>
              Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
          ),
        source: timeline.source,
        completeness: timeline.completeness,
      },
    };
  },

  async flows(filters = {}) {
    const timeline = await operationsPlane.timelineWithMetadata({
      ...filters,
      limit: Math.max(1, Math.min(Number(filters.limit) || 500, 500)),
    });
    return {
      generatedAt: new Date().toISOString(),
      ...projectFlows(timeline.events),
      source: timeline.source,
      sources: timeline.sources,
      degraded: timeline.degraded,
      completeness: timeline.completeness,
      persistedThrough: timeline.persistedThrough,
    };
  },

  async explain({ eventId, operationId, limit = 100 } = {}) {
    const result = await operationsPlane.timelineWithMetadata({
      ...(eventId ? { eventId } : { operationId }),
      limit,
    });
    const primary = result.events[0] || null;
    return {
      found: Boolean(primary),
      answer: primary ? explainEvent(primary) : null,
      timeline: result.events,
      source: result.source,
      degraded: result.degraded,
      completeness: result.completeness,
      sources: result.sources,
    };
  },
};

class RemoteOperationsAccess {
  constructor({ env = process.env, request = requestInternalService } = {}) {
    this.env = env;
    this.request = request;
  }

  baseUrl() {
    return String(this.env.ATHENA_OPERATIONS_INTERNAL_URL || "")
      .trim()
      .replace(/\/$/, "");
  }

  async call(path, { method = "GET", body = null } = {}) {
    return this.request({
      callerRole: String(this.env.ATHENA_RUNTIME_ROLE || "api"),
      url: `${this.baseUrl()}${path}`,
      method,
      body,
      env: this.env,
      timeoutMs: 10_000,
    });
  }

  health() {
    return this.call("/internal/v1/operations/health");
  }

  services() {
    return this.call("/internal/v1/operations/services");
  }

  agents(limit) {
    return this.call(
      `/internal/v1/operations/agents?limit=${encodeURIComponent(limit)}`
    );
  }

  shadowAgents() {
    return this.call("/internal/v1/operations/shadow-agents");
  }

  evaluationLatest() {
    return this.call("/internal/v1/operations/evaluations/latest");
  }

  evaluationCorpus() {
    return this.call("/internal/v1/operations/evaluations/corpus");
  }

  actionsCatalog() {
    return this.call("/internal/v1/operations/actions/catalog");
  }

  actionRuns(filters = {}) {
    return this.call("/internal/v1/operations/actions/runs/query", {
      method: "POST",
      body: filters,
    });
  }

  actionRun(runId) {
    return this.call(
      `/internal/v1/operations/actions/runs/${encodeURIComponent(runId)}`
    );
  }

  proposeAction(input) {
    return this.call("/internal/v1/operations/actions/runs", {
      method: "POST",
      body: input,
    });
  }

  decideAction(input) {
    return this.call(
      `/internal/v1/operations/actions/runs/${encodeURIComponent(
        input.runId
      )}/decide`,
      { method: "POST", body: input }
    );
  }

  executeAction(input) {
    return this.call(
      `/internal/v1/operations/actions/runs/${encodeURIComponent(
        input.runId
      )}/execute`,
      { method: "POST", body: input }
    );
  }

  reconcileAction(input) {
    return this.call(
      `/internal/v1/operations/actions/runs/${encodeURIComponent(
        input.runId
      )}/reconcile`,
      { method: "POST", body: input }
    );
  }

  timeline(filters = {}) {
    return this.call("/internal/v1/operations/timeline", {
      method: "POST",
      body: filters,
    });
  }

  stateGraph(input = {}) {
    return this.call("/internal/v1/operations/state-graph", {
      method: "POST",
      body: input,
    });
  }

  aicpTopology() {
    return this.call("/internal/v1/operations/aicp/topology");
  }

  aicpTrace(traceId) {
    return this.call(
      `/internal/v1/operations/aicp/traces/${encodeURIComponent(traceId)}`
    );
  }

  flows(input = {}) {
    return this.call("/internal/v1/operations/flows", {
      method: "POST",
      body: input,
    });
  }

  explain(input = {}) {
    return this.call("/internal/v1/operations/explain", {
      method: "POST",
      body: input,
    });
  }
}

const remoteOperationsAccess = new RemoteOperationsAccess();

function operationsAccess(env = process.env) {
  return operationsRemoteMode(env)
    ? remoteOperationsAccess
    : localOperationsAccess;
}

module.exports = {
  RemoteOperationsAccess,
  coordinationLifecycleHealth,
  coordinationRemoteMode,
  localOperationsAccess,
  operationsAccess,
  operationsCoverageSnapshot,
  operationsRemoteMode,
  operationsShadowRemoteMode,
  operationsShadowSnapshot,
  remoteOperationsAccess,
};
