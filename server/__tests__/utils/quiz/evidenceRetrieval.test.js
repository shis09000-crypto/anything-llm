const mockPerformSimilaritySearch = jest.fn();
const mockEmbedTextInput = jest.fn();
const mockHasNamespace = jest.fn();
const mockNamespaceCount = jest.fn();

jest.mock("../../../utils/helpers", () => ({
  getEmbeddingEngineSelection: jest.fn(() => ({
    embedTextInput: mockEmbedTextInput,
  })),
  getVectorDbClass: jest.fn(() => ({
    hasNamespace: mockHasNamespace,
    namespaceCount: mockNamespaceCount,
    performSimilaritySearch: mockPerformSimilaritySearch,
  })),
}));

jest.mock("../../../utils/chats", () => ({
  sourceIdentifier: jest.fn((source) => source.id || source.docId || "source"),
}));

describe("quiz evidence retrieval", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasNamespace.mockResolvedValue(true);
    mockNamespaceCount.mockResolvedValue(1);
    mockPerformSimilaritySearch.mockResolvedValue({
      sources: [],
      message: null,
    });
    mockEmbedTextInput.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it("uses the configured embedding engine for vector search query embeddings", async () => {
    const { retrieveQuizEvidence } = require("../../../utils/quiz/evidence");

    await retrieveQuizEvidence({
      workspace: { slug: "workspace-a", similarityThreshold: 0.7 },
      plan: { topic: "biology", searchQueries: ["cell structure"] },
    });

    expect(mockPerformSimilaritySearch).toHaveBeenCalledTimes(1);
    const connector =
      mockPerformSimilaritySearch.mock.calls[0][0].LLMConnector;
    await connector.embedTextInput("cell structure");

    expect(mockEmbedTextInput).toHaveBeenCalledWith("cell structure");
  });
});
