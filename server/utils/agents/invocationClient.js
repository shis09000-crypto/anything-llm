const crypto = require("crypto");
const { requestInternalService } = require("../microModules");
const { distributedTopology } = require("../microModules/serviceHost");

function agentRuntimeUrl(env = process.env) {
  const configured = String(env.ATHENA_AGENT_RUNTIME_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (distributedTopology(env))
    return "https://anything-llm-agent-runtime:3017";
  return null;
}

function remoteAgentInvocationEnabled(env = process.env) {
  return (
    env.ATHENA_RUNTIME_ROLE === "chat-runtime" &&
    distributedTopology(env) &&
    Boolean(agentRuntimeUrl(env))
  );
}

async function createRemoteAgentInvocation(
  { prompt, workspace, user = null, thread = null, clientTurnId = null },
  env = process.env
) {
  if (!remoteAgentInvocationEnabled(env)) {
    const error = new Error("agent_runtime_submission_not_enabled");
    error.code = "AGENT_RUNTIME_SUBMISSION_NOT_ENABLED";
    throw error;
  }
  const body = {
    prompt,
    workspaceId: workspace?.id ?? null,
    userId: user?.id ?? null,
    threadId: thread?.id ?? null,
    clientTurnId,
  };
  const response = await requestInternalService({
    callerRole: "chat-runtime",
    targetModule: "agent-runtime",
    capability: "agent.submit",
    contractVersion: "1.0",
    url: `${agentRuntimeUrl(env)}/internal/v1/agent/invocations`,
    body,
    idempotencyKey:
      String(clientTurnId || "").trim() ||
      crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    env,
    timeoutMs: Number(env.ATHENA_AGENT_RUNTIME_TIMEOUT_MS || 30_000),
  });
  if (!response?.success || !response?.invocation?.uuid) {
    const error = new Error(
      response?.error || "agent_invocation_store_unavailable"
    );
    error.code = response?.error || "AGENT_INVOCATION_STORE_UNAVAILABLE";
    throw error;
  }
  return {
    invocation: response.invocation,
    message: null,
    replayed: response.replayed === true,
  };
}

module.exports = {
  agentRuntimeUrl,
  createRemoteAgentInvocation,
  remoteAgentInvocationEnabled,
};
