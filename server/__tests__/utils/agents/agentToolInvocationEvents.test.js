const {
  readyToolInvocationEvent,
  shouldForwardProviderStreamEvent,
} = require("../../../utils/agents/aibitat");

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
});
