process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

const mockCreate = jest.fn();

jest.mock("openai", () => {
  const OpenAI = jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }));
  OpenAI.AuthenticationError = class AuthenticationError extends Error {};
  OpenAI.RateLimitError = class RateLimitError extends Error {};
  OpenAI.InternalServerError = class InternalServerError extends Error {};
  OpenAI.APIError = class APIError extends Error {};
  return OpenAI;
});

const DeepSeekProvider = require("../../../utils/agents/aibitat/providers/deepseek");
const {
  agentCacheStableHistoryStrategyFor,
} = require("../../../utils/agents");

function toolDefinition(name = "test-tool") {
  return {
    name,
    description: "A deterministic test tool.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Input text" },
      },
      required: ["input"],
    },
  };
}

function historyWindow() {
  return {
    strategy: "cache-stable-blocks",
    blockSize: 20,
    maxBlocks: 2,
    totalCount: 58,
    offset: 20,
    limit: 38,
    windowStartOrdinal: 21,
    windowEndOrdinal: 58,
    currentBlockIndex: 2,
  };
}

async function* streamWithUsage(usage) {
  yield {
    choices: [{ delta: { content: "ok" }, finish_reason: null }],
  };
  yield {
    choices: [],
    usage,
  };
}

describe("DeepSeek agent cache metrics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses cache-stable history only for DeepSeek agent providers", () => {
    expect(
      agentCacheStableHistoryStrategyFor({ provider: "openai", limit: 20 })
    ).toBeNull();
    expect(
      agentCacheStableHistoryStrategyFor({ provider: "deepseek", limit: 20 })
    ).toEqual({
      type: "cache-stable-blocks",
      blockSize: 20,
      maxBlocks: 2,
    });
  });

  it("preserves DeepSeek cache metrics and diagnostics for tooled streaming", async () => {
    mockCreate.mockResolvedValueOnce(
      streamWithUsage({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: 7,
        prompt_cache_miss_tokens: 3,
      })
    );
    const provider = new DeepSeekProvider({ model: "deepseek-v4-pro" });
    provider.attachHandlerProps({
      promptCacheDiagnostics: { historyWindow: historyWindow() },
    });

    const result = await provider.stream(
      [
        { role: "system", content: "stable system" },
        { role: "user", content: "secret current text" },
      ],
      [toolDefinition()]
    );

    expect(result.textResponse).toBe("ok");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-v4-pro",
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 65_536,
        extra_body: {
          thinking: { type: "enabled" },
          reasoning_effort: "high",
        },
        tools: expect.any(Array),
      })
    );
    expect(provider.getUsage()).toEqual(
      expect.objectContaining({
        provider: "DeepSeekProvider",
        model: "deepseek-v4-pro",
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: 7,
        prompt_cache_miss_tokens: 3,
        prompt_cache_hit_rate: 0.7,
        promptCacheDiagnostics: expect.objectContaining({
          providerPath: "agent",
          stablePrefixFingerprint: expect.any(String),
          toolShapeFingerprint: expect.any(String),
          toolCount: 1,
          historyWindow: expect.objectContaining({
            strategy: "cache-stable-blocks",
            offset: 20,
            limit: 38,
          }),
        }),
      })
    );
    expect(JSON.stringify(provider.getUsage())).not.toContain(
      "secret current text"
    );
  });

  it("preserves DeepSeek cache metrics and diagnostics for tooled completion", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "done" } }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 4,
        total_tokens: 24,
        prompt_cache_hit_tokens: 18,
        prompt_cache_miss_tokens: 2,
      },
    });
    const provider = new DeepSeekProvider({ model: "deepseek-v4-flash" });
    provider.attachHandlerProps({
      promptCacheDiagnostics: { historyWindow: historyWindow() },
    });

    const result = await provider.complete(
      [
        { role: "system", content: "stable system" },
        { role: "user", content: "secret current text" },
      ],
      [toolDefinition()]
    );

    expect(result.textResponse).toBe("done");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-v4-flash",
        stream: false,
        max_tokens: 65_536,
        extra_body: {
          thinking: { type: "enabled" },
          reasoning_effort: "high",
        },
      })
    );
    expect(provider.getUsage()).toEqual(
      expect.objectContaining({
        provider: "DeepSeekProvider",
        model: "deepseek-v4-flash",
        prompt_cache_hit_tokens: 18,
        prompt_cache_miss_tokens: 2,
        prompt_cache_hit_rate: 0.9,
        promptCacheDiagnostics: expect.objectContaining({
          providerPath: "agent",
          historyWindow: expect.objectContaining({ offset: 20 }),
        }),
      })
    );
  });

  it("uses 64k output and thinking for non-tooled streaming", async () => {
    mockCreate.mockResolvedValueOnce(
      streamWithUsage({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      })
    );
    const provider = new DeepSeekProvider({ model: "deepseek-v4-pro" });

    await provider.stream([
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ]);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-v4-pro",
        stream: true,
        max_tokens: 65_536,
        extra_body: {
          thinking: { type: "enabled" },
          reasoning_effort: "high",
        },
      })
    );
  });
});
