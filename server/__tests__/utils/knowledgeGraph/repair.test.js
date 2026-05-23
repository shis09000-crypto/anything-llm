const {
  createRepairBudget,
  canSpend,
  spend,
  estimateTokens,
} = require("../../../utils/knowledgeGraph/repair/budget");
const { nextRetryAt, isPermanentRepairError } = require("../../../utils/knowledgeGraph/repair/backoff");
const { priorityForIssue } = require("../../../utils/knowledgeGraph/repair/prioritize");
const { shouldQuarantineDensity } = require("../../../utils/knowledgeGraph/repair/quarantine");
const { dashScopeGuard } = require("../../../utils/knowledgeGraph/repair/vectorCache");

describe("knowledge graph repair utilities", () => {
  it("enforces token/provider/duration budgets", () => {
    const budget = createRepairBudget({
      tokenBudget: 10,
      providerBudget: 1,
      maxDurationMs: 10_000,
    });
    expect(canSpend(budget, { tokens: 8, providerCalls: 1 })).toBe(true);
    spend(budget, { tokens: 8, providerCalls: 1 });
    expect(canSpend(budget, { tokens: 1, providerCalls: 1 })).toBe(false);
    expect(budget.budgetExhausted).toBe(true);
    expect(budget.exhaustionReason).toBe("provider_budget");
  });

  it("estimates tokens and computes retry backoff", () => {
    expect(estimateTokens("12345678")).toBe(2);
    const retry = nextRetryAt(2);
    expect(retry.getTime()).toBeGreaterThan(Date.now());
    expect(isPermanentRepairError(new Error("missing_source_text"))).toBe(true);
  });

  it("prioritizes root and important concept repair issues", () => {
    const normal = priorityForIssue({ issueType: "missing_vector_cache" });
    const important = priorityForIssue({
      issueType: "missing_graph_job",
      workspaceImportanceScore: 0.8,
      traversalUsageCount: 5,
      rootConceptHit: true,
      hasEvidenceDependency: true,
    });
    expect(important.priorityScore).toBeGreaterThan(normal.priorityScore);
    expect(important.priorityReason).toContain("root concept");
  });

  it("flags suspicious relation density for quarantine", () => {
    expect(
      shouldQuarantineDensity({
        edgeCount: 12,
        lowConfidenceRatio: 0.85,
        relatedToRatio: 0.1,
      })
    ).toBe(true);
    expect(
      shouldQuarantineDensity({
        edgeCount: 4,
        lowConfidenceRatio: 1,
        relatedToRatio: 1,
      })
    ).toBe(false);
  });

  it("guards repair reembedding to DashScope text-embedding-v4", () => {
    const original = {
      EMBEDDING_ENGINE: process.env.EMBEDDING_ENGINE,
      EMBEDDING_BASE_PATH: process.env.EMBEDDING_BASE_PATH,
      EMBEDDING_MODEL_PREF: process.env.EMBEDDING_MODEL_PREF,
      GENERIC_OPEN_AI_EMBEDDING_API_KEY:
        process.env.GENERIC_OPEN_AI_EMBEDDING_API_KEY,
    };

    process.env.EMBEDDING_ENGINE = "generic-openai";
    process.env.EMBEDDING_BASE_PATH =
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.EMBEDDING_MODEL_PREF = "text-embedding-v4";
    process.env.GENERIC_OPEN_AI_EMBEDDING_API_KEY = "test";
    expect(dashScopeGuard()).toBe(null);

    process.env.EMBEDDING_MODEL_PREF = "old-model";
    expect(dashScopeGuard()).toBe("embedding_model_mismatch");

    Object.entries(original).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });
});
