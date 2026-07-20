const {
  compactAgentEvents,
  sanitizeAgentEvent,
} = require("../../../utils/agents/toolResultStore");

describe("agent event persistence compaction", () => {
  it("keeps only the latest streamed tool call and assistant snapshot", () => {
    const events = [
      {
        id: "1",
        uuid: "assistant-a",
        type: "assistant_delta",
        content: "first",
      },
      {
        id: "2",
        uuid: "tool-a",
        type: "tool_call",
        content: "assembling {",
      },
      {
        id: "3",
        uuid: "tool-a",
        type: "tool_call",
        content: "assembling { complete: true }",
      },
      {
        id: "4",
        uuid: "assistant-a",
        type: "final_message",
        content: "final",
      },
      { id: "5", type: "approval_request", requestId: "approval-a" },
    ];
    const compacted = compactAgentEvents(events);
    expect(compacted).toHaveLength(3);
    expect(compacted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "1",
          type: "final_message",
          content: "final",
        }),
        expect.objectContaining({
          id: "2",
          type: "tool_call",
          content: "assembling { complete: true }",
        }),
        expect.objectContaining({ id: "5", type: "approval_request" }),
      ])
    );
  });

  it("bounds diagnostic string fields", () => {
    const event = sanitizeAgentEvent({
      id: "bounded",
      type: "agent_thought",
      content: "x".repeat(5_000),
      query: "y".repeat(5_000),
      root: "z".repeat(5_000),
    });
    expect(event.content).toHaveLength(500);
    expect(event.query).toHaveLength(500);
    expect(event.root).toHaveLength(500);
  });
});
