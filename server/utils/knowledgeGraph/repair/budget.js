function envNumber(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createRepairBudget(options = {}) {
  return {
    tokenBudget:
      Number(options.tokenBudget) ||
      envNumber("KNOWLEDGE_GRAPH_REPAIR_TOKEN_BUDGET", 60_000),
    providerBudget:
      Number(options.providerBudget) ||
      envNumber("KNOWLEDGE_GRAPH_REPAIR_PROVIDER_BUDGET", 25),
    maxDurationMs:
      Number(options.maxDurationMs) ||
      envNumber("KNOWLEDGE_GRAPH_REPAIR_MAX_DURATION_MS", 8 * 60 * 1_000),
    startedAt: Date.now(),
    tokenBudgetUsed: 0,
    providerBudgetUsed: 0,
    budgetExhausted: false,
    exhaustionReason: null,
  };
}

function canSpend(budget, { tokens = 0, providerCalls = 0 } = {}) {
  if (!budget || budget.budgetExhausted) return false;
  if (Date.now() - budget.startedAt >= budget.maxDurationMs)
    return exhaust(budget, "duration");
  if (budget.tokenBudgetUsed + tokens > budget.tokenBudget)
    return exhaust(budget, "token_budget");
  if (budget.providerBudgetUsed + providerCalls > budget.providerBudget)
    return exhaust(budget, "provider_budget");
  return true;
}

function spend(budget, { tokens = 0, providerCalls = 0 } = {}) {
  if (!budget) return;
  budget.tokenBudgetUsed += Number(tokens || 0);
  budget.providerBudgetUsed += Number(providerCalls || 0);
}

function exhaust(budget, reason) {
  budget.budgetExhausted = true;
  budget.exhaustionReason = reason;
  return false;
}

function estimateTokens(text = "") {
  return Math.ceil(String(text || "").length / 4);
}

module.exports = {
  createRepairBudget,
  canSpend,
  spend,
  estimateTokens,
};
