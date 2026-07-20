const { DataAccessCenter } = require("../dataAccess");
const { governanceMode } = require("./config");

function estimatedTokens(messages = []) {
  const text = (Array.isArray(messages) ? messages : [messages])
    .map((message) =>
      typeof message === "string" ? message : JSON.stringify(message || {})
    )
    .join("\n");
  return Math.max(0, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

class ModelExecutionContext {
  constructor(context, reservation) {
    this.context = context;
    this.reservation = reservation;
    this.closed = false;
  }

  static async begin(context = {}, budget = {}) {
    const mode = governanceMode();
    if (mode === "off")
      return new ModelExecutionContext(context, { mode, reservation: null });
    const reservation = await DataAccessCenter.aiGovernance.reserve({
      ownerType: context.ownerType || "system",
      ownerId: context.ownerId || "global",
      userId: context.userId || null,
      workspaceId: context.workspaceId || null,
      taskType: context.taskType,
      provider: context.provider || "unknown",
      model: context.model || "unknown",
      inputTokens: budget.inputTokens || 0,
      outputTokens: budget.outputTokens || 0,
      toolCalls: budget.toolCalls || 0,
      durationMs: budget.durationMs || 0,
    });
    return new ModelExecutionContext(context, reservation);
  }

  async settle(usage = {}, metadata = {}) {
    if (this.closed) return null;
    this.closed = true;
    if (!this.reservation?.reservation) return null;
    return DataAccessCenter.aiGovernance.settle({
      reservation: this.reservation.reservation,
      usage,
      metadata,
    });
  }

  async fail(error) {
    if (this.closed) return null;
    this.closed = true;
    if (!this.reservation?.reservation) return null;
    return DataAccessCenter.aiGovernance.release({
      reservation: this.reservation.reservation,
      error,
    });
  }
}

async function beginModelExecution(context, { messages = [], ...budget } = {}) {
  return ModelExecutionContext.begin(context, {
    inputTokens: budget.inputTokens ?? estimatedTokens(messages),
    outputTokens: budget.outputTokens ?? 2_048,
    toolCalls: budget.toolCalls ?? 0,
    durationMs: budget.durationMs ?? 120_000,
  });
}

async function observeModelUsageSafely({
  ownerType = "system",
  ownerId = "global",
  userId = null,
  workspaceId = null,
  taskType,
  provider,
  model,
  usage = {},
  metadata = {},
}) {
  if (governanceMode() === "off") return { skipped: true };
  try {
    const execution = await ModelExecutionContext.begin({
      ownerType,
      ownerId,
      userId,
      workspaceId,
      taskType,
      provider,
      model,
    });
    const event = await execution.settle(usage, metadata);
    return { skipped: false, event };
  } catch (error) {
    console.error("[AIGovernance] usage observation failed", {
      code: error?.code || "ai_governance_observation_failed",
      taskType,
      workspaceId,
    });
    return { skipped: false, error };
  }
}

module.exports = {
  ModelExecutionContext,
  beginModelExecution,
  estimatedTokens,
  observeModelUsageSafely,
};
