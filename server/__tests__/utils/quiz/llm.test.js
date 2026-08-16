const mockCreate = jest.fn();
const mockGetTaskConnector = jest.fn();
const mockStreamGetChatCompletion = jest.fn();
const mockCreateResponsesRuntimeConnector = jest.fn((connector) => connector);
const mockCompressMessages = jest.fn(async ({ systemPrompt, userPrompt }) => [
  { role: "system", content: systemPrompt },
  { role: "user", content: userPrompt },
]);

jest.mock("../../../utils/llmTasks", () => ({
  resolveTaskProviderModel: jest.fn((taskName) => {
    const models = {
      quiz_plan: "deepseek-v4-flash",
      quiz_generation: "deepseek-v4-pro",
      quiz_generation_fallback: "deepseek-v4-flash",
      quiz_analysis: "deepseek-v4-pro",
    };
    return { provider: "deepseek", model: models[taskName] };
  }),
  getTaskConnector: (...args) => mockGetTaskConnector(...args),
}));

jest.mock("../../../utils/responsesRuntime/chatAdapter", () => ({
  createResponsesRuntimeConnector: (...args) =>
    mockCreateResponsesRuntimeConnector(...args),
}));

const {
  completeJson,
  completeJsonWithRetry,
  completeJsonStreamWithRetry,
  completeText,
} = require("../../../utils/quiz/llm");

