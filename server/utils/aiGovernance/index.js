const { DataAccessCenter } = require("../dataAccess");
const { governanceMode } = require("./config");
const api = require("@opentelemetry/api");
const {
  startOperationSpan,
  correlationCoverage,
  currentOperationContext,
} = require("../observability/operationContext");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { metrics } = require("../observability/metrics");

function estimatedTokens(messages = []) {
  const text = (Array.isArray(messages) ? messages : [messages])
    .map((message) =>
      typeof message === "string" ? message : JSON.stringify(message || {})
    )
    .join("\n");
  return Math.max(0, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

class ModelExecutionContext {
  constructor(context, reservation, observation) {
    this.context = context;
    this.reservation = reservation;
    this.observation = observation;
    this.closed = false;
  }

  static async begin(context = {}, budget = {}) {
    const mode = governanceMode();
    const provider = String(context.provider || "unknown").slice(0, 64);
    const task = String(context.taskType || "unknown").slice(0, 64);
    const observation = {
      startedAt: Date.now(),
      provider,
      task,
      span: startOperationSpan("gen_ai.model.invoke", {
        kind: api.SpanKind.CLIENT,
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": provider,
          "gen_ai.request.model": String(context.model || "unknown").slice(
            0,
            128
          ),
          "athena.ai.task": task,
        },
      }),
    };
    try {
      if (mode === "off")
        return new ModelExecutionContext(
          context,
          { mode, reservation: null },
          observation
        );
      const reservation = await DataAccessCenter.aiGovernance.reserve({
        ownerType: context.ownerType || "system",
        ownerId: context.ownerId || "global",
        userId: context.userId || null,
        workspaceId: context.workspaceId || null,
        taskType: context.taskType,
        provider,
        model: context.model || "unknown",
        inputTokens: budget.inputTokens || 0,
        outputTokens: budget.outputTokens || 0,
        toolCalls: budget.toolCalls || 0,
        durationMs: budget.durationMs || 0,
      });
      return new ModelExecutionContext(context, reservation, observation);
    } catch (error) {
      observation.span.fail(error);
      observation.span.end();
      throw error;
    }
  }

  finishObservation(outcome, usage = {}, error = null) {
    const observation = this.observation;
    if (!observation) return;
    const labels = {
      task: observation.task,
      provider: observation.provider,
      outcome,
    };
    metrics.modelOperations.inc(labels);
    metrics.modelDuration.observe(
      labels,
      (Date.now() - observation.startedAt) / 1000
    );
    const coverage = correlationCoverage(["requestId", "clientTurnId"]);
    metrics.operationCorrelation.inc({
      component: "llm",
      journey: "chat",
      coverage: coverage.complete ? "complete" : "incomplete",
    });
    if (usage?.prompt_tokens != null)
      observation.span.span.setAttribute(
        "gen_ai.usage.input_tokens",
        Number(usage.prompt_tokens) || 0
      );
    if (usage?.completion_tokens != null)
      observation.span.span.setAttribute(
        "gen_ai.usage.output_tokens",
        Number(usage.completion_tokens) || 0
      );
    if (error) observation.span.fail(error);
    observation.span.end({ "athena.operation.outcome": outcome });
  }

  async settle(usage = {}, metadata = {}) {
    if (this.closed) return null;
    this.closed = true;
    try {
      const result = !this.reservation?.reservation
        ? null
        : await DataAccessCenter.aiGovernance.settle({
            reservation: this.reservation.reservation,
            usage,
            metadata,
          });
      this.finishObservation("success", usage);
      this.observation = null;
      return result;
    } catch (error) {
      this.finishObservation("failure", usage, error);
      this.observation = null;
      throw error;
    }
  }

  async fail(error) {
    if (this.closed) return null;
    this.closed = true;
    emitSemanticEvent({
      eventType: "model.execution.failed",
      category: "model",
      severity: "error",
      outcome: "failure",
      subject: {
        type: "model",
        component: this.observation?.provider,
        operation: this.observation?.task,
      },
      impact: { userEffect: "ai_response_unavailable" },
      evidence: [
        {
          type: "trace",
          ref: currentOperationContext()?.traceId || "unavailable",
        },
      ],
      metadata: {
        errorCode: error?.code || "model_execution_failed",
        provider: this.observation?.provider,
      },
    });
    try {
      if (!this.reservation?.reservation) return null;
      return await DataAccessCenter.aiGovernance.release({
        reservation: this.reservation.reservation,
        error,
      });
    } finally {
      this.finishObservation("failure", {}, error);
      this.observation = null;
    }
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
