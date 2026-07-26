const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { DataAccessCenter } = require("../utils/dataAccess");
const {
  agentDefinitions,
  agentRegistrySnapshot,
} = require("../utils/operations/agentRegistry");
const {
  getSchema,
  schemaManifest,
} = require("../utils/operations/schemaRegistry");
const { serviceCatalog } = require("../utils/operations/serviceCatalog");
const {
  buildStateGraph,
  explainEvent,
} = require("../utils/operations/stateGraph");
const { operationsPlane } = require("../utils/operations/operationsPlane");
const {
  operationsShadowRuntime,
} = require("../utils/operations/shadowAgents/runtime");
const {
  operationsActionOrchestrator,
  operationsActionRuntime,
} = require("../utils/operations/actions/orchestrator");
const { emitSemanticEvent } = require("../utils/observability/semanticEvents");
const { metrics } = require("../utils/observability/metrics");

function noStore(_request, response, next) {
  response.setHeader("Cache-Control", "no-store");
  next();
}

const guards = [validatedRequest, flexUserRoleValid([ROLES.admin]), noStore];
const clientObservationGuards = [
  validatedRequest,
  flexUserRoleValid([ROLES.all]),
  noStore,
];
const clientObservationWindows = new Map();
const CHAT_CLIENT_OBSERVATION_LIMIT = 120;
const CHAT_CLIENT_OBSERVATION_WINDOW_MS = 60_000;
const CHAT_CLIENT_EVENT_TYPES = new Set([
  "first_chunk_received",
  "first_content_painted",
  "revision_lag",
  "unpainted_backlog",
  "visibility_changed",
  "reconnect_started",
  "reconnect_recovered",
  "reconnect_failed",
  "long_task",
  "scroll_jank",
  "stream_stalled",
  "stream_recovered",
  "history_sync_started",
  "history_sync_recovered",
  "history_sync_failed",
  "memory_status_recovered",
  "memory_status_failed",
]);
const CHAT_CLIENT_PLATFORMS = new Set([
  "desktop_web",
  "mobile_web",
  "ios_native",
]);
const CHAT_CLIENT_VISIBILITY = new Set(["visible", "hidden"]);
const CHAT_CLIENT_RUN_KINDS = new Set(["chat", "agent"]);
const CHAT_CLIENT_TRANSPORTS = new Set(["sse", "websocket"]);
const CHAT_CLIENT_OUTCOMES = new Set([
  "observed",
  "stalled",
  "recovered",
  "failed",
]);

function boundedChatClientValue(value, fallback, allowed) {
  const normalized = String(value || "").trim();
  return allowed.has(normalized) ? normalized : fallback;
}

function finiteObservationDuration(value, max = 60_000) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return 0;
  return Math.max(0, Math.min(duration, max));
}

function chatObservationRateKey(request, response) {
  const userId =
    response.locals.user?.id ||
    response.locals.authSession?.authUserId ||
    "anonymous";
  const clientId = String(
    request.headers?.["x-client-id"] ||
      request.headers?.["x-athena-client-id"] ||
      "unknown"
  ).slice(0, 128);
  return `${userId}:${clientId}`;
}

function allowChatObservation(request, response, count) {
  const now = Date.now();
  const key = chatObservationRateKey(request, response);
  const current = clientObservationWindows.get(key);
  const window =
    !current || now - current.startedAt >= CHAT_CLIENT_OBSERVATION_WINDOW_MS
      ? { startedAt: now, count: 0 }
      : current;
  if (window.count + count > CHAT_CLIENT_OBSERVATION_LIMIT) return false;
  window.count += count;
  clientObservationWindows.set(key, window);
  if (clientObservationWindows.size > 2_000) {
    for (const [entryKey, entry] of clientObservationWindows) {
      if (now - entry.startedAt >= CHAT_CLIENT_OBSERVATION_WINDOW_MS) {
        clientObservationWindows.delete(entryKey);
      }
    }
  }
  return true;
}

