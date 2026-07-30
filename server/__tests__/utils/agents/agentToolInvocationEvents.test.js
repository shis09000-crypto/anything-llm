const {
  continuationProviderConfigForFunction,
  readyToolInvocationEvent,
  shouldForwardProviderStreamEvent,
} = require("../../../utils/agents/aibitat");
const {
  prepareToolResultForModel,
} = require("../../../utils/agents/toolResultStore");

describe("Agent tool invocation events", () => {
  it("drops provisional provider fragments", () => {
    expect(
      shouldForwardProviderStreamEvent("reportStreamEvent", {
        type: "toolCallInvocation",
        content: "Assembling Tool Call: crypto(",
      })
    ).toBe(false);
  });

  it("emits one named ready event for the executable tool call", () => {
    const event = readyToolInvocationEvent(
      { id: "call-market", name: "crypto-market", arguments: {} },
      0,
      "response-market"
    );

    expect(event).toEqual({
      type: "toolCallInvocation",
      uuid: "tool_call:call-market",
      toolName: "crypto-market",
      phase: "ready",
      content: "Calling crypto-market.",
    });
    expect(shouldForwardProviderStreamEvent("reportStreamEvent", event)).toBe(
      true
    );
  });

  it("pins quantitative market interpretation to the refined task tier", () => {
    expect(
      continuationProviderConfigForFunction({
        continuationTask: "crypto_market_analysis",
      })
    ).toEqual({
      taskName: "crypto_market_analysis",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      tier: "refined",
    });
    expect(continuationProviderConfigForFunction({})).toBeNull();
  });

  it("allows a bounded tool-specific model projection without partial JSON", () => {
    const result = JSON.stringify({ payload: "x".repeat(13_000) });
    expect(prepareToolResultForModel(result)).toContain(
      "[Tool result truncated:"
    );
    expect(prepareToolResultForModel(result, null, 20_000)).toBe(result);
  });
});
