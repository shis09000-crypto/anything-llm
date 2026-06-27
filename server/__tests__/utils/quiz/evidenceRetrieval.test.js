const mockPerformSimilaritySearch = jest.fn();
const mockEmbedTextInput = jest.fn();
const mockHasNamespace = jest.fn();
const mockNamespaceCount = jest.fn();
const mockResolveGraphContext = jest.fn();

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

jest.mock("../../../utils/knowledgeGraph/graphContextResolver", () => ({
  resolveGraphContext: mockResolveGraphContext,
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
    mockResolveGraphContext.mockResolvedValue({
      evidenceChunks: [],
    });
  });

  it("uses the configured embedding engine for vector search query embeddings", async () => {
    const { retrieveQuizEvidence } = require("../../../utils/quiz/evidence");

    await retrieveQuizEvidence({
      workspace: { slug: "workspace-a", similarityThreshold: 0.7 },
      plan: { topic: "biology", searchQueries: ["cell structure"] },
    });

    expect(mockPerformSimilaritySearch).toHaveBeenCalledTimes(1);
    const connector = mockPerformSimilaritySearch.mock.calls[0][0].LLMConnector;
    await connector.embedTextInput("cell structure");

    expect(mockEmbedTextInput).toHaveBeenCalledWith("cell structure");
  });

  it("includes node supplement evidence before workspace vector evidence", async () => {
    mockResolveGraphContext.mockResolvedValue({
      evidenceChunks: [
        {
          id: "supp-1",
          text: "Thales supplement evidence",
          title: "泰勒斯人物资料.md",
          docId: "doc-supp",
          sourceType: "node_supplement",
          nodeKey: "person:thales",
          nodeLabel: "泰勒斯",
          score: 5,
        },
      ],
    });
    mockPerformSimilaritySearch.mockResolvedValue({
      sources: [
        {
          id: "book-1",
          text: "Book evidence",
          title: "西方哲学史.md",
          docId: "doc-book",
          score: 1,
        },
      ],
      message: null,
    });
    const { retrieveQuizEvidence } = require("../../../utils/quiz/evidence");

    const result = await retrieveQuizEvidence({
      workspace: { id: 7, slug: "workspace-a", similarityThreshold: 0.7 },
      plan: { topic: "泰勒斯", searchQueries: ["水是本原"] },
      nodeContext: {
        nodeKey: "person:thales",
        nodeLabel: "泰勒斯",
        nodeType: "person",
      },
    });

    expect(mockResolveGraphContext).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeKey: "person:thales",
      })
    );
    expect(result.error).toBeNull();
    expect(result.evidenceChunks[0].text).toBe("Thales supplement evidence");
    expect(result.sourceRefs[0]).toEqual(
      expect.objectContaining({
        sourceType: "node_supplement",
        nodeKey: "person:thales",
      })
    );
  });

  it("can return node supplement evidence when the vector namespace is empty", async () => {
    mockHasNamespace.mockResolvedValue(false);
    mockResolveGraphContext.mockResolvedValue({
      evidenceChunks: [
        {
          id: "supp-1",
          text: "Supplement-only evidence",
          title: "泰勒斯人物资料.md",
          docId: "doc-supp",
          sourceType: "node_supplement",
          score: 3,
        },
      ],
    });
    const { retrieveQuizEvidence } = require("../../../utils/quiz/evidence");

    const result = await retrieveQuizEvidence({
      workspace: { id: 7, slug: "workspace-a" },
      plan: { topic: "泰勒斯", searchQueries: [] },
      nodeContext: { nodeKey: "person:thales", nodeLabel: "泰勒斯" },
    });

    expect(mockPerformSimilaritySearch).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.evidenceChunks).toHaveLength(1);
  });

  it("falls back to general knowledge evidence when workspace evidence is unavailable", async () => {
    mockHasNamespace.mockResolvedValue(false);
    mockResolveGraphContext.mockResolvedValue({ evidenceChunks: [] });
    const { retrieveQuizEvidence } = require("../../../utils/quiz/evidence");

    const result = await retrieveQuizEvidence({
      workspace: { id: 7, slug: "workspace-a" },
      plan: { topic: "洛克经验主义", searchQueries: [] },
    });

    expect(mockPerformSimilaritySearch).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.evidenceMode).toBe("general_knowledge");
    expect(result.evidenceChunks).toHaveLength(1);
    expect(result.evidenceChunks[0].id).toBe("general-knowledge");
    expect(result.sourceRefs[0]).toEqual(
      expect.objectContaining({
        id: "general-knowledge",
        sourceType: "general_knowledge",
      })
    );
  });
});
