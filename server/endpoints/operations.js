const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const {
  getSchema,
  schemaManifest,
} = require("../utils/operations/schemaRegistry");
const { operationsAccess } = require("../utils/operations/access");
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
const CHAT_CLIENT_TRANSPORTS = new Set(["sse", "websocket", "ledger_poll"]);
const CHAT_CLIENT_OUTCOMES = new Set([
  "observed",
  "stalled",
  "recovered",
  "failed",
]);
const CLIENT_UI_EVENT_TYPES = new Set([
  "overview_preempted",
  "overview_recovered",
  "overview_failed",
  "auth_reconnecting",
  "auth_recovered",
  "auth_terminal",
  "passkey_local_ready",
  "passkey_cross_device_only",
  "passkey_unavailable",
]);
const CLIENT_UI_SURFACES = new Set([
  "workspace_overview",
  "auth_lifecycle",
  "passkey_capability",
]);
const CLIENT_UI_REASONS = new Set([
  "scheduler_abort",
  "http_error",
  "network_error",
  "identity_unavailable",
  "session_expired",
  "session_idle_expired",
  "session_revoked",
  "session_epoch_incompatible",
  "account_disabled",
  "account_suspended",
  "client_revoked",
  "device_identity_reauth",
  "force_reauth",
  "insecure_context",
  "rp_id_invalid",
  "server_passkey_disabled",
  "webauthn_unavailable",
  "embedded_webview_unsupported",
  "platform_authenticator_unavailable",
  "no_available_authenticator",
  "webauthn_security_error",
  "none",
  "unknown",
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

function recordClientUiObservation(request, response, input = {}) {
  const event = boundedChatClientValue(
    input.event,
    null,
    CLIENT_UI_EVENT_TYPES
  );
  if (!event) return false;
  const surface = boundedChatClientValue(
    input.surface,
    "workspace_overview",
    CLIENT_UI_SURFACES
  );
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
  const outcome = boundedChatClientValue(
    input.outcome,
    "observed",
    CHAT_CLIENT_OUTCOMES
  );
  const reason = boundedChatClientValue(
    input.reason,
    "unknown",
    CLIENT_UI_REASONS
  );
  const durationMs = finiteObservationDuration(input.durationMs);
  const retryCount = Math.max(
    0,
    Math.min(Number.parseInt(String(input.retryCount || 0), 10) || 0, 20)
  );
  const requestId = String(input.requestId || "")
    .trim()
    .slice(0, 160);
  const clientId = String(
    request.headers?.["x-client-id"] ||
      request.headers?.["x-athena-client-id"] ||
      ""
  )
    .trim()
    .slice(0, 160);

  metrics.clientUiEvents.inc({
    event,
    surface,
    platform,
    visibility,
    outcome,
  });

  const semanticTypes = {
    overview_preempted: "navigation.client.overview_preempted",
    overview_recovered: "navigation.client.overview_recovered",
    overview_failed: "navigation.client.overview_failed",
    auth_reconnecting: "auth.client.reconnecting",
    auth_recovered: "auth.client.recovered",
    auth_terminal: "auth.client.terminal",
    passkey_local_ready: "auth.passkey.capability_local_ready",
    passkey_cross_device_only: "auth.passkey.capability_cross_device_only",
    passkey_unavailable: "auth.passkey.capability_unavailable",
  };
  const category =
    surface === "workspace_overview" ? "navigation_client" : "auth_client";
  emitSemanticEvent({
    eventType: semanticTypes[event],
    category,
    severity: ["overview_failed", "auth_terminal"].includes(event)
      ? "warning"
      : "info",
    outcome,
    subject: {
      type: "client_ui",
      id: requestId || clientId || "unknown",
      component: `${platform}:${surface}`,
    },
    actor: {
      type: "client",
      id: clientId || "unknown",
    },
    correlation: {
      requestId,
      clientId,
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
    metadata: {
      durationMs: Math.round(durationMs),
      errorCode: reason,
      statusCode: String(retryCount),
      platform: surface,
    },
    sensitivity: "metadata_only",
  });
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
    traceId: query.traceId || undefined,
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
  app.post(
    "/operations/client-ui-observations",
    clientObservationGuards,
    (request, response) => {
      const entries = (
        Array.isArray(request.body?.observations)
          ? request.body.observations
          : [request.body]
      ).slice(0, 20);
      if (!allowChatObservation(request, response, entries.length)) {
        response.setHeader("Retry-After", "60");
        return response.status(429).json({
          success: false,
          error: "client_ui_observation_rate_limited",
        });
      }
      const accepted = entries.reduce(
        (count, entry) =>
          count + (recordClientUiObservation(request, response, entry) ? 1 : 0),
        0
      );
      return response.status(202).json({ success: true, accepted });
    }
  );

  app.get("/operations/health", guards, async (_request, response) => {
    try {
      response.status(200).json({
        success: true,
        ...(await operationsAccess().health()),
      });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_plane_unavailable",
        reasonCode: error?.code || "operations_health_read_failed",
      });
    }
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

  app.get("/operations/services", guards, async (_request, response) => {
    try {
      response.status(200).json({
        success: true,
        ...(await operationsAccess().services()),
      });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_service_catalog_unavailable",
        reasonCode: error?.code || "service_catalog_read_failed",
      });
    }
  });

  app.get("/operations/agents", guards, async (request, response) => {
    try {
      const registry = await operationsAccess().agents(
        boundedLimit(request.query.limit)
      );
      response.status(200).json({ success: true, ...registry });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_agent_registry_unavailable",
        reasonCode: error?.code || "agent_registry_read_failed",
      });
    }
  });

  app.get("/operations/shadow-agents", guards, async (_request, response) => {
    try {
      response.status(200).json({
        success: true,
        ...(await operationsAccess().shadowAgents()),
      });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_shadow_agents_unavailable",
        reasonCode: error?.code || "shadow_agents_read_failed",
      });
    }
  });

  app.get(
    "/operations/evaluations/latest",
    guards,
    async (_request, response) => {
      try {
        response.status(200).json({
          success: true,
          ...(await operationsAccess().evaluationLatest()),
        });
      } catch (error) {
        response.status(503).json({
          success: false,
          error: "operations_evaluation_unavailable",
          reasonCode: error?.code || "evaluation_read_failed",
        });
      }
    }
  );

  app.get(
    "/operations/evaluations/corpus",
    guards,
    async (_request, response) => {
      try {
        response.status(200).json({
          success: true,
          ...(await operationsAccess().evaluationCorpus()),
        });
      } catch (error) {
        response.status(503).json({
          success: false,
          error: "operations_evaluation_corpus_unavailable",
          reasonCode: error?.code || "evaluation_corpus_read_failed",
        });
      }
    }
  );

  app.get("/operations/actions/catalog", guards, async (_request, response) => {
    try {
      response.status(200).json({
        success: true,
        ...(await operationsAccess().actionsCatalog()),
      });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_action_catalog_unavailable",
        reasonCode: error?.code || "action_catalog_read_failed",
      });
    }
  });

  app.get("/operations/actions/runs", guards, async (request, response) => {
    try {
      const result = await operationsAccess().actionRuns({
        status: request.query.status || null,
        actionId: request.query.actionId || null,
        limit: boundedLimit(request.query.limit),
      });
      response.status(200).json({ success: true, ...result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.get(
    "/operations/actions/runs/:runId",
    guards,
    async (request, response) => {
      try {
        const result = await operationsAccess().actionRun(request.params.runId);
        if (!result.run)
          return response.status(404).json({
            success: false,
            error: "operations_action_run_not_found",
          });
        return response.status(200).json({ success: true, ...result });
      } catch (error) {
        return sendActionError(response, error);
      }
    }
  );

  app.post("/operations/actions/runs", guards, async (request, response) => {
    try {
      const result = await operationsAccess().proposeAction({
        actionId: request.body?.actionId,
        parameters: request.body?.parameters || {},
        sourceActionId: request.body?.sourceActionId,
        actor: actionActor(request, response),
      });
      return response.status(201).json({ success: true, ...result });
    } catch (error) {
      return sendActionError(response, error);
    }
  });

  app.post(
    "/operations/actions/runs/:runId/approve",
    guards,
    async (request, response) => {
      try {
        const result = await operationsAccess().decideAction({
          runId: request.params.runId,
          decision: "approved",
          reasonCode: request.body?.reasonCode || null,
          actor: actionActor(request, response),
        });
        return response.status(200).json({ success: true, ...result });
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
        const result = await operationsAccess().decideAction({
          runId: request.params.runId,
          decision: "rejected",
          reasonCode: request.body?.reasonCode || null,
          actor: actionActor(request, response),
        });
        return response.status(200).json({ success: true, ...result });
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
        const result = await operationsAccess().executeAction({
          runId: request.params.runId,
          actor: actionActor(request, response),
        });
        if (!result.run)
          return response.status(404).json({
            success: false,
            error: "operations_action_run_not_found",
          });
        if (!result.accepted)
          return response.status(409).json({
            success: false,
            error: "operations_action_already_running",
          });
        return response.status(202).json({
          success: true,
          runId: result.run.id,
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
        const result = await operationsAccess().reconcileAction({
          runId: request.params.runId,
          actor: actionActor(request, response),
        });
        return response.status(200).json({ success: true, ...result });
      } catch (error) {
        return sendActionError(response, error);
      }
    }
  );

  app.get("/operations/timeline", guards, async (request, response) => {
    try {
      response.status(200).json({
        success: true,
        ...(await operationsAccess().timeline(filtersFromQuery(request.query))),
      });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_timeline_unavailable",
        reasonCode: error?.code || "timeline_read_failed",
      });
    }
  });

  app.get("/operations/state-graph", guards, async (request, response) => {
    try {
      response.status(200).json({
        success: true,
        ...(await operationsAccess().stateGraph({
          limit: boundedLimit(request.query.limit, 250),
        })),
      });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_state_graph_unavailable",
        reasonCode: error?.code || "state_graph_read_failed",
      });
    }
  });

  app.get("/operations/aicp/topology", guards, async (_request, response) => {
    try {
      response.status(200).json({
        success: true,
        ...(await operationsAccess().aicpTopology()),
      });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_aicp_topology_unavailable",
        reasonCode: error?.code || "aicp_topology_read_failed",
      });
    }
  });

  app.get(
    "/operations/aicp/traces/:traceId",
    guards,
    async (request, response) => {
      try {
        const result = await operationsAccess().aicpTrace(
          request.params.traceId
        );
        if (!result.trace?.found)
          return response.status(404).json({
            success: false,
            error: "operations_aicp_trace_not_found",
          });
        return response.status(200).json({ success: true, ...result });
      } catch (error) {
        return response.status(503).json({
          success: false,
          error: "operations_aicp_trace_unavailable",
          reasonCode: error?.code || "aicp_trace_read_failed",
        });
      }
    }
  );

  app.get("/operations/flows", guards, async (request, response) => {
    try {
      response.status(200).json({
        success: true,
        ...(await operationsAccess().flows(filtersFromQuery(request.query))),
      });
    } catch (error) {
      response.status(503).json({
        success: false,
        error: "operations_flows_unavailable",
        reasonCode: error?.code || "flows_read_failed",
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
    let result;
    try {
      result = await operationsAccess().explain({
        eventId,
        operationId,
        limit: boundedLimit(request.query.limit, 100),
      });
    } catch (error) {
      return response.status(503).json({
        success: false,
        error: "operations_evidence_unavailable",
        reasonCode: error?.code || "operations_explain_failed",
      });
    }
    if (!result.found)
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
      answer: result.answer,
      timeline: result.timeline,
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