function recordChatClientObservation(request, response, input = {}) {
  const event = boundedChatClientValue(
    input.event,
    null,
    CHAT_CLIENT_EVENT_TYPES
  );
  if (!event) return false;
  const platform = boundedChatClientValue(
    input.platform,
    "desktop_web",
    CHAT_CLIENT_PLATFORMS
  );
  const visibility = boundedChatClientValue(
    input.visibility,
    "visible",
    CHAT_CLIENT_VISIBILITY
  );
  const runKind = boundedChatClientValue(
    input.runKind,
    "chat",
    CHAT_CLIENT_RUN_KINDS
  );
  const transport = boundedChatClientValue(
    input.transport,
    runKind === "agent" ? "websocket" : "sse",
    CHAT_CLIENT_TRANSPORTS
  );
  const outcome = boundedChatClientValue(
    input.outcome,
    "observed",
    CHAT_CLIENT_OUTCOMES
  );
  const durationMs = finiteObservationDuration(input.durationMs);
  const clientTurnId = String(input.clientTurnId || "")
    .trim()
    .slice(0, 160);
  const requestId = String(input.requestId || "")
    .trim()
    .slice(0, 160);
  const invocationId = String(input.invocationId || "")
    .trim()
    .slice(0, 160);
  const clientId = String(
    request.headers?.["x-client-id"] ||
      request.headers?.["x-athena-client-id"] ||
      ""
  )
    .trim()
    .slice(0, 160);

  metrics.chatClientStreamEvents.inc({
    event,
    platform,
    visibility,
    outcome,
  });
  if (["first_content_painted", "revision_lag"].includes(event)) {
    metrics.chatClientReceiveToPaint.observe(
      { platform, visibility },
      durationMs / 1000
    );
  }
  if (["unpainted_backlog", "stream_stalled"].includes(event)) {
    metrics.chatClientBacklog.observe(
      { platform, visibility },
      durationMs / 1000
    );
  }
  if (["long_task", "scroll_jank"].includes(event)) {
    metrics.chatClientLongTasks.observe({ platform }, durationMs / 1000);
  }

  const semanticTypes = {
    visibility_changed: "chat.client.visibility_changed",
    reconnect_started: "chat.client.reconnect_started",
    reconnect_recovered: "chat.client.reconnect_recovered",
    stream_stalled: "chat.client.stream_stalled",
    stream_recovered: "chat.client.stream_recovered",
    reconnect_failed: "chat.client.reconnect_failed",
    scroll_jank: "chat.client.scroll_jank",
    history_sync_started: "chat.client.history_sync_started",
    history_sync_recovered: "chat.client.history_sync_recovered",
    history_sync_failed: "chat.client.history_sync_failed",
    memory_status_recovered: "chat.client.memory_status_recovered",
    memory_status_failed: "chat.client.memory_status_failed",
  };
  if (semanticTypes[event]) {
    const informationalEvents = new Set([
      "visibility_changed",
      "reconnect_recovered",
      "stream_recovered",
      "history_sync_started",
      "history_sync_recovered",
      "memory_status_recovered",
    ]);
    emitSemanticEvent({
      eventType: semanticTypes[event],
      category: "chat_client",
      severity: informationalEvents.has(event) ? "info" : "warning",
      outcome,
      subject: {
        type: "chat_stream",
        id: clientTurnId || "unknown",
        component: `${platform}:${runKind}:${transport}`,
      },
      actor: {
        type: "client",
        id: clientId || "unknown",
      },
      correlation: {
        clientTurnId,
        requestId,
        clientId,
        invocationId,
      },
      impact: {
        userEffect: event,
        scope: visibility,
        status: outcome,
      },
      evidence: [
        {
          type: "metric",
          metric: `duration_ms=${Math.round(durationMs)}`,
        },
      ],
      metadata: { durationMs: Math.round(durationMs) },
      sensitivity: "metadata_only",
    });
  }
  return true;
}

function boundedLimit(value, fallback = 100) {
  return Math.max(
    1,
    Math.min(Number.parseInt(String(value || ""), 10) || fallback, 500)
  );
}

function filtersFromQuery(query = {}) {
  return {
    after: query.after || undefined,
    before: query.before || undefined,
    eventId: query.eventId || undefined,
    eventType: query.eventType || undefined,
    subjectId: query.subjectId || undefined,
    operationId: query.operationId || undefined,
    limit: boundedLimit(query.limit),
  };
}

function actionActor(request, response) {
  return {
    type: "human",
    role: response.locals.user?.role || "admin",
    userId: Number(
      response.locals.user?.id || response.locals.authSession?.authUserId || 0
    ),
    requestId:
      request.signedRequest?.requestId ||
      request.headers?.["x-request-id"] ||
      null,
    traceId: request.operationContext?.traceId || null,
  };
}

