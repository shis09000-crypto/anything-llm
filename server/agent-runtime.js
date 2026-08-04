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
  drainAgentRuntime,
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
  onStart: () => secureDatabaseStart(role),
  onDrain: async () => {
    stopAgentRunRecovery?.();
    stopAgentRunRecovery = null;
    return drainAgentRuntime({ timeoutMs: drainTimeoutMs });
  },
  registerRoutes: (app) => {
    registerCompatibleApi(app, agentWebsocket);
    app.post("/internal/v1/agent/invocations", async (request, response) => {
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
  },
  internalRouteCapabilities: {
    "POST /internal/v1/agent/invocations": "agent.submit",
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
