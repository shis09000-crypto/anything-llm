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

function noStore(_request, response, next) {
  response.setHeader("Cache-Control", "no-store");
  next();
}

const guards = [validatedRequest, flexUserRoleValid([ROLES.admin]), noStore];

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
    const events = await operationsPlane.timeline(
      filtersFromQuery(request.query)
    );
    response.status(200).json({
      success: true,
      generatedAt: new Date().toISOString(),
      events,
      source: operationsPlane.health().clickhouse.ready
        ? "clickhouse"
        : "recent-buffer",
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
    const timeline = await operationsPlane.timeline({
      ...(eventId ? { eventId } : { operationId }),
      limit: boundedLimit(request.query.limit, 100),
    });
    const primary = timeline[0] || null;
    if (!primary)
      return response.status(404).json({
        success: false,
        error: "operations_evidence_not_found",
      });
    return response.status(200).json({
      success: true,
      answer: explainEvent(primary),
      timeline,
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
