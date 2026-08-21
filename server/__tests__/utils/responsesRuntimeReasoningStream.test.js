const {
  ReasoningStreamProjector,
  completedReasoningFromEvent,
  isReasoningProviderEvent,
  reasoningDeltaFromEvent,
  sanitizeReasoningText,
} = require("../../utils/responsesRuntime/reasoningStream");

describe("Responses reasoning stream projection", () => {
  test("normalizes native and provider-compatible reasoning deltas", () => {
    expect(
      reasoningDeltaFromEvent({
        type: "response.reasoning_text.delta",
        delta: "native",
      })
    ).toBe("native");
    expect(
      reasoningDeltaFromEvent({ delta: { reasoning_content: "deepseek" } })
    ).toBe("deepseek");
    expect(
      completedReasoningFromEvent({
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "summary" }],
        },
      })
    ).toBe("summary");
  });

  test("redacts credentials and internal prompt blocks", () => {
    const safe = sanitizeReasoningText(
      "authorization: Bearer secret-token\n<system>private prompt</system>"
    );
    expect(safe).not.toContain("secret-token");
    expect(safe).not.toContain("private prompt");
    expect(safe).toContain("[redacted]");
  });

  test("coalesces readable chunks and completes exactly once", () => {
    const events = [];
    const projector = new ReasoningStreamProjector({
      emit: (event) => events.push(event),
      flushDelayMs: 60_000,
    });
    projector.push("先检查上下文，");
    projector.push("再决定是否调用工具。下一步");
    projector.finish();
    projector.finish();

    expect(events.map((event) => event.type)).toEqual([
      "reasoningContentStart",
      "reasoningContentChunk",
      "reasoningContentChunk",
      "reasoningContentDone",
    ]);
    expect(events[1].content).toBe("先检查上下文，再决定是否调用工具。");
    expect(events[2].content).toBe("下一步");
  });

  test("keeps raw reasoning only in memory while emitting sanitized text", () => {
    const events = [];
    const projector = new ReasoningStreamProjector({
      emit: (event) => events.push(event),
      flushDelayMs: 60_000,
    });
    projector.push("token=raw-secret。继续");
    projector.finish();

    expect(projector.rawText()).toContain("raw-secret");
    expect(JSON.stringify(events)).not.toContain("raw-secret");
  });

  test("identifies raw reasoning events so the runtime can keep them ephemeral", () => {
    const raw = {
      type: "response.reasoning_text.delta",
      sequence_number: 7,
      response_id: "resp-1",
      delta: "token=raw-secret。",
    };

    expect(isReasoningProviderEvent(raw)).toBe(true);
    expect(
      isReasoningProviderEvent({
        type: "response.output_text.delta",
        delta: "answer",
      })
    ).toBe(false);
  });
});
