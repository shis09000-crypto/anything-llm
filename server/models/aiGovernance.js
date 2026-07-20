const crypto = require("crypto");
const prisma = require("../utils/prisma");
const { currentCorrelation } = require("../utils/observability/context");
const { metrics } = require("../utils/observability/metrics");
const { redactLogObject } = require("../utils/security/redaction");
const { governanceMode } = require("../utils/aiGovernance/config");

function boundedInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(Math.trunc(parsed), 2_147_483_647))
    : fallback;
}

function normalizeUsage(usage = {}) {
  const duration = usage.durationMs ?? usage.duration_ms;
  return {
    inputTokens: boundedInteger(
      usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens
    ),
    outputTokens: boundedInteger(
      usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens
    ),
    toolCalls: boundedInteger(usage.toolCalls ?? usage.tool_calls),
    durationMs:
      duration == null
        ? boundedInteger(Number(usage.duration || 0) * 1_000)
        : boundedInteger(duration),
  };
}

function modelMatches(pattern, model) {
  const escaped = String(pattern || "*")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(String(model || ""));
}

function costMicros(price, usage) {
  if (!price) return null;
  const inputRate = Number(price.inputMicrosPerMillion);
  const outputRate = Number(price.outputMicrosPerMillion);
  if (!Number.isFinite(inputRate) && !Number.isFinite(outputRate)) return null;
  return boundedInteger(
    (usage.inputTokens * (inputRate || 0) +
      usage.outputTokens * (outputRate || 0)) /
      1_000_000
  );
}

function safeMetadata(value) {
  const redacted = redactLogObject(
    value && typeof value === "object" ? value : { value: value ?? null }
  );
  const encoded = JSON.stringify(redacted);
  return encoded.length <= 16_000
    ? redacted
    : { truncated: true, preview: encoded.slice(0, 15_900) };
}

