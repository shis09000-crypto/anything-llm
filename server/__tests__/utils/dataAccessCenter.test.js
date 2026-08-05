const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage");

const mockAuthority = {
  listLibrary: jest.fn(),
  bootstrap: jest.fn(),
  patchItem: jest.fn(),
  softDeleteItem: jest.fn(),
  restoreItem: jest.fn(),
  patchCategory: jest.fn(),
  reconcileCatalog: jest.fn(),
  snapshot: jest.fn(),
};

jest.mock("../../models/readerDataAuthority", () => ({
  ReaderDataAuthority: mockAuthority,
}));

const { DataAccessCenter } = require("../../utils/dataAccess");
const {
  DocumentIndexStatusRepository,
} = require("../../repositories/documentIndexStatusRepository");
const { DocumentRepository } = require("../../repositories/documentRepository");
const {
  DocumentVectorRepository,
} = require("../../repositories/documentVectorRepository");
const {
  AuthIdentityRepository,
} = require("../../repositories/authIdentityRepository");
const {
  WorkspaceParsedFileRepository,
} = require("../../repositories/workspaceParsedFileRepository");
const {
  WorkspaceChatRepository,
} = require("../../repositories/workspaceChatRepository");
const {
  WorkspaceRepository,
} = require("../../repositories/workspaceRepository");
const {
  WorkspaceCognitionRepository,
} = require("../../repositories/workspaceCognitionRepository");
const {
  UserStateRepository,
} = require("../../repositories/userStateRepository");
const {
  RuntimeLifecycleRepository,
} = require("../../repositories/runtimeLifecycleRepository");

