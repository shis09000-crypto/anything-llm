const mockAddDocumentToNamespace = jest.fn();
const mockEnqueueBatchDocuments = jest.fn();
const mockIsBatchMode = jest.fn();
const mockEmitProgress = jest.fn();

jest.mock("../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(() => ({
    addDocumentToNamespace: mockAddDocumentToNamespace,
  })),
}));

jest.mock("../../utils/prisma", () => ({
  workspace_documents: {
    create: jest.fn(async ({ data }) => data),
  },
}));

jest.mock("../../models/telemetry", () => ({
  Telemetry: {
    sendTelemetry: jest.fn(),
  },
}));

jest.mock("../../models/eventLogs", () => ({
  EventLogs: {
    logEvent: jest.fn(),
  },
}));

jest.mock("../../models/documentIndexStatus", () => ({
  DocumentIndexStatus: {
    upsertPending: jest.fn(),
    markIndexing: jest.fn(),
    markFailed: jest.fn(),
    markCompleted: jest.fn(),
    markIndexed: jest.fn(),
  },
}));

jest.mock("../../endpoints/utils", () => ({
  getModelTag: jest.fn(() => "test-model"),
}));

jest.mock("../../utils/files", () => ({
  fileData: jest.fn(async () => ({
    pageContent: "hello",
    title: "Test document",
    wordCount: 1,
  })),
}));

jest.mock("../../utils/EmbeddingWorkerManager", () => ({
  emitProgress: mockEmitProgress,
}));

jest.mock("../../utils/DocumentEmbeddingBatch", () => ({
  isBatchMode: mockIsBatchMode,
  enqueueBatchDocuments: mockEnqueueBatchDocuments,
}));

const { Document } = require("../../models/documents");

describe("Document.addDocuments embeddingModeOverride", () => {
  const workspace = { id: 1, slug: "test-workspace", name: "Test Workspace" };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAddDocumentToNamespace.mockResolvedValue({
      vectorized: true,
      error: null,
    });
    mockEnqueueBatchDocuments.mockResolvedValue({
      failedToEmbed: [],
      errors: [],
      embedded: ["custom-documents/a.json"],
      batchJob: { jobId: "job-1" },
    });
    mockIsBatchMode.mockImplementation(
      (modeOverride) => modeOverride === "batch"
    );
  });

  it("routes batch overrides through the embedding batch queue", async () => {
    const result = await Document.addDocuments(
      workspace,
      ["custom-documents/a.json"],
      7,
      { embeddingModeOverride: "batch" }
    );

    expect(mockIsBatchMode).toHaveBeenCalledWith("batch");
    expect(mockEnqueueBatchDocuments).toHaveBeenCalledWith({
      workspace,
      additions: ["custom-documents/a.json"],
      userId: 7,
    });
    expect(mockAddDocumentToNamespace).not.toHaveBeenCalled();
    expect(result.batchJob.jobId).toBe("job-1");
  });

  it("routes direct overrides through direct vectorization", async () => {
    const result = await Document.addDocuments(
      workspace,
      ["custom-documents/a.json"],
      7,
      { embeddingModeOverride: "direct" }
    );

    expect(mockIsBatchMode).toHaveBeenCalledWith("direct");
    expect(mockEnqueueBatchDocuments).not.toHaveBeenCalled();
    expect(mockAddDocumentToNamespace).toHaveBeenCalledWith(
      workspace.slug,
      expect.objectContaining({ pageContent: "hello" }),
      "custom-documents/a.json"
    );
    expect(result.embedded).toEqual(["custom-documents/a.json"]);
  });

  it("preserves default mode behavior when no override is supplied", async () => {
    await Document.addDocuments(workspace, ["custom-documents/a.json"], 7);

    expect(mockIsBatchMode).toHaveBeenCalledWith(undefined);
  });
});
