const mockGetScopedWorkspaceChat = jest.fn();
const mockChatUpdate = jest.fn();

jest.mock("../../../utils/authz/resourceAccess", () => ({
  getScopedWorkspaceChat: (...args) => mockGetScopedWorkspaceChat(...args),
}));

jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    get: jest.fn(),
    where: jest.fn(async () => []),
    new: jest.fn(),
    _update: (...args) => mockChatUpdate(...args),
  },
}));

jest.mock("../../../utils/quiz/evidence", () => ({
  retrieveQuizEvidence: jest.fn(),
}));

describe("quiz orchestrator scoped background access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses workspace, thread, and user scope before recovering background jobs", async () => {
    const { enqueueRemainingGenerationJobs } = require("../../../utils/quiz/orchestrator");
    mockGetScopedWorkspaceChat.mockResolvedValue(null);

    await expect(
      enqueueRemainingGenerationJobs({
        chatId: 44,
        workspaceId: 22,
        threadId: 9,
        userId: 10,
        reason: "scope_test",
      })
    ).resolves.toBe(false);

    expect(mockGetScopedWorkspaceChat).toHaveBeenCalledWith({
      chatId: 44,
      workspaceId: 22,
      threadId: 9,
      userId: 10,
      include: true,
    });
    expect(mockChatUpdate).not.toHaveBeenCalled();
  });
});
