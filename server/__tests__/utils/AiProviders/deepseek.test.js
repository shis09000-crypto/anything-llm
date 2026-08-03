const mockCreate = jest.fn();
const mockModelsList = jest.fn();

jest.mock("openai", () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    models: {
      list: mockModelsList,
    },
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  })),
}));

jest.mock("../../../utils/EmbeddingEngines/native", () => ({
  NativeEmbedder: jest.fn(),
}));

jest.mock("../../../utils/helpers/chat/LLMPerformanceMonitor", () => ({
  LLMPerformanceMonitor: {
    measureAsyncFunction: jest.fn(async (promise) => ({
      output: await promise,
      duration: 0.5,
    })),
    measureStream: jest.fn(),
  },
}));

const {
  DeepSeekLLM,
  deepSeekCacheDiagnosis,
  deepSeekPromptFingerprint,
  deepSeekPromptShape,
  deepSeekPromptCacheDiagnostics,
  withDeepSeekCacheDiagnosis,
} = require("../../../utils/AiProviders/deepseek");
const { getLLMProvider } = require("../../../utils/helpers");

describe("DeepSeekLLM", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = "test-key";
    mockModelsList.mockResolvedValue({
      data: [{ id: "deepseek-v4-flash" }],
    });
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("builds a credentialless prompt contract for remote model execution", () => {
    delete process.env.DEEPSEEK_API_KEY;
    const llm = new DeepSeekLLM(null, "deepseek-v4-flash", {
      credentialMode: "remote",
    });

    expect(llm.openai).toBeNull();
    expect(llm.credentialMode).toBe("remote");
    expect(llm.promptWindowLimit()).toBe(1_000_000);
    expect(
      llm.constructPrompt({
        systemPrompt: "system",
        userPrompt: "hello",
      })
    ).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ]);
  });

  it("still requires a credential for direct provider execution", () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => new DeepSeekLLM(null, "deepseek-v4-flash")).toThrow(
      "No DeepSeek API key was set."
    );
  });

  it("selects the Responses Runtime before constructing a local credentialed client", () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.ATHENA_RUNTIME_ROLE = "chat-runtime";
    process.env.ATHENA_RESPONSES_RUNTIME_CUTOVER = "true";
    process.env.ATHENA_RESPONSES_RUNTIME_URL =
      "https://responses-runtime.internal:3034";
    process.env.ATHENA_MODEL_GATEWAY_CUTOVER = "true";
    process.env.ATHENA_MODEL_GATEWAY_URL =
      "https://model-gateway.internal:3018";
    process.env.EMBEDDING_ENGINE = "native";

    const llm = getLLMProvider({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });

    expect(llm.responsesRuntime).toBe(true);
    expect(llm.credentialMode).toBe("remote");
    expect(llm.openai).toBeNull();
  });

  it("forwards JSON response_format to DeepSeek chat completions", async () => {
    const llm = new DeepSeekLLM(null, "deepseek-v4-flash");
    await llm.getChatCompletion([{ role: "user", content: "classify" }], {
      temperature: 0.1,
      responseFormat: { type: "json_object" },
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "classify" }],
      temperature: 0.1,
      max_tokens: 65_536,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
    });
  });

  it("enables DeepSeek thinking without exposing temperature when requested", async () => {
    const llm = new DeepSeekLLM(null, "deepseek-v4-flash");
    await llm.getChatCompletion([{ role: "user", content: "remembered" }], {
      temperature: 0.2,
      thinking: "enabled",
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "remembered" }],
      max_tokens: 65_536,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("does not prepend non-streaming reasoning_content to the saved response", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            reasoning_content: "hidden chain of thought",
            content: "final answer",
          },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });

    const llm = new DeepSeekLLM(null, "deepseek-v4-flash");
    const result = await llm.getChatCompletion([
      { role: "user", content: "hello" },
    ]);

    expect(result.textResponse).toBe("final answer");
    expect(result.textResponse).not.toContain("hidden chain of thought");
    expect(result.textResponse).not.toContain("<think>");
  });

  it("uses the official DeepSeek V4 context window", () => {
    expect(DeepSeekLLM.promptWindowLimit("deepseek-v4-flash")).toBe(1_000_000);
    expect(DeepSeekLLM.promptWindowLimit("deepseek-v4-pro")).toBe(1_000_000);
  });

  it("does not reject official chat models when model discovery is unavailable", async () => {
    mockModelsList.mockRejectedValueOnce(
      new Error("temporary discovery error")
    );
    const llm = new DeepSeekLLM(null, "deepseek-v4-flash");

    await expect(
      llm.getChatCompletion([{ role: "user", content: "classify" }])
    ).resolves.toEqual(
      expect.objectContaining({ textResponse: '{"ok":true}' })
    );
    expect(mockModelsList).not.toHaveBeenCalled();
  });

  it("opts into cache-stable history and emits redacted cache diagnostics", () => {
    const llm = new DeepSeekLLM(null, "deepseek-v4-pro");
    const messages = [
      { role: "system", content: "stable system" },
      { role: "user", content: "secret history" },
      { role: "user", content: "current question" },
    ];

    const diagnostics = llm.promptCacheDiagnostics(messages, {
      historyWindow: {
        strategy: "cache-stable-blocks",
        blockSize: 20,
        maxBlocks: 2,
        totalCount: 58,
        offset: 20,
        limit: 38,
        windowStartOrdinal: 21,
        windowEndOrdinal: 58,
        currentBlockIndex: 2,
      },
    });

    expect(llm.cacheStableHistory).toBe(true);
    expect(diagnostics).toEqual(
      expect.objectContaining({
        provider: "DeepSeekLLM",
        model: "deepseek-v4-pro",
        stablePrefixFingerprint: expect.any(String),
        historyWindow: expect.objectContaining({
          strategy: "cache-stable-blocks",
          offset: 20,
          limit: 38,
        }),
      })
    );
    expect(JSON.stringify(diagnostics)).not.toContain("secret history");
    expect(JSON.stringify(diagnostics)).not.toContain("current question");
  });

  it("keeps invalid compaction timestamps out of cache diagnostics", () => {
    expect(() =>
      deepSeekPromptCacheDiagnostics({
        provider: "DeepSeekLLM",
        model: "deepseek-v4-pro",
        providerPath: "agent",
        messages: [{ role: "user", content: "do not leak" }],
        compaction: {
          id: 7,
          created_at: "not-a-date",
          updated_at: Number.NaN,
        },
      })
    ).not.toThrow();

    const diagnostics = deepSeekPromptCacheDiagnostics({
      provider: "DeepSeekLLM",
      model: "deepseek-v4-pro",
      providerPath: "agent",
      messages: [{ role: "user", content: "do not leak" }],
      compaction: {
        id: 7,
        created_at: "not-a-date",
        updated_at: Number.NaN,
      },
    });

    expect(diagnostics.compactionFingerprint).toEqual(expect.any(String));
    expect(JSON.stringify(diagnostics)).not.toContain("do not leak");
  });

  it("keeps dynamic context out of the stable system and history prefix", () => {
    const llm = new DeepSeekLLM(null, "deepseek-v4-pro");
    const chatHistory = [
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ];
    const firstPrompt = llm.constructPrompt({
      systemPrompt: "stable system",
      chatHistory,
      contextTexts: ["alpha context"],
      userPrompt: "current question",
    });
    const secondPrompt = llm.constructPrompt({
      systemPrompt: "stable system",
      chatHistory,
      contextTexts: ["beta context"],
      userPrompt: "current question",
    });

    expect(firstPrompt.slice(0, -1)).toEqual(secondPrompt.slice(0, -1));
    expect(deepSeekPromptFingerprint(firstPrompt.slice(0, -1))).toBe(
      deepSeekPromptFingerprint(secondPrompt.slice(0, -1))
    );
    expect(firstPrompt[0]).toEqual({
      role: "system",
      content: "stable system",
    });
    expect(firstPrompt.at(-1).content).toContain("alpha context");
    expect(secondPrompt.at(-1).content).toContain("beta context");
  });

  it("creates redacted prompt shape fingerprints for diagnostics", () => {
    const promptShape = deepSeekPromptShape([
      { role: "system", content: "stable system" },
      { role: "user", content: "secret user text" },
    ]);

    expect(promptShape).toEqual([
      {
        index: 0,
        role: "system",
        contentLength: 13,
        contentSha256: expect.any(String),
      },
      {
        index: 1,
        role: "user",
        contentLength: 16,
        contentSha256: expect.any(String),
      },
    ]);
    expect(JSON.stringify(promptShape)).not.toContain("secret user text");
    expect(
      deepSeekPromptFingerprint([{ role: "user", content: "secret user text" }])
    ).toEqual(expect.any(String));
  });

  it("leaves prompt shape unchanged when context is empty", () => {
    const llm = new DeepSeekLLM(null, "deepseek-v4-pro");
    const chatHistory = [{ role: "assistant", content: "hello" }];

    expect(
      llm.constructPrompt({
        systemPrompt: "system",
        chatHistory,
        contextTexts: [],
        userPrompt: "question",
      })
    ).toEqual([
      { role: "system", content: "system" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "question" },
    ]);
  });

  it("preserves DeepSeek cache usage metrics in non-streaming responses", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: 7,
        prompt_cache_miss_tokens: 3,
      },
    });

    const llm = new DeepSeekLLM(null, "deepseek-v4-flash");
    const result = await llm.getChatCompletion([
      { role: "user", content: "classify" },
    ]);

    expect(result.metrics).toEqual(
      expect.objectContaining({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: 7,
        prompt_cache_miss_tokens: 3,
        prompt_cache_hit_rate: 0.7,
      })
    );
  });

  it("requests stream usage metrics from DeepSeek", async () => {
    const {
      LLMPerformanceMonitor,
    } = require("../../../utils/helpers/chat/LLMPerformanceMonitor");
    LLMPerformanceMonitor.measureStream.mockResolvedValueOnce("stream");

    const llm = new DeepSeekLLM(null, "deepseek-v4-flash");
    await llm.streamGetChatCompletion([{ role: "user", content: "hello" }]);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-v4-flash",
        stream: true,
        max_tokens: 65_536,
        thinking: { type: "disabled" },
        stream_options: {
          include_usage: true,
        },
      })
    );
  });

  it("forwards stream tools and tool choice to DeepSeek chat completions", async () => {
    const {
      LLMPerformanceMonitor,
    } = require("../../../utils/helpers/chat/LLMPerformanceMonitor");
    LLMPerformanceMonitor.measureStream.mockResolvedValueOnce("stream");
    const tools = [
      {
        type: "function",
        function: {
          name: "save_memory",
          parameters: { type: "object" },
        },
      },
    ];

    const llm = new DeepSeekLLM(null, "deepseek-v4-flash");
    await llm.streamGetChatCompletion([{ role: "user", content: "hello" }], {
      tools,
      toolChoice: "auto",
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools,
        tool_choice: "auto",
      })
    );
  });

  it("forwards stream thinking options for long-term memory prompts", async () => {
    const {
      LLMPerformanceMonitor,
    } = require("../../../utils/helpers/chat/LLMPerformanceMonitor");
    LLMPerformanceMonitor.measureStream.mockResolvedValueOnce("stream");

    const llm = new DeepSeekLLM(null, "deepseek-v4-flash");
    await llm.streamGetChatCompletion([{ role: "user", content: "hello" }], {
      thinking: "enabled",
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 65_536,
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      })
    );
    expect(mockCreate.mock.calls.at(-1)[0]).not.toHaveProperty("temperature");
  });

  it("preserves cache usage metrics from final streaming usage chunks", async () => {
    const llm = new DeepSeekLLM(null, "deepseek-v4-flash");
    const response = {
      write: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const stream = {
      endMeasurement: jest.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [{ delta: { content: "ok" }, finish_reason: null }],
        };
        yield {
          choices: [{ delta: {}, finish_reason: "stop" }],
        };
        yield {
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 1,
            total_tokens: 11,
            prompt_cache_hit_tokens: 8,
            prompt_cache_miss_tokens: 2,
          },
        };
      },
    };

    await expect(
      llm.handleStream(response, stream, { sources: [] })
    ).resolves.toBe("ok");

    expect(stream.endMeasurement).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt_tokens: 10,
        completion_tokens: 1,
        prompt_cache_hit_tokens: 8,
        prompt_cache_miss_tokens: 2,
        prompt_cache_hit_rate: 0.8,
      })
    );
  });

  it("does not stream or save reasoning_content chunks", async () => {
    const llm = new DeepSeekLLM(null, "deepseek-v4-flash");
    const response = {
      write: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const stream = {
      endMeasurement: jest.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: { reasoning_content: "private reasoning" },
              finish_reason: null,
            },
          ],
        };
        yield {
          choices: [{ delta: { content: "visible" }, finish_reason: null }],
        };
        yield {
          choices: [{ delta: {}, finish_reason: "stop" }],
        };
      },
    };

    await expect(
      llm.handleStream(response, stream, { sources: [] })
    ).resolves.toBe("visible");

    const written = response.write.mock.calls
      .map(([chunk]) => String(chunk))
      .join("\n");
    expect(written).toContain("visible");
    expect(written).not.toContain("private reasoning");
    expect(written).not.toContain("<think>");
  });

  it("diagnoses stable high-hit cache requests without leaking content", () => {
    const previousMetrics = {
      model: "deepseek-v4-pro",
      prompt_cache_hit_tokens: 90,
      prompt_cache_miss_tokens: 10,
      prompt_cache_hit_rate: 0.9,
      promptCacheDiagnostics: deepSeekPromptCacheDiagnostics({
        provider: "DeepSeekLLM",
        model: "deepseek-v4-pro",
        providerPath: "workspace-chat",
        messages: [
          { role: "system", content: "secret stable system" },
          { role: "user", content: "secret current one" },
        ],
      }),
    };
    const metrics = {
      model: "deepseek-v4-pro",
      prompt_cache_hit_tokens: 95,
      prompt_cache_miss_tokens: 5,
      prompt_cache_hit_rate: 0.95,
      promptCacheDiagnostics: deepSeekPromptCacheDiagnostics({
        provider: "DeepSeekLLM",
        model: "deepseek-v4-pro",
        providerPath: "workspace-chat",
        messages: [
          { role: "system", content: "secret stable system" },
          { role: "user", content: "secret current two" },
        ],
      }),
    };

    const result = withDeepSeekCacheDiagnosis(metrics, previousMetrics);

    expect(result.cacheDiagnosis).toEqual(
      expect.objectContaining({
        reason: "stable_or_high_hit",
        stablePrefixChanged: false,
        toolShapeChanged: false,
        historyWindowBoundaryChanged: false,
        compactionChanged: false,
      })
    );
    expect(JSON.stringify(result)).not.toContain("secret stable system");
    expect(JSON.stringify(result)).not.toContain("secret current");
  });

  it("diagnoses low-hit history window boundary changes", () => {
    const previousMetrics = {
      prompt_cache_hit_tokens: 90,
      prompt_cache_miss_tokens: 10,
      prompt_cache_hit_rate: 0.9,
      promptCacheDiagnostics: {
        stablePrefixFingerprint: "same",
        toolShapeFingerprint: "tools",
        historyWindow: {
          strategy: "cache-stable-blocks",
          offset: 80,
          windowStartOrdinal: 81,
          windowEndOrdinal: 120,
          currentBlockIndex: 5,
        },
      },
    };
    const metrics = {
      prompt_cache_hit_tokens: 1,
      prompt_cache_miss_tokens: 99,
      prompt_cache_hit_rate: 0.01,
      promptCacheDiagnostics: {
        stablePrefixFingerprint: "changed-by-window",
        toolShapeFingerprint: "tools",
        historyWindow: {
          strategy: "cache-stable-blocks",
          offset: 100,
          windowStartOrdinal: 101,
          windowEndOrdinal: 121,
          currentBlockIndex: 6,
        },
      },
    };

    expect(deepSeekCacheDiagnosis({ metrics, previousMetrics })).toEqual(
      expect.objectContaining({
        reason: "history_window_boundary_changed",
        stablePrefixChanged: true,
        historyWindowBoundaryChanged: true,
      })
    );
  });

  it("diagnoses low-hit tool shape and compaction changes", () => {
    const basePrevious = {
      prompt_cache_hit_tokens: 90,
      prompt_cache_miss_tokens: 10,
      prompt_cache_hit_rate: 0.9,
      promptCacheDiagnostics: {
        stablePrefixFingerprint: "same",
        toolShapeFingerprint: "tools-a",
        compactionFingerprint: "compaction-a",
      },
    };

    expect(
      deepSeekCacheDiagnosis({
        previousMetrics: basePrevious,
        metrics: {
          prompt_cache_hit_tokens: 1,
          prompt_cache_miss_tokens: 99,
          prompt_cache_hit_rate: 0.01,
          promptCacheDiagnostics: {
            stablePrefixFingerprint: "same",
            toolShapeFingerprint: "tools-b",
            compactionFingerprint: "compaction-a",
          },
        },
      })
    ).toEqual(
      expect.objectContaining({
        reason: "tool_shape_changed",
        toolShapeChanged: true,
      })
    );

    expect(
      deepSeekCacheDiagnosis({
        previousMetrics: basePrevious,
        metrics: {
          prompt_cache_hit_tokens: 1,
          prompt_cache_miss_tokens: 99,
          prompt_cache_hit_rate: 0.01,
          promptCacheDiagnostics: {
            stablePrefixFingerprint: "same",
            toolShapeFingerprint: "tools-a",
            compactionFingerprint: "compaction-b",
          },
        },
      })
    ).toEqual(
      expect.objectContaining({
        reason: "compaction_changed",
        compactionChanged: true,
      })
    );
  });

  it("marks missing cache usage without inventing zero values", () => {
    const metrics = {
      promptCacheDiagnostics: {
        stablePrefixFingerprint: "same",
      },
    };

    expect(deepSeekCacheDiagnosis({ metrics })).toEqual(
      expect.objectContaining({
        reason: "cache_usage_missing",
        cacheUsageMissing: true,
        hitRate: null,
      })
    );
    expect(metrics).not.toHaveProperty("prompt_cache_hit_tokens");
    expect(metrics).not.toHaveProperty("prompt_cache_miss_tokens");
  });
});
