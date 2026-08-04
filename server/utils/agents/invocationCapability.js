const { DataAccessCenter } = require("../dataAccess");

function optionalPositiveInteger(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`agent_submit_${field}_invalid`);
    error.code = "AGENT_SUBMIT_CONTRACT_INVALID";
    throw error;
  }
  return parsed;
}

function optionalBoundedString(value, field, maxLength) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > maxLength) {
    const error = new Error(`agent_submit_${field}_invalid`);
    error.code = "AGENT_SUBMIT_CONTRACT_INVALID";
    throw error;
  }
  return normalized;
}

function normalizedSubmission(body = {}) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt || Buffer.byteLength(prompt, "utf8") > 1_048_576) {
    const error = new Error("agent_submit_prompt_invalid");
    error.code = "AGENT_SUBMIT_CONTRACT_INVALID";
    throw error;
  }
  const workspaceId = optionalPositiveInteger(body.workspaceId, "workspace_id");
  if (!workspaceId) {
    const error = new Error("agent_submit_workspace_id_required");
    error.code = "AGENT_SUBMIT_CONTRACT_INVALID";
    throw error;
  }
  const clientTurnId = String(body.clientTurnId || "").trim() || null;
  if (clientTurnId && clientTurnId.length > 160) {
    const error = new Error("agent_submit_client_turn_id_invalid");
    error.code = "AGENT_SUBMIT_CONTRACT_INVALID";
    throw error;
  }
  return {
    prompt,
    workspaceId,
    userId: optionalPositiveInteger(body.userId, "user_id"),
    threadId: optionalPositiveInteger(body.threadId, "thread_id"),
    clientTurnId,
    requestedProvider: optionalBoundedString(
      body.requestedProvider,
      "requested_provider",
      80
    ),
    requestedModel: optionalBoundedString(
      body.requestedModel,
      "requested_model",
      160
    ),
  };
}

async function submitAgentInvocation(
  body,
  { workspaceAgentInvocation = DataAccessCenter.workspaceAgentInvocation } = {}
) {
  const submission = normalizedSubmission(body);
  const result = await workspaceAgentInvocation.new({
    prompt: submission.prompt,
    workspace: { id: submission.workspaceId },
    user: submission.userId ? { id: submission.userId } : null,
    thread: submission.threadId ? { id: submission.threadId } : null,
    clientTurnId: submission.clientTurnId,
    requestedProvider: submission.requestedProvider,
    requestedModel: submission.requestedModel,
  });
  if (!result?.invocation?.uuid) {
    const error = new Error(
      result?.message || "agent_invocation_store_unavailable"
    );
    error.code = "AGENT_INVOCATION_STORE_UNAVAILABLE";
    throw error;
  }
  return {
    invocation: {
      uuid: result.invocation.uuid,
      clientTurnId: result.invocation.clientTurnId || submission.clientTurnId,
    },
    replayed: result.replayed === true,
  };
}

module.exports = { normalizedSubmission, submitAgentInvocation };
