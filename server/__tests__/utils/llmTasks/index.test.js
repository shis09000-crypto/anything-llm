const mockGetLLMProvider = jest.fn();

jest.mock("../../../utils/helpers", () => ({
  getLLMProvider: (...args) => mockGetLLMProvider(...args),
}));

function loadRuntime() {
  jest.resetModules();
  return require("../../../utils/llmTasks");
}

describe("llmTasks runtime", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves known task names and rejects unknown tasks", () => {
    const { resolveTaskConfig } = loadRuntime();
    expect(resolveTaskConfig("thread_title_generation")).toEqual(
      expect.objectContaining({ tier: "rough" })
    );
    expect(() => resolveTaskConfig("missing_task")).toThrow(
      "Unknown LLM task"
    );
  });

  it("maps rough and refined tiers to current default models", () => {
    const { resolveTier } = loadRuntime();
    expect(resolveTier("rough")).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tier: "rough",
    });
    expect(resolveTier("refined")).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      tier: "refined",
    });
  });

  it("honors unified model tier environment overrides", () => {
    process.env.LLM_TASK_ROUGH_MODEL = "rough-test-model";
    process.env.LLM_TASK_REFINED_MODEL = "refined-test-model";
    const { resolveTaskProviderModel } = loadRuntime();

    expect(resolveTaskProviderModel("reader_document_classification")).toEqual(
      expect.objectContaining({ model: "rough-test-model" })
    );
    expect(resolveTaskProviderModel("quiz_generation")).toEqual(
      expect.objectContaining({ model: "refined-test-model" })
    );
  });

  it("throws a clear error when ultra tier is not configured", () => {
    const { resolveTier } = loadRuntime();
    expect(() => resolveTier("ultra")).toThrow(
      'LLM task model tier "ultra" is not configured.'
    );
  });

  it("centralizes legacy env overrides for compaction and knowledge graph tasks", () => {
    process.env.THREAD_COMPACTION_PROVIDER = "openai";
    process.env.THREAD_COMPACTION_MODEL = "gpt-test";
    process.env.KNOWLEDGE_GRAPH_DEEPSEEK_MODEL = "kg-test-model";
    const { resolveTaskProviderModel } = loadRuntime();

    expect(resolveTaskProviderModel("thread_compaction")).toEqual(
      expect.objectContaining({ provider: "openai", model: "gpt-test" })
    );
    expect(resolveTaskProviderModel("knowledge_graph_extract")).toEqual(
      expect.objectContaining({ provider: "deepseek", model: "kg-test-model" })
    );
  });

  it("creates connectors without owning completion or streaming behavior", () => {
    const connector = {
      model: "deepseek-v4-flash",
      getChatCompletion: jest.fn(),
      streamGetChatCompletion: jest.fn(),
    };
    mockGetLLMProvider.mockReturnValue(connector);

    const { getTaskConnector } = loadRuntime();
    const result = getTaskConnector("thread_title_generation");

    expect(mockGetLLMProvider).toHaveBeenCalledWith({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    expect(result.connector).toBe(connector);
    expect(connector.getChatCompletion).not.toHaveBeenCalled();
    expect(connector.streamGetChatCompletion).not.toHaveBeenCalled();
  });
});
