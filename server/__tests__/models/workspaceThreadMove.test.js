const mockEnsureCompactionTable = jest.fn();
const mockEnsureMindMapTable = jest.fn();
const mockEnsureQuizTables = jest.fn();
const mockTransaction = jest.fn();

const tx = {
  workspace_threads: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  workspace_chats: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  workspace_parsed_files: {
    updateMany: jest.fn(),
  },
  workspace_agent_invocations: {
    updateMany: jest.fn(),
  },
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.mock("../../utils/prisma", () => ({
  $transaction: (...args) => mockTransaction(...args),
}));

jest.mock("../../models/workspaceChatCompaction", () => ({
  WorkspaceChatCompaction: {
    ensureTable: (...args) => mockEnsureCompactionTable(...args),
  },
}));

jest.mock("../../models/workspaceMindMaps", () => ({
  WorkspaceMindMaps: {
    ensureTable: (...args) => mockEnsureMindMapTable(...args),
  },
}));

jest.mock("../../utils/quiz/learningRecords", () => ({
  ensureQuizLearningTables: (...args) => mockEnsureQuizTables(...args),
}));

describe("WorkspaceThread.moveToWorkspace", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureCompactionTable.mockResolvedValue();
    mockEnsureMindMapTable.mockResolvedValue();
    mockEnsureQuizTables.mockResolvedValue();
    mockTransaction.mockImplementation((callback) => callback(tx));
    tx.workspace_threads.findFirst.mockResolvedValue({
      id: 7,
      name: "Movable",
      slug: "thread-slug",
      workspace_id: 1,
      user_id: 2,
      thread_type: "chat",
    });
    tx.workspace_threads.update.mockResolvedValue({
      id: 7,
      name: "Movable",
      slug: "thread-slug",
      workspace_id: 2,
      user_id: 2,
      thread_type: "chat",
    });
    tx.workspace_chats.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    tx.workspace_chats.updateMany.mockResolvedValue({ count: 2 });
    tx.workspace_parsed_files.updateMany.mockResolvedValue({ count: 1 });
    tx.workspace_agent_invocations.updateMany.mockResolvedValue({ count: 1 });
    tx.$queryRawUnsafe.mockResolvedValue([{ id: 90 }]);
    tx.$executeRawUnsafe.mockResolvedValue({ count: 1 });
  });

  it("moves a thread and its workspace-scoped attached records in one transaction", async () => {
    const { WorkspaceThread } = require("../../models/workspaceThread");

    const result = await WorkspaceThread.moveToWorkspace({
      thread: { id: 7, slug: "thread-slug", user_id: 2 },
      sourceWorkspace: { id: 1, slug: "source" },
      targetWorkspace: { id: 2, slug: "target" },
    });

    expect(mockEnsureCompactionTable).toHaveBeenCalled();
    expect(mockEnsureMindMapTable).toHaveBeenCalled();
    expect(mockEnsureQuizTables).toHaveBeenCalled();
    expect(mockTransaction).toHaveBeenCalled();
    expect(tx.workspace_threads.findFirst).toHaveBeenCalledWith({
      where: { id: 7, workspace_id: 1, user_id: 2 },
    });
    expect(tx.workspace_threads.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({ workspace_id: 2 }),
    });
    expect(tx.workspace_chats.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 1, thread_id: 7 },
      data: expect.objectContaining({ workspaceId: 2 }),
    });
    expect(tx.workspace_parsed_files.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 1, threadId: 7 },
      data: { workspaceId: 2 },
    });
    expect(tx.workspace_agent_invocations.updateMany).toHaveBeenCalledWith({
      where: { workspace_id: 1, thread_id: 7 },
      data: expect.objectContaining({ workspace_id: 2 }),
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"workspace_quiz_attempts"'),
      1,
      10,
      11
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"workspace_chat_compactions"'),
      2,
      1,
      7
    );
    expect(result).toEqual(
      expect.objectContaining({
        message: null,
        movedChatCount: 2,
        thread: expect.objectContaining({
          slug: "thread-slug",
          workspace_id: 2,
        }),
      })
    );
  });

  it("rejects overview threads before opening a transaction", async () => {
    const { WorkspaceThread } = require("../../models/workspaceThread");

    const result = await WorkspaceThread.moveToWorkspace({
      thread: {
        id: 7,
        slug: "overview",
        workspace_id: 1,
        user_id: 2,
        thread_type: "overview",
      },
      sourceWorkspace: { id: 1, slug: "source" },
      targetWorkspace: { id: 2, slug: "target" },
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(result.message).toBe("Overview thread cannot be moved.");
  });

  it("rejects moving to the same workspace before opening a transaction", async () => {
    const { WorkspaceThread } = require("../../models/workspaceThread");

    const result = await WorkspaceThread.moveToWorkspace({
      thread: { id: 7, slug: "thread-slug", workspace_id: 1, user_id: 2 },
      sourceWorkspace: { id: 1, slug: "source" },
      targetWorkspace: { id: 1, slug: "source" },
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(result.message).toBe("Thread is already in the target workspace.");
  });
});