async function* streamFromTokens(tokens = []) {
  for (const token of tokens) {
    if (token?.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, token.delayMs));
      continue;
    }
    yield {
      choices: [
        {
          delta: { content: token },
          finish_reason: null,
        },
      ],
    };
  }
  yield {
    choices: [
      {
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

async function* hangingStream() {
  await new Promise(() => {});
}

describe("quiz llm helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTaskConnector.mockImplementation(
      (taskName, _context, overrides) => ({
        provider: "deepseek",
        model: overrides?.model,
        connector: {
          model: overrides?.model,
          compressMessages: mockCompressMessages,
          getChatCompletion: mockCreate,
          streamGetChatCompletion: mockStreamGetChatCompletion,
        },
      })
    );
    mockCreate.mockResolvedValue({ textResponse: '{"ok":true}', metrics: {} });
    mockStreamGetChatCompletion.mockResolvedValue(
      streamFromTokens(['{"ok":true}'])
    );
  });

  it("passes DeepSeek JSON response_format to structured calls", async () => {
    const result = await completeJson({
      model: "deepseek-v4-pro",
      systemPrompt: "system",
      userPrompt: "user",
    });

    expect(result.json).toEqual({ ok: true });
    expect(mockCreate).toHaveBeenCalledWith(expect.any(Array), {
      temperature: 0.1,
      responseFormat: { type: "json_object" },
      store: false,
      runtimeContext: {
        chatRunId: expect.stringMatching(/^quiz:/),
        taskName: "quiz_generation",
        taskIntent: "quiz_generation",
        taskPriority: "P0",
      },
    });
    expect(mockCreateResponsesRuntimeConnector).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        callerRole: "api",
      })
    );
  });

  it("routes quiz analysis text through a scoped non-stored response", async () => {
    mockCreate.mockResolvedValue({ textResponse: "analysis", metrics: {} });

    const result = await completeText({
      model: "deepseek-v4-pro",
      systemPrompt: "system",
      userPrompt: "user",
    });

    expect(result.text).toBe("analysis");
    expect(mockCreate).toHaveBeenCalledWith(expect.any(Array), {
      temperature: 0.2,
      store: false,
      runtimeContext: {
        chatRunId: expect.stringMatching(/^quiz:/),
        taskName: "quiz_generation",
        taskIntent: "quiz_generation",
        taskPriority: "P0",
      },
    });
  });

  it("retries transient JSON failures", async () => {
    mockCreate
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ textResponse: '{"ok":true}', metrics: {} });

    const result = await completeJsonWithRetry({
      model: "deepseek-v4-pro",
      systemPrompt: "system",
      userPrompt: "user",
      retryDelaysMs: [0],
      timeoutMs: 1000,
      label: "test_retry",
    });

    expect(result.json).toEqual({ ok: true });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("times out JSON calls and surfaces the timeout error", async () => {
    mockCreate.mockImplementation(() => new Promise(() => {}));

    await expect(
      completeJsonWithRetry({
        model: "deepseek-v4-pro",
        systemPrompt: "system",
        userPrompt: "user",
        maxAttempts: 1,
        timeoutMs: 1,
        label: "test_timeout",
      })
    ).rejects.toThrow("quiz_llm_timeout_after_1ms");
  });

  it("passes DeepSeek JSON response_format to streaming structured calls", async () => {
    const result = await completeJsonStreamWithRetry({
      model: "deepseek-v4-pro",
      systemPrompt: "system",
      userPrompt: "user",
      retryDelaysMs: [0],
      timeoutMs: 1000,
      label: "test_stream_response_format",
    });

    expect(result.json).toEqual({ ok: true });
    expect(mockStreamGetChatCompletion).toHaveBeenCalledWith(
      expect.any(Array),
      {
        temperature: 0.1,
        responseFormat: { type: "json_object" },
        store: false,
        runtimeContext: {
          chatRunId: expect.stringMatching(/^quiz:/),
          taskName: "quiz_generation",
          taskIntent: "quiz_generation",
          taskPriority: "P0",
        },
      }
    );
  });

  it("times out streaming JSON calls before any token is emitted", async () => {
    mockStreamGetChatCompletion.mockResolvedValue(hangingStream());

    await expect(
      completeJsonStreamWithRetry({
        model: "deepseek-v4-pro",
        systemPrompt: "system",
        userPrompt: "user",
        maxAttempts: 1,
        timeoutMs: 1,
        label: "test_stream_timeout",
        fallbackModel: null,
      })
    ).rejects.toThrow("quiz_llm_timeout_after_1ms");

    expect(mockStreamGetChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not timeout a streaming JSON call after the first token arrives", async () => {
    mockStreamGetChatCompletion.mockResolvedValue(
      streamFromTokens(['{"ok":', { delayMs: 5 }, "true}"])
    );

    const result = await completeJsonStreamWithRetry({
      model: "deepseek-v4-pro",
      systemPrompt: "system",
      userPrompt: "user",
      maxAttempts: 1,
      timeoutMs: 1,
      label: "test_stream_after_first_token",
      fallbackModel: null,
    });

    expect(result.json).toEqual({ ok: true });
  });

  it("times out a streaming JSON call after total stream timeout", async () => {
    mockStreamGetChatCompletion.mockResolvedValue(
      streamFromTokens(['{"ok":', { delayMs: 5 }, "true}"])
    );

    await expect(
      completeJsonStreamWithRetry({
        model: "deepseek-v4-pro",
        systemPrompt: "system",
        userPrompt: "user",
        maxAttempts: 1,
        timeoutMs: 1000,
        totalTimeoutMs: 1,
        label: "test_total_stream_timeout",
        fallbackModel: null,
      })
    ).rejects.toMatchObject({
      code: "quiz_llm_timeout",
      phase: "total_stream",
    });
  });

  it("falls back to deepseek-v4-flash once after two streaming timeouts", async () => {
    mockStreamGetChatCompletion
      .mockResolvedValueOnce(hangingStream())
      .mockResolvedValueOnce(hangingStream())
      .mockResolvedValueOnce(streamFromTokens(['{"ok":true}']));

    const result = await completeJsonStreamWithRetry({
      model: "deepseek-v4-pro",
      systemPrompt: "system",
      userPrompt: "user",
      timeoutMs: 1,
      retryDelaysMs: [0],
      label: "test_stream_fallback",
    });

    expect(result.json).toEqual({ ok: true });
    expect(mockGetTaskConnector).toHaveBeenNthCalledWith(
      1,
      "quiz_generation",
      {},
      { model: "deepseek-v4-pro" }
    );
    expect(mockGetTaskConnector).toHaveBeenNthCalledWith(
      2,
      "quiz_generation",
      {},
      { model: "deepseek-v4-pro" }
    );
    expect(mockGetTaskConnector).toHaveBeenNthCalledWith(
      3,
      "quiz_generation_fallback",
      {},
      { model: "deepseek-v4-flash" }
    );
  });

  it("does not use flash fallback for non-timeout streaming errors", async () => {
    mockStreamGetChatCompletion.mockRejectedValue(new Error("api 429"));

    await expect(
      completeJsonStreamWithRetry({
        model: "deepseek-v4-pro",
        systemPrompt: "system",
        userPrompt: "user",
        maxAttempts: 2,
        retryDelaysMs: [0],
        timeoutMs: 1000,
        label: "test_stream_non_timeout",
      })
    ).rejects.toThrow("api 429");

    expect(mockGetTaskConnector).toHaveBeenCalledTimes(2);
    expect(mockGetTaskConnector).not.toHaveBeenCalledWith(
      "quiz_generation_fallback",
      {},
      { model: "deepseek-v4-flash" }
    );
  });
});
