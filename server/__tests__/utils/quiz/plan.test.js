const mockCompleteJsonWithRetry = jest.fn();

jest.mock("../../../utils/quiz/llm", () => ({
  completeJsonWithRetry: mockCompleteJsonWithRetry,
}));

const {
  draftQuizPlan,
  extractQuizPlan,
  normalizePlan,
} = require("../../../utils/quiz/plan");

describe("quiz plan extraction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("defaults to 20 high-difficulty questions split 10/6/4", () => {
    const plan = normalizePlan({}, "测试知识库");
    expect(plan.totalQuestions).toBe(20);
    expect(plan.difficulty).toBe("high");
    expect(plan.questionTypeCounts).toEqual({
      single_choice: 10,
      multiple_choice: 6,
      fill_blank: 4,
    });
  });

  it("prioritizes user-provided plan fields", () => {
    const plan = normalizePlan(
      {
        topic: "Graph RAG",
        totalQuestions: 12,
        difficulty: "medium",
        questionTypeCounts: {
          single_choice: 6,
          multiple_choice: 4,
          fill_blank: 2,
        },
      },
      "ignored"
    );
    expect(plan.topic).toBe("Graph RAG");
    expect(plan.totalQuestions).toBe(12);
    expect(plan.difficulty).toBe("medium");
    expect(plan.questionTypeCounts).toEqual({
      single_choice: 6,
      multiple_choice: 4,
      fill_blank: 2,
    });
  });

  it("normalizes difficulty to easy, medium, high, or extreme", () => {
    expect(normalizePlan({ difficulty: "extreme" }, "测试").difficulty).toBe(
      "extreme"
    );
    expect(normalizePlan({ difficulty: "hard" }, "测试").difficulty).toBe(
      "high"
    );
  });

  it("uses deepseek-v4-flash with JSON response format for extraction", async () => {
    mockCompleteJsonWithRetry.mockResolvedValue({
      json: { topic: "Topic" },
      metrics: {},
      model: "deepseek-v4-flash",
    });

    await extractQuizPlan({ userRequest: "生成测试", workspaceSlug: "ws" });

    expect(mockCompleteJsonWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-v4-flash",
        temperature: 0.1,
        maxAttempts: 1,
        timeoutMs: 20_000,
      })
    );
  });

  it("persists an immediate deterministic plan for Chinese quiz prompts", () => {
    const plan = draftQuizPlan("哈咯，给我出十道题，关于地理的");
    expect(plan.topic).toBe("地理");
    expect(plan.totalQuestions).toBe(10);
    expect(plan.questionTypeCounts).toEqual({
      single_choice: 5,
      multiple_choice: 3,
      fill_blank: 2,
    });
  });

  it("falls back to the deterministic Responses plan when planning times out", async () => {
    mockCompleteJsonWithRetry.mockRejectedValue(new Error("responses_timeout"));

    const result = await extractQuizPlan({
      userRequest: "出十道历史题给我",
      workspaceSlug: "ws",
    });

    expect(result.plan.topic).toBe("历史");
    expect(result.plan.totalQuestions).toBe(10);
    expect(result.metrics.effective_protocol).toBe("responses");
  });
});