const AIGovernance = {
  governanceMode,

  async priceFor({ provider, model, at = new Date() }) {
    const candidates = await prisma.ai_price_catalog.findMany({
      where: {
        provider: String(provider || "unknown"),
        active: true,
        effectiveAt: { lte: at },
        OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
      },
      orderBy: [{ version: "desc" }, { effectiveAt: "desc" }],
    });
    return (
      candidates.find((entry) => modelMatches(entry.modelPattern, model)) ||
      null
    );
  },

  async policyFor({ ownerType, ownerId, taskType }) {
    return prisma.ai_budget_policies.findFirst({
      where: {
        ownerType: String(ownerType),
        ownerId: String(ownerId),
        enabled: true,
        taskType: { in: [String(taskType), "*"] },
      },
      orderBy: { taskType: "desc" },
    });
  },

  async reserve({
    ownerType = "system",
    ownerId = "global",
    userId = null,
    workspaceId = null,
    taskType,
    provider = "unknown",
    model = "unknown",
    inputTokens = 0,
    outputTokens = 0,
    toolCalls = 0,
    durationMs = 0,
  }) {
    const mode = governanceMode();
    if (mode === "off") return { mode, reservation: null, violations: [] };
    const requested = normalizeUsage({
      inputTokens,
      outputTokens,
      toolCalls,
      durationMs,
    });
    const [policy, price] = await Promise.all([
      this.policyFor({ ownerType, ownerId, taskType }),
      this.priceFor({ provider, model }),
    ]);
    const estimatedCost = costMicros(price, requested);
    const violations = [];
    for (const [kind, requestedValue, maximum] of [
      ["input_tokens", requested.inputTokens, policy?.maxInputTokens],
      ["output_tokens", requested.outputTokens, policy?.maxOutputTokens],
      ["tool_calls", requested.toolCalls, policy?.maxToolCalls],
      ["duration_ms", requested.durationMs, policy?.maxDurationMs],
      ["cost_micros", estimatedCost, policy?.maxCostMicros],
    ]) {
      if (maximum != null && requestedValue != null && requestedValue > maximum)
        violations.push({ kind, requested: requestedValue, maximum });
    }
    if (
      !price &&
      policy?.unknownPriceAction === "deny" &&
      policy?.maxCostMicros != null
    )
      violations.push({ kind: "unknown_price" });
    if (mode === "enforce" && violations.length) {
      metrics.aiExecutions.inc({ task: taskType, provider, outcome: "denied" });
      const error = new Error("ai_budget_policy_denied");
      error.code = "AI_BUDGET_POLICY_DENIED";
      error.details = { violations };
      throw error;
    }
    const reservation = await prisma.ai_budget_reservations.create({
      data: {
        id: crypto.randomUUID(),
        policyId: policy?.id || null,
        ownerType: String(ownerType),
        ownerId: String(ownerId),
        userId: userId == null ? null : Number(userId),
        workspaceId: workspaceId == null ? null : Number(workspaceId),
        taskType: String(taskType),
        provider: String(provider),
        model: String(model),
        reservedInputTokens: requested.inputTokens,
        reservedOutputTokens: requested.outputTokens,
        reservedToolCalls: requested.toolCalls,
        reservedDurationMs: requested.durationMs,
        reservedCostMicros: estimatedCost,
        traceId: currentCorrelation()?.traceId || null,
        expiresAt: new Date(
          Date.now() + Math.max(requested.durationMs, 900_000)
        ),
      },
    });
    metrics.aiExecutions.inc({
      task: taskType,
      provider,
      outcome: violations.length ? "observed_violation" : "reserved",
    });
    return { mode, reservation, price, violations };
  },

  async settle({
    reservation,
    usage = {},
    status = "completed",
    metadata = {},
  }) {
    if (!reservation) return null;
    const normalized = normalizeUsage(usage);
    const price = await this.priceFor({
      provider: reservation.provider,
      model: reservation.model,
    });
    const actualCost = costMicros(price, normalized);
    const now = new Date();
    const event = await prisma.$transaction(async (tx) => {
      const existing = await tx.ai_usage_events.findUnique({
        where: { reservationId: reservation.id },
      });
      if (existing) return existing;
      await tx.ai_budget_reservations.update({
        where: { id: reservation.id },
        data: {
          status: "settled",
          actualInputTokens: normalized.inputTokens,
          actualOutputTokens: normalized.outputTokens,
          actualToolCalls: normalized.toolCalls,
          actualDurationMs: normalized.durationMs,
          actualCostMicros: actualCost,
          settledAt: now,
        },
      });
      return tx.ai_usage_events.create({
        data: {
          id: crypto.randomUUID(),
          reservationId: reservation.id,
          ownerType: reservation.ownerType,
          ownerId: reservation.ownerId,
          userId: reservation.userId,
          workspaceId: reservation.workspaceId,
          taskType: reservation.taskType,
          provider: reservation.provider,
          model: reservation.model,
          inputTokens: normalized.inputTokens,
          outputTokens: normalized.outputTokens,
          toolCalls: normalized.toolCalls,
          durationMs: normalized.durationMs,
          costMicros: actualCost,
          priceCatalogId: price?.id || null,
          status,
          metadataJson: JSON.stringify(safeMetadata(metadata)),
          traceId: reservation.traceId,
          startedAt: reservation.createdAt,
          completedAt: now,
        },
      });
    });
    metrics.aiTokens.inc(
      { provider: reservation.provider, direction: "input" },
      normalized.inputTokens
    );
    metrics.aiTokens.inc(
      { provider: reservation.provider, direction: "output" },
      normalized.outputTokens
    );
    if (actualCost)
      metrics.aiCostMicros.inc({ provider: reservation.provider }, actualCost);
    metrics.aiExecutions.inc({
      task: reservation.taskType,
      provider: reservation.provider,
      outcome: status,
    });
    return event;
  },

  async release({ reservation, error }) {
    if (!reservation) return null;
    return prisma.ai_budget_reservations.updateMany({
      where: { id: reservation.id, status: "reserved" },
      data: {
        status: "released",
        failureCode: String(error?.code || "ai_execution_failed").slice(0, 160),
        settledAt: new Date(),
      },
    });
  },

  async observeCompletedExecution(context = {}, usage = {}, metadata = {}) {
    const reserved = await this.reserve({
      ...context,
      ...normalizeUsage(usage),
    });
    return this.settle({ reservation: reserved.reservation, usage, metadata });
  },
};

module.exports = {
  AIGovernance,
  boundedInteger,
  costMicros,
  governanceMode,
  modelMatches,
  normalizeUsage,
};
