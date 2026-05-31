const mockGetChatCompletion = jest.fn();
const mockFindCached = jest.fn();
const mockCreate = jest.fn();

jest.mock("../../../models/workspaceMindMaps", () => ({
  WorkspaceMindMaps: {
    cacheUserKey: jest.fn((user) => (user?.id ? `user:${user.id}` : "anonymous")),
    findCached: mockFindCached,
    create: mockCreate,
    where: jest.fn(async () => []),
  },
}));

jest.mock("../../../models/workspaceThread", () => ({
  WorkspaceThread: { get: jest.fn(async () => null) },
}));

jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: { get: jest.fn() },
}));

jest.mock("../../../models/documents", () => ({
  Document: {
    get: jest.fn(async () => ({
      docId: "doc-1",
      docpath: "custom-documents/doc.json",
      filename: "doc.json",
      workspaceId: 1,
    })),
    content: jest.fn(async () => ({
      title: "Document",
      content:
        "## Architecture\n- Frontend\n- Backend\n- Cache\n\nThen the pipeline compares tree versus timeline output because each layout depends on structure.",
    })),
  },
}));

jest.mock("../../../models/documentIndexStatus", () => ({
  DocumentIndexStatus: {
    statuses: { outdated: "outdated", failed: "failed" },
    where: jest.fn(async () => []),
  },
}));

jest.mock("../../../models/workspaceParsedFiles", () => ({
  WorkspaceParsedFiles: { get: jest.fn() },
}));

jest.mock("../../../utils/helpers", () => ({
  getBaseLLMProviderModel: jest.fn(() => "test-model"),
  getLLMProvider: jest.fn(() => ({
    compressMessages: jest.fn(async ({ systemPrompt, userPrompt }) => [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]),
    getChatCompletion: mockGetChatCompletion,
  })),
}));

const { generateMindMap } = require("../../../utils/mindMap");
const { DocumentIndexStatus } = require("../../../models/documentIndexStatus");

describe("generateMindMap", () => {
  const workspace = { id: 1, slug: "workspace", chatProvider: "openai" };
  const user = { id: 7 };
  const complexText =
    "## System Architecture\n- Frontend panel\n- Backend route\n- Cache layer\n\nFirst normalize content. Then check cache. Finally generate JSON because the workflow depends on source structure and comparison tradeoffs.";

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindCached.mockResolvedValue(null);
    mockCreate.mockImplementation(async (data) => ({
      mindMap: { id: 1, ...data },
      error: null,
    }));
    mockGetChatCompletion.mockResolvedValue({
      textResponse: JSON.stringify({
        title: "Generated",
        layout: "tree",
        theme: "napkin",
        nodes: [
          { id: "root", label: "Root", level: 0 },
          { id: "child", label: "Child", parentId: "root", level: 1 },
        ],
        edges: [{ source: "root", target: "child" }],
      }),
    });
  });

  it("returns a recommendation without calling the model for simple content", async () => {
    const result = await generateMindMap({
      workspace,
      user,
      body: { sourceType: "text", text: "Tiny note." },
    });

    expect(result.mindMap).toBeNull();
    expect(result.suitability.status).toBe("not_recommended");
    expect(mockGetChatCompletion).not.toHaveBeenCalled();
  });

  it("returns cached maps without calling the model", async () => {
    mockFindCached.mockResolvedValue({ id: 99, title: "Cached" });

    const result = await generateMindMap({
      workspace,
      user,
      body: { sourceType: "text", text: complexText },
    });

    expect(result.cached).toBe(true);
    expect(result.mindMap.id).toBe(99);
    expect(mockGetChatCompletion).not.toHaveBeenCalled();
  });

  it("persists prompt, schema, and model metadata on generation", async () => {
    const result = await generateMindMap({
      workspace,
      user,
      body: { sourceType: "text", text: complexText, force: true },
    });

    expect(result.mindMap.promptVersion).toBe("mind-map-v1");
    expect(result.mindMap.schemaVersion).toBe("1.0.0");
    expect(result.mindMap.generationModel).toBe("test-model");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceHash: expect.any(String),
        suitability: expect.objectContaining({ status: "recommended" }),
      })
    );
  });

  it("requests JSON response format when generating the schema", async () => {
    await generateMindMap({
      workspace,
      user,
      body: { sourceType: "text", text: complexText, force: true },
    });

    expect(mockGetChatCompletion).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        temperature: 0.2,
        user,
        responseFormat: { type: "json_object" },
      })
    );
  });

  it("retries transient LLM transport errors before creating a mind map", async () => {
    mockGetChatCompletion
      .mockRejectedValueOnce(new Error("Premature close"))
      .mockResolvedValueOnce({
        textResponse: JSON.stringify({
          title: "Retried",
          layout: "tree",
          theme: "napkin",
          nodes: [
            { id: "root", label: "Root", level: 0 },
            { id: "child", label: "Child", parentId: "root", level: 1 },
          ],
          edges: [{ source: "root", target: "child" }],
        }),
      });

    const result = await generateMindMap({
      workspace,
      user,
      body: { sourceType: "text", text: complexText, force: true },
    });

    expect(mockGetChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.mindMap.title).toBe("Retried");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-transient LLM errors", async () => {
    mockGetChatCompletion.mockRejectedValueOnce(new Error("invalid_api_key"));

    await expect(
      generateMindMap({
        workspace,
        user,
        body: { sourceType: "text", text: complexText, force: true },
      })
    ).rejects.toThrow("invalid_api_key");

    expect(mockGetChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("throws the last transient error after exhausting retries", async () => {
    mockGetChatCompletion
      .mockRejectedValueOnce(new Error("Premature close"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("Invalid response body"));

    await expect(
      generateMindMap({
        workspace,
        user,
        body: { sourceType: "text", text: complexText, force: true },
      })
    ).rejects.toThrow("Invalid response body");

    expect(mockGetChatCompletion).toHaveBeenCalledTimes(3);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("warns when a document index status is failed", async () => {
    DocumentIndexStatus.where.mockResolvedValueOnce([
      {
        indexStatus: "failed",
        errorMessage: "embedding failed",
      },
    ]);

    const result = await generateMindMap({
      workspace,
      user,
      body: { sourceType: "document", docId: "doc-1", force: true },
    });

    expect(result.documentStatusWarning).toEqual(
      expect.objectContaining({ status: "failed" })
    );
  });
});
