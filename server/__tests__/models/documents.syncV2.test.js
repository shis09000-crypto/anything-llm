const mockTransaction = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockProjection = jest.fn();
const mockRecordNodeChange = jest.fn();

const mockTx = {
  workspace_documents: {
    create: (...args) => mockCreate(...args),
    update: (...args) => mockUpdate(...args),
    findMany: jest.fn(),
  },
};

jest.mock("../../utils/prisma", () => ({
  $transaction: (...args) => mockTransaction(...args),
  workspace_documents: {
    create: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock("../../models/syncV2", () => ({
  SyncV2: {
    enabled: jest.fn().mockReturnValue(true),
    schemaReady: jest.fn().mockResolvedValue(true),
    recordNodeChange: (...args) => mockRecordNodeChange(...args),
  },
}));

jest.mock("../../utils/syncV2/documentProjection", () => ({
  workspaceDocumentsProjection: (...args) => mockProjection(...args),
}));

jest.mock("../../utils/helpers", () => ({ getVectorDbClass: jest.fn() }));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../models/documentIndexStatus", () => ({
  DocumentIndexStatus: {},
}));
jest.mock("../../endpoints/utils", () => ({ getModelTag: jest.fn() }));

const { Document } = require("../../models/documents");

describe("Document Sync V2 transaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation(async (callback) => callback(mockTx));
    mockProjection.mockResolvedValue([]);
    mockCreate.mockResolvedValue({
      id: 3,
      workspaceId: 4,
      docId: "doc-3",
      filename: "Design.md",
    });
    mockUpdate.mockResolvedValue({
      id: 3,
      workspaceId: 4,
      docId: "doc-3",
      filename: "Design.md",
      pinned: true,
    });
    mockRecordNodeChange.mockResolvedValue({ event: { seq: 11 } });
  });

  test("creates document metadata and its node event atomically", async () => {
    await Document.create({
      workspaceId: 4,
      docId: "doc-3",
      filename: "Design.md",
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordNodeChange).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        nodeKey: "workspaces/4/documents",
        eventType: "workspace.documents.created",
      })
    );
  });

  test("updates document metadata and its node event atomically", async () => {
    const result = await Document.update(3, { pinned: true });

    expect(result.document.pinned).toBe(true);
    expect(mockRecordNodeChange).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        changedPaths: ["documents.doc-3.pinned"],
        eventType: "workspace.documents.updated",
      })
    );
  });

  test("propagates an outbox failure from document creation", async () => {
    mockRecordNodeChange.mockRejectedValueOnce(new Error("outbox_failed"));

    await expect(
      Document.create({
        workspaceId: 4,
        docId: "doc-3",
        filename: "Design.md",
      })
    ).rejects.toThrow("outbox_failed");
  });
});
