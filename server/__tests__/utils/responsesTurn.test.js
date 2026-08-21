const {
  ResponsesTurnProjector,
  normalizedPrompt,
} = require("../../utils/responsesTurn/runtime");

describe("unified Responses turn projection", () => {
  test("direct chat emits answer text without exposing speculative thought status", () => {
    const events = [];
    const projector = new ResponsesTurnProjector({
      responseId: "resp-chat",
      emit: (event) => events.push(event),
    });

    projector.accept({ type: "statusResponse", content: "Thinking..." });
    projector.accept({
      type: "reportStreamEvent",
      content: { type: "textResponseChunk", content: "你好" },
    });
    projector.accept({
      type: "response.completed",
      response: { metadata: { chatId: 9 } },
    });

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_text.delta",
      "response.output_text.done",
      "response.completed",
    ]);
    expect(events.some((event) => event.type.startsWith("athena.tool."))).toBe(
      false
    );
    expect(events.at(-1).response.metadata.chatId).toBe(9);
  });

  test("actual tool use reveals concise progress and completes only once", () => {
    const events = [];
    const projector = new ResponsesTurnProjector({
      responseId: "resp-tool",
      emit: (event) => events.push(event),
    });

    projector.accept({ type: "statusResponse", content: "正在准备检索" });
    projector.accept({
      type: "reportStreamEvent",
      content: {
        type: "toolCallInvocation",
        uuid: "call-1",
        toolName: "workspace_search",
      },
    });
    projector.accept({
      type: "reportStreamEvent",
      content: {
        type: "toolCallResult",
        uuid: "call-1",
        toolName: "workspace_search",
        summary: "已找到资料",
      },
    });
    projector.accept({
      type: "reportStreamEvent",
      content: { type: "textResponseChunk", content: "检索后的回答" },
    });
    projector.accept({ type: "response.completed", response: {} });
    projector.accept({ type: "response.completed", response: {} });

    expect(events.some((event) => event.type === "athena.tool.progress")).toBe(
      true
    );
    expect(events.some((event) => event.type === "athena.tool.started")).toBe(
      true
    );
    expect(events.some((event) => event.type === "athena.tool.completed")).toBe(
      true
    );
    expect(
      events.filter((event) => event.type === "response.completed")
    ).toHaveLength(1);
    expect(events.map((event) => event.sequence_number)).toEqual(
      events.map((_, index) => index + 1)
    );
  });

  test("removes the legacy agent prefix without routing classification", () => {
    expect(normalizedPrompt(" @agent  帮我查天气 ")).toBe("帮我查天气");
    expect(normalizedPrompt("普通聊天")).toBe("普通聊天");
  });

  test("emits the outer terminal immediately without waiting for stream closure", () => {
    const events = [];
    const projector = new ResponsesTurnProjector({
      responseId: "resp-actions",
      emit: (event) => events.push(event),
    });

    projector.accept({
      type: "reportStreamEvent",
      content: { type: "textResponseChunk", content: "完成回答" },
    });
    projector.accept({
      type: "response.completed",
      response: {
        metadata: {
          chatId: 42,
          publicChatId: "chat_42",
          clientTurnId: "turn-actions",
        },
      },
    });

    const completed = events.at(-1);
    expect(completed.type).toBe("response.completed");
    expect(completed.response.metadata.chatId).toBe(42);
    expect(completed.response.metadata.publicChatId).toBe("chat_42");
    expect(completed.response.metadata.clientTurnId).toBe("turn-actions");
  });

  test("reserves the public identity at creation and adds the database id only on completion", () => {
    const events = [];
    const projector = new ResponsesTurnProjector({
      responseId: "resp-identity",
      emit: (event) => events.push(event),
      chatId: null,
      publicChatId: "chat_77",
      clientTurnId: "turn-identity",
    });

    const created = events[0];
    expect(created.type).toBe("response.created");
    expect(created.response.metadata).toEqual({
      chatId: null,
      publicChatId: "chat_77",
      clientTurnId: "turn-identity",
    });

    projector.accept({
      type: "response.completed",
      response: {
        metadata: {
          chatId: 77,
          publicChatId: "chat_77",
          clientTurnId: "turn-identity",
        },
      },
    });
    expect(events.at(-1).response.metadata).toEqual({
      chatId: 77,
      publicChatId: "chat_77",
      clientTurnId: "turn-identity",
    });
  });

  test("projects reasoning and agent progress before the first answer delta", () => {
    const events = [];
    const projector = new ResponsesTurnProjector({
      responseId: "resp-reasoning",
      emit: (event) => events.push(event),
    });

    projector.accept({
      type: "reportStreamEvent",
      content: { type: "reasoningContentStart" },
    });
    projector.accept({
      type: "reportStreamEvent",
      content: {
        type: "reasoningContentChunk",
        sequence: 1,
        content: "先理解问题。",
      },
    });
    projector.accept({
      type: "reportStreamEvent",
      content: {
        type: "agentProgress",
        uuid: "progress-1",
        phase: "synthesis",
        status: "running",
        sequence: 1,
        details: {},
      },
    });
    projector.accept({
      type: "reportStreamEvent",
      content: { type: "textResponseChunk", content: "答案" },
    });
    projector.accept({ type: "response.completed", response: {} });

    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "athena.reasoning.started",
      "athena.reasoning.delta",
      "athena.agent.progress",
      "athena.reasoning.done",
      "response.output_text.delta",
      "response.output_text.done",
      "response.completed",
    ]);
    expect(types.indexOf("athena.reasoning.done")).toBeLessThan(
      types.indexOf("response.output_text.delta")
    );
  });

  test("keeps failed reasoning visible and emits one terminal", () => {
    const events = [];
    const projector = new ResponsesTurnProjector({
      responseId: "resp-reasoning-failed",
      emit: (event) => events.push(event),
    });
    projector.accept({
      type: "reportStreamEvent",
      content: { type: "reasoningContentChunk", content: "检查失败原因" },
    });
    projector.accept({ type: "wssFailure", content: "provider failed" });

    expect(events.map((event) => event.type).slice(-2)).toEqual([
      "athena.reasoning.done",
      "response.failed",
    ]);
    expect(
      events.filter((event) => event.type === "response.failed")
    ).toHaveLength(1);
  });
});
