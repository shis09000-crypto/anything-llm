const sequence = [];
const transaction = {
  athena_mutation_receipts: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  workspace_chats: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  workspace_chat_compactions: {
    deleteMany: jest.fn(),
  },
};
const mockPrisma = {
  $transaction: jest.fn(async (operation) => operation(transaction)),
};

jest.mock("../../utils/prisma", () => mockPrisma);
jest.mock("../../models/workspaceChats", () => ({ WorkspaceChats: {} }));
jest.mock("../../utils/chats/chatIdentifiers", () => ({
  newPublicChatId: () => "public-test",
}));
const mockRebuildChatCryptoChainFromChatId = jest.fn();
jest.mock("../../utils/security/chatHistoryEncryption", () => ({
  rebuildChatCryptoChainFromChatId: (...args) =>
    mockRebuildChatCryptoChainFromChatId(...args),
}));

const {
  WorkspaceChatRepository,
} = require("../../repositories/workspaceChatRepository");

describe("WorkspaceChatRepository native edit truncation", () => {
  beforeEach(() => {
    sequence.length = 0;
    jest.clearAllMocks();
    transaction.athena_mutation_receipts.findUnique.mockResolvedValue(null);
    transaction.athena_mutation_receipts.create.mockImplementation(async () => {
      sequence.push("receipt-reserved");
      return { id: 1, status: "pending" };
    });
    transaction.workspace_chats.findFirst.mockImplementation(async () => {
      sequence.push("target-validated");
      return { id: 12 };
    });
    transaction.workspace_chats.findMany.mockResolvedValue([
      { id: 12 },
      { id: 13 },
      { id: 14 },
    ]);
    transaction.workspace_chats.deleteMany.mockImplementation(async () => {
      sequence.push("history-deleted");
      return { count: 3 };
    });
    transaction.workspace_chat_compactions.deleteMany.mockImplementation(
      async () => {
        sequence.push("compaction-deleted");
        return { count: 1 };
      }
    );
    mockRebuildChatCryptoChainFromChatId.mockImplementation(async () => {
      sequence.push("crypto-rebuilt");
      return { success: true };
    });
    transaction.athena_mutation_receipts.update.mockImplementation(async () => {
      sequence.push("receipt-completed");
      return { id: 1, status: "completed" };
    });
  });

  it("deletes the scoped suffix and completes its receipt in one transaction", async () => {
    const result = await WorkspaceChatRepository.truncateForNativeEdit({
      workspaceId: 7,
      threadId: 8,
      userId: 9,
      startingChatId: 12,
      sourceActionId: "edit-12",
    });

    expect(sequence).toEqual([
      "target-validated",
      "receipt-reserved",
      "history-deleted",
      "compaction-deleted",
      "crypto-rebuilt",
      "receipt-completed",
    ]);
    expect(transaction.workspace_chats.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 7,
        thread_id: 8,
        user_id: 9,
        api_session_id: null,
        id: { gte: 12 },
      },
    });
    expect(result).toMatchObject({
      success: true,
      deletedCount: 3,
      replayed: false,
    });
  });

  it("returns a completed matching receipt without deleting twice", async () => {
    transaction.athena_mutation_receipts.findUnique.mockResolvedValue({
      action: "chat.edit.truncate-and-resend",
      workspaceId: 7,
      threadId: 8,
      status: "completed",
    });

    const result = await WorkspaceChatRepository.truncateForNativeEdit({
      workspaceId: 7,
      threadId: 8,
      userId: 9,
      startingChatId: 12,
      sourceActionId: "edit-12",
    });

    expect(result.replayed).toBe(true);
    expect(transaction.workspace_chats.findFirst).not.toHaveBeenCalled();
    expect(transaction.workspace_chats.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a source action already bound to another mutation scope", async () => {
    transaction.athena_mutation_receipts.findUnique.mockResolvedValue({
      action: "thread.rename",
      workspaceId: 7,
      threadId: 8,
      status: "completed",
    });

    await expect(
      WorkspaceChatRepository.truncateForNativeEdit({
        workspaceId: 7,
        threadId: 8,
        userId: 9,
        startingChatId: 12,
        sourceActionId: "edit-12",
      })
    ).rejects.toMatchObject({
      code: "chat_mutation_source_action_conflict",
    });
    expect(transaction.workspace_chats.deleteMany).not.toHaveBeenCalled();
  });

  it("physically replaces only the latest confirmed turn", async () => {
    transaction.workspace_chats.findFirst
      .mockResolvedValueOnce({ id: 14 })
      .mockResolvedValueOnce(null);
    transaction.workspace_chats.findMany.mockResolvedValue([{ id: 14 }]);
    transaction.workspace_chats.deleteMany.mockResolvedValue({ count: 1 });

    const result = await WorkspaceChatRepository.regenerateLastTurn({
      workspaceId: 7,
      threadId: 8,
      userId: 9,
      targetChatId: 14,
      sourceActionId: "regenerate-14",
    });

    expect(transaction.workspace_chats.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 14 }),
    });
    expect(
      transaction.workspace_chat_compactions.deleteMany
    ).toHaveBeenCalled();
    expect(mockRebuildChatCryptoChainFromChatId).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 7, threadId: 8, userId: 9 }),
      14,
      { client: transaction }
    );
    expect(result).toMatchObject({
      success: true,
      targetChatId: 14,
      deletedCount: 1,
    });
  });

  it("rejects regeneration when a newer confirmed turn exists", async () => {
    transaction.workspace_chats.findFirst
      .mockResolvedValueOnce({ id: 12 })
      .mockResolvedValueOnce({ id: 13 });

    await expect(
      WorkspaceChatRepository.regenerateLastTurn({
        workspaceId: 7,
        threadId: 8,
        userId: 9,
        targetChatId: 12,
        sourceActionId: "regenerate-12",
      })
    ).rejects.toMatchObject({ code: "regenerate_target_not_latest" });
    expect(transaction.workspace_chats.deleteMany).not.toHaveBeenCalled();
  });

  it("permanently deletes a public chat identity", async () => {
    transaction.workspace_chats.findFirst.mockResolvedValue({
      id: 21,
      public_id: "public-21",
    });
    transaction.workspace_chats.findMany.mockResolvedValue([{ id: 21 }]);
    transaction.workspace_chats.deleteMany.mockResolvedValue({ count: 1 });

    const result = await WorkspaceChatRepository.deleteTurnPermanently({
      workspaceId: 7,
      threadId: 8,
      userId: 9,
      publicChatId: "public-21",
      sourceActionId: "delete-21",
    });

    expect(transaction.workspace_chats.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ public_id: "public-21" }),
    });
    expect(result.deletedChatIds).toEqual([21]);
  });
});