function actionErrorStatus(error) {
  const code = String(error?.code || "");
  if (code.includes("not_found") || code.includes("not_cataloged")) return 404;
  if (
    code.includes("conflict") ||
    code.includes("already") ||
    code.includes("scope_busy") ||
    code.includes("not_approved") ||
    code.includes("not_awaiting")
  )
    return 409;
  if (
    code.includes("disabled") ||
    code.includes("denied") ||
    code.includes("human_control") ||
    code.includes("permission_required")
  )
    return 403;
  if (code.includes("unavailable")) return 503;
  return 400;
}

function sendActionError(response, error) {
  return response.status(actionErrorStatus(error)).json({
    success: false,
    error: error?.code || "operations_action_failed",
    ...(error?.runId ? { runId: error.runId } : {}),
  });
}

function operationsEndpoints(app) {
  app.post(
    "/operations/client-chat-observations",
    clientObservationGuards,
    (request, response) => {
      const entries = (
        Array.isArray(request.body?.observations)
          ? request.body.observations
          : [request.body]
      ).slice(0, 20);
      if (!allowChatObservation(request, response, entries.length)) {
        response.setHeader("Retry-After", "60");
        return response
          .status(429)
          .json({ success: false, error: "chat_observation_rate_limited" });
      }
      const accepted = entries.reduce(
        (count, entry) =>
          count +
          (recordChatClientObservation(request, response, entry) ? 1 : 0),
        0
      );
      return response.status(202).json({ success: true, accepted });
    }
  );

  app.get("/operations/health", guards, (_request, response) => {
    response.status(200).json({
      success: true,
      ...operationsPlane.health(),
      actions: operationsActionRuntime.snapshot(),
      shadowAgents: operationsShadowRuntime.snapshot(),
    });
  });

  app.get("/operations/schemas", guards, (_request, response) => {
    response.status(200).json({ success: true, schemas: schemaManifest() });
  });

  app.get("/operations/schemas/:name/:version", guards, (request, response) => {
    const entry = getSchema(request.params.name, request.params.version);
    if (!entry)
      return response.status(404).json({
        success: false,
        error: "operations_schema_not_found",
      });
    return response.status(200).json({
      success: true,
      name: entry.name,
      version: entry.version,
      fingerprint: entry.fingerprint,
      schema: entry.schema,
    });
  });

  app.get("/operations/services", guards, (_request, response) => {
    response.status(200).json({
      success: true,
      generatedAt: new Date().toISOString(),
      services: serviceCatalog(),
    });
  });

  app.get("/operations/agents", guards, async (request, response) => {
    try {
      const registry = await agentRegistrySnapshot({
        invocationLimit: boundedLimit(request.query.limit),
      });
      response.status(200).json({ success: true, ...registry });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_agent_registry_unavailable",
        reasonCode: error?.code || "agent_registry_read_failed",
      });
    }
  });

  app.get("/operations/shadow-agents", guards, (_request, response) => {
    response.status(200).json({
      success: true,
      ...operationsShadowRuntime.snapshot(),
    });
  });

  app.get("/operations/evaluations/latest", guards, (_request, response) => {
    response.status(200).json({
      success: true,
      report: operationsShadowRuntime.evaluation(),
    });
  });

  app.get("/operations/evaluations/corpus", guards, (_request, response) => {
    response.status(200).json({
      success: true,
      manifest: operationsShadowRuntime.corpus(),
    });
  });

  app.get("/operations/actions/catalog", guards, (_request, response) => {
    response.status(200).json({
      success: true,
      mode: "human-approved",
      agentExecutionAllowed: false,
      actions: operationsActionOrchestrator.catalog(),
    });
  });

  app.get("/operations/actions/runs", guards, async (request, response) => {
    try {
      const runs = await DataAccessCenter.operationsAction.listRuns({
        status: request.query.status || null,
        actionId: request.query.actionId || null,
        limit: boundedLimit(request.query.limit),
      });
      response.status(200).json({ success: true, runs });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.get(
    "/operations/actions/runs/:runId",
    guards,
    async (request, response) => {
      try {
        const run = await DataAccessCenter.operationsAction.getRun(
          request.params.runId
        );
        if (!run)
          return response.status(404).json({
            success: false,
            error: "operations_action_run_not_found",
          });
        const approvals =
          await DataAccessCenter.operationsAction.approvalsForRun(run.id);
        return response.status(200).json({ success: true, run, approvals });
      } catch (error) {
        return sendActionError(response, error);
      }
    }
  );

  app.post("/operations/actions/runs", guards, async (request, response) => {
    try {
      const run = await operationsActionOrchestrator.propose({
        actionId: request.body?.actionId,
        parameters: request.body?.parameters || {},
        sourceActionId: request.body?.sourceActionId,
        actor: actionActor(request, response),
      });
      return response.status(201).json({ success: true, run });
    } catch (error) {
      return sendActionError(response, error);
    }
  });

  app.post(
    "/operations/actions/runs/:runId/approve",
    guards,
    async (request, response) => {
      try {
        const run = await operationsActionOrchestrator.decide({
          runId: request.params.runId,
          decision: "approved",
          reasonCode: request.body?.reasonCode || null,
          actor: actionActor(request, response),
        });
        return response.status(200).json({ success: true, run });
      } catch (error) {
        return sendActionError(response, error);
      }
    }
  );

  app.post(
    "/operations/actions/runs/:runId/reject",
    guards,
    async (request, response) => {
      try {
        const run = await operationsActionOrchestrator.decide({
          runId: request.params.runId,
          decision: "rejected",
          reasonCode: request.body?.reasonCode || null,
          actor: actionActor(request, response),
        });
        return response.status(200).json({ success: true, run });
      } catch (error) {
        return sendActionError(response, error);
      }
    }
  );

  app.post(
    "/operations/actions/runs/:runId/execute",
    guards,
    async (request, response) => {
      try {
        const run = await DataAccessCenter.operationsAction.getRun(
          request.params.runId
        );
        if (!run)
          return response.status(404).json({
            success: false,
            error: "operations_action_run_not_found",
          });
        if (run.status !== "approved")
          return response.status(409).json({
            success: false,
            error: "operations_action_not_approved",
          });
        const accepted = operationsActionRuntime.executeAsync(
          run.id,
          actionActor(request, response)
        );
        if (!accepted)
          return response.status(409).json({
            success: false,
            error: "operations_action_already_running",
          });
        return response.status(202).json({
          success: true,
          runId: run.id,
          status: "execution_accepted",
        });
      } catch (error) {
        return sendActionError(response, error);
      }
    }
  );

  app.post(
    "/operations/actions/runs/:runId/reconcile",
    guards,
    async (request, response) => {
      try {
        const run = await operationsActionOrchestrator.reconcile(
          request.params.runId,
          actionActor(request, response)
        );
        return response.status(200).json({ success: true, run });
      } catch (error) {
        return sendActionError(response, error);
      }
    }
  );

  app.get("/operations/timeline", guards, async (request, response) => {
    const timeline = await operationsPlane.timelineWithMetadata(
      filtersFromQuery(request.query)
    );
    response.status(200).json({
      success: true,
      generatedAt: new Date().toISOString(),
      ...timeline,
    });
  });

  app.get("/operations/state-graph", guards, async (request, response) => {
    try {
      const [events, agents, syncState] = await Promise.all([
        operationsPlane.timeline({
          limit: boundedLimit(request.query.limit, 250),
        }),
        agentDefinitions(),
        DataAccessCenter.syncV2.snapshot(),
      ]);
      response.status(200).json({
        success: true,
        graph: buildStateGraph({ events, agents, syncState }),
      });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_state_graph_unavailable",
        reasonCode: error?.code || "state_graph_read_failed",
      });
    }
  });

  app.get("/operations/explain", guards, async (request, response) => {
    const eventId = String(request.query.eventId || "").trim();
    const operationId = String(request.query.operationId || "").trim();
    if (!eventId && !operationId)
      return response.status(400).json({
        success: false,
        error: "eventId_or_operationId_required",
      });
    const result = await operationsPlane.timelineWithMetadata({
      ...(eventId ? { eventId } : { operationId }),
      limit: boundedLimit(request.query.limit, 100),
    });
    const primary = result.events[0] || null;
    if (!primary)
      return response
        .status(result.completeness === "complete" ? 404 : 503)
        .json({
          success: false,
          error:
            result.completeness === "complete"
              ? "operations_evidence_not_found"
              : "operations_evidence_incomplete",
          degraded: result.degraded,
          completeness: result.completeness,
          sources: result.sources,
        });
    return response.status(200).json({
      success: true,
      answer: explainEvent(primary),
      timeline: result.events,
      source: result.source,
      degraded: result.degraded,
      completeness: result.completeness,
      sources: result.sources,
    });
  });
}

module.exports = {
  actionActor,
  actionErrorStatus,
  boundedLimit,
  filtersFromQuery,
  operationsEndpoints,
};
