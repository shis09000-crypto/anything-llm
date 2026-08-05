const {
  executionMetadata,
  unknownExecutionMetadata,
} = require("../../../utils/chats/executionMetadata");
const {
  convertToChatHistory,
} = require("../../../utils/helpers/chat/responses");

describe("chat execution metadata", () => {
  test("prefers the model locked for the completed response", () => {
    expect(
      executionMetadata({
        model: "deepseek-v4-flash",
        provider: "deepseek",
        metrics: { model: "deepseek-v4-pro" },
        responseId: "ath_resp_1",
        requestedProtocol: "responses",
        effectiveProtocol: "responses",
      })
    ).toEqual({
      model: "deepseek-v4-flash",
      provider: "deepseek",
      requestedProtocol: "responses",
      effectiveProtocol: "responses",
      responseId: "ath_resp_1",
      source: "responses_runtime",
    });
  });

  test("projects execution independently from performance metrics", () => {
    const history = convertToChatHistory([
      {
        id: 7,
        prompt: "你好",
        response: JSON.stringify({
          text: "你好",
          metrics: { completion_tokens: 2 },
          execution: {
            model: "deepseek-v4-flash",
            provider: "deepseek",
            requestedProtocol: "responses",
            effectiveProtocol: "responses",
            responseId: "ath_resp_7",
            source: "responses_runtime",
          },
        }),
        createdAt: new Date("2026-08-05T00:00:00.000Z"),
      },
    ]);

    expect(history[1].metrics).toEqual({ completion_tokens: 2 });
    expect(history[1].execution.model).toBe("deepseek-v4-flash");
    expect(history[1].execution.responseId).toBe("ath_resp_7");
  });

  test("marks records without trustworthy model evidence as unknown", () => {
    expect(unknownExecutionMetadata()).toEqual(
      expect.objectContaining({ model: null, source: "unknown" })
    );
  });

  test("projects a legacy metrics model when no execution envelope exists", () => {
    const history = convertToChatHistory([
      {
        id: 8,
        prompt: "旧消息",
        response: JSON.stringify({
          text: "旧回复",
          metrics: { model: "deepseek-v4-pro" },
        }),
        createdAt: new Date("2026-08-05T00:00:00.000Z"),
      },
    ]);

    expect(history[1].execution).toEqual(
      expect.objectContaining({
        model: "deepseek-v4-pro",
        source: "legacy_metrics",
      })
    );
  });

  test("labels a locked legacy provider model as Chat Completions", () => {
    expect(
      executionMetadata({
        model: "deepseek-v4-pro",
        provider: "deepseek",
      })
    ).toEqual(
      expect.objectContaining({
        requestedProtocol: "chat_completions",
        effectiveProtocol: "chat_completions",
        source: "provider",
      })
    );
  });
});
