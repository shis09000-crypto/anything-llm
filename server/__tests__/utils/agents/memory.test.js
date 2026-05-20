const mockAddDocumentToNamespace = jest.fn();

jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(() => ({
    addDocumentToNamespace: mockAddDocumentToNamespace,
  })),
  getLLMProvider: jest.fn(),
}));

describe("rag-memory store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAddDocumentToNamespace.mockResolvedValue({ error: null });
  });

  it("writes memory directly to the vector database", async () => {
    const { memory } = require("../../../utils/agents/aibitat/plugins/memory");
    let tool = null;
    const aibitat = {
      handlerProps: {
        invocation: {
          workspace: { slug: "test-workspace" },
        },
        log: jest.fn(),
      },
      introspect: jest.fn(),
      function: (definition) => {
        tool = definition;
      },
    };
    memory.plugin().setup(aibitat);

    const result = await tool.store("remember this");

    expect(mockAddDocumentToNamespace).toHaveBeenCalledWith(
      "test-workspace",
      expect.objectContaining({
        docId: expect.any(String),
        title: "agent-memory.txt",
        pageContent: "remember this",
      }),
      null
    );
    expect(aibitat.handlerProps.log).toHaveBeenCalledWith(
      "memory.store: direct memory write"
    );
    expect(result).toBe(
      "The content given was successfully embedded. There is nothing else to do."
    );
  });

  it("returns the vector database error when memory embedding fails", async () => {
    mockAddDocumentToNamespace.mockResolvedValue({
      error: "LanceDB schema mismatch",
    });

    const { memory } = require("../../../utils/agents/aibitat/plugins/memory");
    let tool = null;
    const aibitat = {
      handlerProps: {
        invocation: {
          workspace: { slug: "test-workspace" },
        },
        log: jest.fn(),
      },
      function: (definition) => {
        tool = definition;
      },
    };
    memory.plugin().setup(aibitat);

    const result = await tool.store("remember this");

    expect(aibitat.handlerProps.log).toHaveBeenCalledWith(
      "memory.store failed to embed content. LanceDB schema mismatch"
    );
    expect(result).toBe(
      "The content was failed to be embedded properly. LanceDB schema mismatch"
    );
  });

  it("does not write empty memory content", async () => {
    const { memory } = require("../../../utils/agents/aibitat/plugins/memory");
    let tool = null;
    const aibitat = {
      handlerProps: {
        invocation: {
          workspace: { slug: "test-workspace" },
        },
        log: jest.fn(),
      },
      function: (definition) => {
        tool = definition;
      },
    };
    memory.plugin().setup(aibitat);

    const result = await tool.store(" ");

    expect(mockAddDocumentToNamespace).not.toHaveBeenCalled();
    expect(result).toBe("The content was not embedded because it was empty.");
  });
});