describe("DataAccessCenter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    DataAccessCenter.resetForTests();
  });

  test("exposes a stable repository registry", () => {
    expect(DataAccessCenter.domains).toContain("readerLibrary");
    expect(DataAccessCenter.domains).toContain("workspace");
    expect(DataAccessCenter.domains).toContain("workspaceChat");
    expect(DataAccessCenter.domains).toContain("documentVector");
    expect(DataAccessCenter.domains).toContain("authIdentity");
    expect(DataAccessCenter.domains).toContain("adminSystem");
    expect(DataAccessCenter.domains).toContain("athenaMutationReceipt");
    expect(typeof DataAccessCenter.athenaMutationReceipt.reserve).toBe(
      "function"
    );
    expect(typeof DataAccessCenter.athenaMutationReceipt.complete).toBe(
      "function"
    );
    expect(typeof DataAccessCenter.athenaMutationReceipt.fail).toBe("function");
    expect(typeof DataAccessCenter.athenaMutationReceipt.release).toBe(
      "function"
    );
    expect(typeof DataAccessCenter.athenaMutationReceipt.renew).toBe(
      "function"
    );
    expect(typeof DataAccessCenter.athenaMutationReceipt.sweepStale).toBe(
      "function"
    );
    expect(typeof DataAccessCenter.athenaMutationReceipt.snapshot).toBe(
      "function"
    );
    expect(typeof DataAccessCenter.syncV2.claimOutbox).toBe("function");
    expect(typeof DataAccessCenter.syncV2.releaseOutboxClaims).toBe("function");
    expect(typeof DataAccessCenter.syncV2.renewOutboxClaims).toBe("function");
    expect(typeof DataAccessCenter.syncV2.markOutboxDispatched).toBe(
      "function"
    );
    expect(typeof DataAccessCenter.syncV2.failOutboxClaim).toBe("function");
    expect(typeof DataAccessCenter.syncV2.outboxHealth).toBe("function");
    expect(typeof DataAccessCenter.runtimeLifecycle.databaseReadiness).toBe(
      "function"
    );
    expect(typeof DataAccessCenter.workspaceThread.claimAutomaticTitle).toBe(
      "function"
    );
    expect(DataAccessCenter.domains).toContain("crypto");
    expect(DataAccessCenter.domains).toContain("sensitiveData");
    expect(DataAccessCenter.domains).toContain("vault");
    expect(DataAccessCenter.repository("readerLibrary")).toHaveProperty(
      "ReaderLibraryRepository"
    );
    expect(DataAccessCenter.repositoryObject("workspace")).toBe(
      WorkspaceRepository
    );
    expect(() => DataAccessCenter.repository("missing")).toThrow(
      /Unknown data access repository domain/
    );
  });

  test("runtime lifecycle facade exposes audited database readiness", async () => {
    jest
      .spyOn(RuntimeLifecycleRepository, "databaseReadiness")
      .mockResolvedValueOnce({
        ready: true,
        mainProvider: "sqlite",
        authProvider: "sqlite",
      });

    await expect(
      DataAccessCenter.runtimeLifecycle.databaseReadiness()
    ).resolves.toMatchObject({ ready: true });
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "runtimeLifecycle",
      operation: "databaseReadiness",
      accessType: "read",
      success: true,
    });
  });

  test("workspace facade calls the repository and records clause scope", async () => {
    jest.spyOn(WorkspaceRepository, "get").mockResolvedValueOnce({
      id: 1,
      slug: "research",
    });

    const result = await DataAccessCenter.workspace.get({ slug: "research" });

    expect(result.slug).toBe("research");
    expect(WorkspaceRepository.get).toHaveBeenCalledWith({
      slug: "research",
    });
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "workspace",
      operation: "get",
      accessType: "read",
      ownerScope: { slug: "research" },
      success: true,
    });
  });

  test("document index status facade records write operations", async () => {
    jest
      .spyOn(DocumentIndexStatusRepository, "manualUpdate")
      .mockResolvedValueOnce({
        workspaceId: 3,
        filePath: "folder/doc.pdf",
        indexStatus: "indexed",
      });

    const result = await DataAccessCenter.documentIndexStatus.manualUpdate({
      workspaceId: 3,
      filePath: "folder/doc.pdf",
      indexStatus: "indexed",
    });

    expect(result.indexStatus).toBe("indexed");
    expect(DocumentIndexStatusRepository.manualUpdate).toHaveBeenCalledWith({
      workspaceId: 3,
      filePath: "folder/doc.pdf",
      indexStatus: "indexed",
    });
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "documentIndexStatus",
      operation: "manualUpdate",
      accessType: "write",
      ownerScope: { workspaceId: "3", filePath: "folder/doc.pdf" },
      success: true,
    });
  });

  test("document index status facade records workspace reads", async () => {
    jest
      .spyOn(DocumentIndexStatusRepository, "forWorkspace")
      .mockResolvedValueOnce([]);

    const result = await DataAccessCenter.documentIndexStatus.forWorkspace(3);

    expect(result).toEqual([]);
    expect(DocumentIndexStatusRepository.forWorkspace).toHaveBeenCalledWith(3);
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "documentIndexStatus",
      operation: "forWorkspace",
      accessType: "read",
      ownerScope: { workspaceId: "3" },
      success: true,
    });
  });

  test("document index status facade exposes status constants", () => {
    expect(DataAccessCenter.documentIndexStatus.statuses.indexing).toBe(
      "indexing"
    );
    expect(DataAccessCenter.documentIndexStatus.validStatuses).toContain(
      "indexed"
    );
  });

  test("document remove facade records workspace owner scope", async () => {
    jest
      .spyOn(DocumentRepository, "removeDocuments")
      .mockResolvedValueOnce(true);

    const result = await DataAccessCenter.document.removeDocuments(
      { id: 3, slug: "research" },
      ["custom-documents/a.json", "custom-documents/b.json"],
      7
    );

    expect(result).toBe(true);
    expect(DocumentRepository.removeDocuments).toHaveBeenCalledWith(
      { id: 3, slug: "research" },
      ["custom-documents/a.json", "custom-documents/b.json"],
      7
    );
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "document",
      operation: "removeDocuments",
      accessType: "write",
      ownerScope: {
        workspaceId: "3",
        workspaceSlug: "research",
        userId: "7",
        count: "2",
      },
      success: true,
    });
  });

  test("document vector facade records consistency write scope", async () => {
    jest
      .spyOn(DocumentVectorRepository, "deleteForWorkspace")
      .mockResolvedValueOnce(true);

    const result = await DataAccessCenter.documentVector.deleteForWorkspace(3);

    expect(result).toBe(true);
    expect(DocumentVectorRepository.deleteForWorkspace).toHaveBeenCalledWith(3);
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "documentVector",
      operation: "deleteForWorkspace",
      accessType: "write",
      ownerScope: { workspaceId: "3" },
      success: true,
    });
  });

  test("workspace chat facade records thread history scope", async () => {
    jest.spyOn(WorkspaceChatRepository, "where").mockResolvedValueOnce([]);

    const result = await DataAccessCenter.workspaceChat.where({
      workspaceId: 3,
      thread_id: 9,
      user_id: 7,
    });

    expect(result).toEqual([]);
    expect(WorkspaceChatRepository.where).toHaveBeenCalledWith({
      workspaceId: 3,
      thread_id: 9,
      user_id: 7,
    });
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "workspaceChat",
      operation: "where",
      accessType: "read",
      ownerScope: { workspaceId: "3", userId: "7" },
      success: true,
    });
  });

  test("workspace cognition facade exposes the append-only v2 API", () => {
    const methods = [
      "enqueueThreadBackfill",
      "requestFlush",
      "retryExtractionJob",
      "listExtractionState",
      "listCandidates",
      "createManualCandidate",
      "reviewCandidate",
      "itemHistory",
      "listLedgerItems",
      "reviseCanonicalItemFromProjection",
      "currentCanonicalView",
      "rebuildCanonicalProfile",
      "getProfileState",
      "appendEvidenceEventsForSources",
      "appendEvidencePolicyEvent",
      "cancelBufferedChats",
    ];

    for (const method of methods) {
      expect(typeof DataAccessCenter.workspaceCognition[method]).toBe(
        "function"
      );
    }
  });

  test("workspace cognition facade records candidate review scope", async () => {
    jest
      .spyOn(WorkspaceCognitionRepository, "reviewCandidate")
      .mockResolvedValueOnce({ item: { id: 91 } });

    const result = await DataAccessCenter.workspaceCognition.reviewCandidate({
      workspaceId: 34,
      candidateId: 5,
      actorUserId: 1,
      eventType: "confirmed",
      idempotencyKey: "review-5",
    });

    expect(result.item.id).toBe(91);
    expect(WorkspaceCognitionRepository.reviewCandidate).toHaveBeenCalledWith({
      workspaceId: 34,
      candidateId: 5,
      actorUserId: 1,
      eventType: "confirmed",
      idempotencyKey: "review-5",
    });
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "workspaceCognition",
      operation: "reviewCandidate",
      accessType: "write",
      ownerScope: { workspaceId: "34", candidateId: "5" },
      success: true,
    });
  });

  test("auth identity facade exposes sync policy without sensitive fields", async () => {
    jest.spyOn(AuthIdentityRepository, "describeSyncPolicy");

    const policy = await DataAccessCenter.authIdentity.describeSyncPolicy();

    expect(AuthIdentityRepository.describeSyncPolicy).toHaveBeenCalled();
    expect(policy).toMatchObject({
      sourceOfTruth: "shared-auth",
      localShadowPurpose: "runtime-compatibility-and-legacy-joins",
    });
    expect(policy.forbidden).toContain("password-plaintext");
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "authIdentity",
      operation: "describeSyncPolicy",
      accessType: "read",
      success: true,
    });
  });

  test("records data classification stats for sensitive domains", async () => {
    jest.spyOn(AuthIdentityRepository, "describeSyncPolicy");

    await DataAccessCenter.authIdentity.describeSyncPolicy();

    const snapshot = DataAccessCenter.snapshot();
    expect(snapshot.byClassification.sensitive).toBe(1);
    expect(snapshot.recent[0]).toMatchObject({
      domain: "authIdentity",
      classification: "sensitive",
    });
  });

  test("exposes storage adapter registry for P2 provider boundaries", () => {
    const summary = DataAccessCenter.storage.summary();

    expect(summary.active).toHaveProperty("file");
    expect(summary.active).toHaveProperty("vector");
    expect(summary.active).toHaveProperty("secret");
    expect(summary.active).toHaveProperty("objectStorage");
    expect(summary.reserved).toHaveProperty("postgres");
    expect(summary.reserved).toHaveProperty("redis");
  });

  test("workspace parsed file facade records multi-argument owner scope", async () => {
    jest
      .spyOn(WorkspaceParsedFileRepository, "moveToDocumentsAndEmbed")
      .mockResolvedValueOnce({ success: true, document: { name: "doc.pdf" } });

    const result =
      await DataAccessCenter.workspaceParsedFile.moveToDocumentsAndEmbed(
        { id: 7 },
        "file-1",
        { id: 3, slug: "research" },
        { id: "file-1" }
      );

    expect(result.success).toBe(true);
    expect(
      WorkspaceParsedFileRepository.moveToDocumentsAndEmbed
    ).toHaveBeenCalledWith(
      { id: 7 },
      "file-1",
      { id: 3, slug: "research" },
      { id: "file-1" }
    );
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "workspaceParsedFile",
      operation: "moveToDocumentsAndEmbed",
      accessType: "write",
      ownerScope: {
        userId: "7",
        fileId: "file-1",
        workspaceId: "3",
        workspaceSlug: "research",
      },
      success: true,
    });
  });

  test("user state facade records namespace scope and exposes policy summary", async () => {
    jest.spyOn(UserStateRepository, "where").mockResolvedValueOnce([
      {
        namespace: "reader.library",
        scope: "global",
        value: { bookshelf: [] },
      },
    ]);

    const result = await DataAccessCenter.userState.where({
      userId: 7,
      namespaces: ["reader.library"],
    });

    expect(result[0].namespace).toBe("reader.library");
    expect(UserStateRepository.where).toHaveBeenCalledWith({
      userId: 7,
      namespaces: ["reader.library"],
    });
    expect(
      DataAccessCenter.userState.namespacePolicy("reader.library")
    ).toMatchObject({
      authority: "bootstrap-cache",
      businessAuthority: false,
    });
    expect(DataAccessCenter.snapshot().recent[0]).toMatchObject({
      domain: "userState",
      operation: "where",
      accessType: "read",
      ownerScope: { userId: "7", namespaces: "reader.library" },
      success: true,
    });
  });

  test("reader library read runs through the center and records owner scope", async () => {
    mockAuthority.listLibrary.mockResolvedValueOnce({
      revision: "r1",
      bookshelf: [],
      categories: [],
    });

    const result = await DataAccessCenter.readerLibrary.listLibrary({
      userId: 7,
    });

    expect(result.revision).toBe("r1");
    expect(mockAuthority.listLibrary).toHaveBeenCalledWith({ userId: 7 });

    const snapshot = DataAccessCenter.snapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.byDomain["reader-library"]).toBe(1);
    expect(snapshot.byAccessType.read).toBe(1);
    expect(snapshot.recent[0]).toMatchObject({
      domain: "reader-library",
      operation: "listLibrary",
      accessType: "read",
      ownerScope: { userId: "7" },
      success: true,
    });
  });

  test("reader library writes sanitize sensitive fields at the center boundary", async () => {
    mockAuthority.patchItem.mockResolvedValueOnce({ itemId: "book-1" });

    await DataAccessCenter.readerLibrary.patchItem({
      userId: 7,
      itemId: "book-1",
      patch: {
        title: "Visible",
        originalUrl: "https://example.test/private.pdf?token=secret",
        nested: { apiKey: "secret", category: "ok" },
      },
    });

    expect(mockAuthority.patchItem).toHaveBeenCalledWith({
      userId: 7,
      itemId: "book-1",
      patch: {
        title: "Visible",
        nested: { category: "ok" },
      },
    });

    const snapshot = DataAccessCenter.snapshot();
    expect(snapshot.byAccessType.write).toBe(1);
  });

  test("missing owner scope is rejected before hitting the authority", () => {
    expect(() => DataAccessCenter.readerLibrary.listLibrary({})).toThrow(
      /requires a userId/
    );

    expect(mockAuthority.listLibrary).not.toHaveBeenCalled();
    expect(DataAccessCenter.snapshot().total).toBe(0);
  });

  test("failed authority calls are surfaced and counted", async () => {
    mockAuthority.snapshot.mockRejectedValueOnce(new Error("db offline"));

    await expect(
      DataAccessCenter.readerLibrary.snapshot({ userId: 7 })
    ).rejects.toThrow("db offline");

    const snapshot = DataAccessCenter.snapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.failed).toBe(1);
    expect(snapshot.recent[0]).toMatchObject({
      domain: "reader-library",
      operation: "snapshot",
      success: false,
      errorMessage: "db offline",
    });
  });
});
