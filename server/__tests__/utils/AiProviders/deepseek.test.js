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

const { DeepSeekLLM } = require("../../../utils/AiProviders/deepseek");

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
      response_format: { type: "json_object" },
    });
  });
});
