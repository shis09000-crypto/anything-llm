const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "agent-runtime";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const {
  agentRuntimeSnapshot,
  agentWebsocket,
  cancelAgentInvocation,
  drainAgentRuntime,
  submitAgentInvocationAction,
  streamAgentInvocation,
} = require("./endpoints/agentWebsocket");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  registerCompatibleApi,
  secureDatabaseStart,
} = require("./utils/microModules");
const { DataAccessCenter } = require("./utils/dataAccess");
const {
  submitAgentInvocation,
} = require("./utils/agents/invocationCapability");
const { startAgentRunRecovery } = require("./utils/agents/agentRunRecovery");
const {
  agentPersistenceContractSnapshot,
  refreshAgentPersistenceContract,
} = require("./utils/agents/invocationPersistenceContract");

const role = "agent-runtime";
const port = Number(process.env.AGENT_RUNTIME_PORT || 3017);
const drainTimeoutMs = Number(
  process.env.ATHENA_RUNTIME_DRAIN_TIMEOUT_MS || 120_000
);
let stopAgentRunRecovery = null;

const host = new MicroModuleServiceHost({
  manifestId: "agent-runtime",
  role,
  port,
  enableWebSockets: true,
  parseJson: false,
  readiness: agentRuntimeSnapshot,
  onStart: async () => {
    await secureDatabaseStart(role);
    await refreshAgentPersistenceContract();
  },
  onDrain: async () => {
    stopAgentRunRecovery?.();
    stopAgentRunRecovery = null;
    return drainAgentRuntime({ timeoutMs: drainTimeoutMs });
  },
  registerRoutes: (app) => {
    registerCompatibleApi(app, agentWebsocket);
    app.post("/internal/v1/agent/invocations", async (request, response) => {
      const persistenceContract = agentPersistenceContractSnapshot();
      if (!persistenceContract.ready)
        return response.status(503).json({
          success: false,
          error: "agent_persistence_contract_incompatible",
          reasonCode: persistenceContract.reasonCode,
        });
      try {
        const result = await submitAgentInvocation(request.body);
        response.status(result.replayed ? 200 : 201).json({
          success: true,
          ...result,
        });
      } catch (error) {
        const contractInvalid = error?.code === "AGENT_SUBMIT_CONTRACT_INVALID";
        response.status(contractInvalid ? 400 : 503).json({
          success: false,
          error: contractInvalid
            ? "agent_submit_contract_invalid"
            : "agent_invocation_store_unavailable",
        });
      }
    });
    app.get(
      "/internal/v1/agent/runs/:invocationId",
      async (request, response) => {
        const run = await DataAccessCenter.agentRun.state(
          request.params.invocationId
        );
        response.status(run ? 200 : 404).json({
          success: Boolean(run),
          run: run
            ? {
                invocationId: run.invocationId,
                status: run.status,
                latestSequence: run.latestSequence,
                finalChatId: run.finalChatId,
                finalPublicChatId: run.finalPublicChatId,
                errorCode: run.errorCode,
                completedAt: run.completedAt,
                lastUpdatedAt: run.lastUpdatedAt,
              }
            : null,
          ...(!run ? { error: "agent_run_not_found" } : {}),
        });
      }
    );
    app.post(
      "/internal/v1/agent/invocations/:invocationId/stream",
      async (request, response) => {
        response.status(200);
        response.setHeader("Content-Type", "application/x-ndjson");
        response.setHeader("Cache-Control", "no-cache, no-transform");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders?.();
        try {
          await streamAgentInvocation({
            uuid: request.params.invocationId,
            attachments: request.body?.attachments || [],
            displayAttachments:
              request.body?.displayAttachments ||
              request.body?.attachments ||
              [],
            displayPrompt: request.body?.displayPrompt || null,
            reservedPublicChatId: request.body?.reservedPublicChatId || null,
            visionAnalysisContext: request.body?.visionAnalysisContext || null,
            fileAccess: request.body?.fileAccess || {},
            executionTarget: request.body?.executionTarget || null,
            onEvent(event) {
              if (response.destroyed || response.writableEnded) return;
              response.write(`${JSON.stringify(event)}\n`);
            },
          });
        } catch (error) {
          if (!response.destroyed && !response.writableEnded) {
            response.write(
              `${JSON.stringify({
                type: "response.failed",
                response: {
                  id: request.params.invocationId,
                  object: "response",
                  status: "failed",
                  error: {
                    code: error?.code || "agent_turn_failed",
                    message: error?.message || "Agent turn failed.",
                  },
                },
              })}\n`
            );
          }
        } finally {
          if (!response.destroyed && !response.writableEnded) response.end();
        }
      }
    );
    app.post(
      "/internal/v1/agent/invocations/:invocationId/actions/:actionId",
      async (request, response) => {
        const result = submitAgentInvocationAction(
          request.params.invocationId,
          request.params.actionId,
          request.body || {}
        );
        response.status(result.success ? 200 : 409).json(result);
      }
    );
    app.post(
      "/internal/v1/agent/invocations/:invocationId/cancel",
      async (request, response) => {
        response.json(await cancelAgentInvocation(request.params.invocationId));
      }
    );
  },
  internalRouteCapabilities: {
    "POST /internal/v1/agent/invocations": "agent.submit",
    "POST /internal/v1/agent/invocations/:invocationId/stream":
      "agent.turn.stream",
    "POST /internal/v1/agent/invocations/:invocationId/actions/:actionId":
      "agent.turn.action",
    "POST /internal/v1/agent/invocations/:invocationId/cancel":
      "agent.turn.cancel",
    "GET /internal/v1/agent/runs/:invocationId": "agent.status",
  },
});

installStandaloneShutdown(host, { name: "AgentRuntime" });
host
  .start()
  .then((snapshot) => {
    stopAgentRunRecovery = startAgentRunRecovery();
    console.log(`[AgentRuntime] listening on ${host.port}`, snapshot);
  })
  .catch((error) => {
    console.error("[AgentRuntime] failed to start", error);
    process.exitCode = 1;
  });
