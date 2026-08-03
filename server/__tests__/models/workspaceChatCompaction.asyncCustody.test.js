const mockPrisma = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  workspace_chat_compactions: { create: jest.fn() },
};
const mockEncryptSecretAsync = jest.fn();
const mockDecryptSecretIfNeededAsync = jest.fn();

jest.mock("../../utils/prisma", () => mockPrisma);
jest.mock("../../utils/database/schemaIntrospection", () => ({
  databaseTableColumns: jest.fn(async () => new Set()),
  ensureMigrationOwnedTables: jest.fn(async () => true),
}));
jest.mock("../../utils/security", () => ({
  chatHistoryEncryptionEnabled: jest.fn(() => true),
  decryptSecretIfNeededAsync: mockDecryptSecretIfNeededAsync,
  decryptWorkspaceChatRecordsAsync: jest.fn(async (rows) => rows),
  encryptSecretAsync: mockEncryptSecretAsync,
  isEncryptedSecret: jest.fn(
    (value) => typeof value === "string" && value.startsWith("enc:")
  ),
}));

describe("WorkspaceChatCompaction remote Key Custody boundary", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockDecryptSecretIfNeededAsync.mockImplementation(async (value) => value);
    mockPrisma.workspace_chat_compactions.create.mockImplementation(
      async ({ data }) => ({
        id: 14,
        ...data,
        created_at: new Date("2026-07-01T00:00:00.000Z"),
        updated_at: new Date("2026-07-01T00:00:00.000Z"),
      })
    );
  });

  it("encrypts both protected fields before the single database write", async () => {
    const pending = [];
    mockEncryptSecretAsync.mockImplementation(
      (value) =>
        new Promise((resolve) => pending.push(() => resolve(`enc:v2:${value}`)))
    );
    const {
      WorkspaceChatCompaction,
    } = require("../../models/workspaceChatCompaction");
    const create = WorkspaceChatCompaction.create({
      workspace_id: 1,
      thread_id: 2,
      user_id: 3,
      summary: "summary",
      capsule_json: "capsule",
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(mockPrisma.workspace_chat_compactions.create).not.toHaveBeenCalled();
    expect(pending).toHaveLength(2);
    pending.forEach((resolve) => resolve());
    await create;

    expect(mockPrisma.workspace_chat_compactions.create).toHaveBeenCalledTimes(
      1
    );
    expect(mockEncryptSecretAsync).toHaveBeenCalledWith(
      "summary",
      expect.objectContaining({
        purpose: "chat-conversation-key",
        operation: "thread-memory-write",
      })
    );
  });

  it("does not create a partial row when either wrap fails", async () => {
    mockEncryptSecretAsync
      .mockResolvedValueOnce("enc:v2:summary")
      .mockRejectedValueOnce(new Error("custody unavailable"));
    const {
      WorkspaceChatCompaction,
    } = require("../../models/workspaceChatCompaction");

    await expect(
      WorkspaceChatCompaction.create({
        workspace_id: 1,
        thread_id: 2,
        user_id: 3,
        summary: "summary",
        capsule_json: "capsule",
      })
    ).rejects.toMatchObject({
      code: "thread_memory_decryption_unavailable",
      httpStatus: 503,
    });
    expect(mockPrisma.workspace_chat_compactions.create).not.toHaveBeenCalled();
  });
});
