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
  const planAction =
    String(body.planAction || "")
      .trim()
      .slice(0, 32) || null;
  if (
    planAction &&
    !["create", "revise", "execute", "attach"].includes(planAction)
  ) {
    const error = new Error("agent_submit_plan_action_invalid");
    error.code = "AGENT_SUBMIT_CONTRACT_INVALID";
    throw error;
  }
  return {
    prompt,
    workspaceId,
    userId: optionalPositiveInteger(body.userId, "user_id"),
    threadId: optionalPositiveInteger(body.threadId, "thread_id"),
    clientTurnId,
    requestedProvider:
      String(body.requestedProvider || "")
        .trim()
        .slice(0, 80) || null,
    requestedModel:
      String(body.requestedModel || "")
        .trim()
        .slice(0, 160) || null,
    effectiveModel:
      String(body.effectiveModel || "")
        .trim()
        .slice(0, 160) || null,
    turnMode: String(body.turnMode || "normal") === "plan" ? "plan" : "normal",
    goalId:
      String(body.goalId || "")
        .trim()
        .slice(0, 160) || null,
    planId:
      String(body.planId || "")
        .trim()
        .slice(0, 160) || null,
    planAction,
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
    effectiveModel: submission.effectiveModel,
    turnMode: submission.turnMode,
    goalId: submission.goalId,
    planId: submission.planId,
    planAction: submission.planAction,
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
