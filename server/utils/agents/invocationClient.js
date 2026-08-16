const crypto = require("crypto");
const {
  requestInternalService,
  requestInternalStream,
} = require("../microModules");
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

async function streamRemoteAgentInvocation(
  {
    invocationId,
    attachments = [],
    displayAttachments = attachments,
    displayPrompt = null,
    reservedPublicChatId = null,
    visionAnalysisContext = null,
    fileAccess = {},
    executionTarget = null,
    onEvent,
  },
  env = process.env
) {
  const response = await requestInternalStream({
    callerRole: "chat-runtime",
    targetModule: "agent-runtime",
    capability: "agent.turn.stream",
    contractVersion: "1.0",
    url: `${agentRuntimeUrl(env)}/internal/v1/agent/invocations/${encodeURIComponent(
      invocationId
    )}/stream`,
    body: {
      attachments,
      displayAttachments,
      displayPrompt,
      reservedPublicChatId,
      visionAnalysisContext,
      fileAccess,
      executionTarget,
    },
    idempotencyKey: String(invocationId),
    env,
    timeoutMs: Number(env.ATHENA_AGENT_TURN_TIMEOUT_MS || 600_000),
  });

  let buffer = "";
  for await (const chunk of response) {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent?.(JSON.parse(line));
      } catch {
        const error = new Error("agent_turn_stream_invalid_event");
        error.code = "agent_turn_stream_invalid_event";
        throw error;
      }
    }
  }
  if (buffer.trim()) onEvent?.(JSON.parse(buffer));
}

function remoteAgentCommand(
  { invocationId, path, capability, body = {} },
  env
) {
  return requestInternalService({
    callerRole: "chat-runtime",
    targetModule: "agent-runtime",
    capability,
    contractVersion: "1.0",
    url: `${agentRuntimeUrl(env)}/internal/v1/agent/invocations/${encodeURIComponent(
      invocationId
    )}/${path}`,
    body,
    idempotencyKey: `${invocationId}:${path}`,
    env,
    timeoutMs: Number(env.ATHENA_AGENT_RUNTIME_TIMEOUT_MS || 30_000),
  });
}

function submitRemoteAgentAction(
  { invocationId, actionId, body = {} },
  env = process.env
) {
  return remoteAgentCommand(
    {
      invocationId,
      path: `actions/${encodeURIComponent(actionId)}`,
      capability: "agent.turn.action",
      body,
    },
    env
  );
}

function cancelRemoteAgentInvocation(invocationId, env = process.env) {
  return remoteAgentCommand(
    {
      invocationId,
      path: "cancel",
      capability: "agent.turn.cancel",
      body: {},
    },
    env
  );
}

module.exports = {
  agentRuntimeUrl,
  createRemoteAgentInvocation,
  cancelRemoteAgentInvocation,
  remoteAgentInvocationEnabled,
  submitRemoteAgentAction,
  streamRemoteAgentInvocation,
};
