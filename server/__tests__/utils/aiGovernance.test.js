const {
  boundedInteger,
  costMicros,
  governanceMode,
  modelMatches,
  normalizeUsage,
} = require("../../models/aiGovernance");

describe("AI governance primitives", () => {
  it("keeps rollout off unless observe or enforce is explicit", () => {
    expect(governanceMode({})).toBe("off");
    expect(governanceMode({ ATHENA_AI_GOVERNANCE: "observe" })).toBe("observe");
    expect(governanceMode({ ATHENA_AI_GOVERNANCE: "enforce" })).toBe("enforce");
    expect(governanceMode({ ATHENA_AI_GOVERNANCE: "invalid" })).toBe("off");
  });

  it("normalizes provider-specific usage fields and bounds integers", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 120,
        completion_tokens: 30,
        duration: 1.25,
        tool_calls: 2,
      })
    ).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      durationMs: 1250,
      toolCalls: 2,
    });
    expect(boundedInteger(-4)).toBe(0);
    expect(boundedInteger(Number.POSITIVE_INFINITY, 7)).toBe(7);
  });

  it("matches catalog wildcards and computes micro-currency cost", () => {
    expect(modelMatches("deepseek-*", "deepseek-chat")).toBe(true);
    expect(modelMatches("gpt-4o", "gpt-4o-mini")).toBe(false);
    expect(
      costMicros(
        { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 },
        { inputTokens: 1_000, outputTokens: 500 }
      )
    ).toBe(2_000);
    expect(costMicros(null, { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});
