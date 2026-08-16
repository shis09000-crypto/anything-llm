/* eslint-env jest */

const mockWorkspaceChat = {
  new: jest.fn(),
  upsert: jest.fn(),
};
const mockWorkspace = { get: jest.fn() };
const mockWorkspaceThread = { get: jest.fn() };
const mockPublishWorkspaceSyncEvent = jest.fn();
const mockMaybeEnqueueTitleGenerationAfterChat = jest.fn();

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    workspaceChat: mockWorkspaceChat,
    workspace: mockWorkspace,
    workspaceThread: mockWorkspaceThread,
  },
}));
jest.mock("../../utils/chats/workspaceSyncEvents", () => ({
  publishWorkspaceSyncEvent: mockPublishWorkspaceSyncEvent,
}));
jest.mock("../../utils/chats/threadTitleGeneration", () => ({
  maybeEnqueueTitleGenerationAfterChat:
    mockMaybeEnqueueTitleGenerationAfterChat,
}));

const {
  finalizeAgentTurn,
  reserveAgentTurn,
} = require("../../utils/chats/agentTurnPersistenceRuntime");

describe("agentTurnPersistenceRuntime", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkspaceChat.new.mockResolvedValue({
      chat: { id: 17, public_id: "public-17" },
      message: null,
    });
    mockWorkspaceChat.upsert.mockResolvedValue({
      chat: { id: 17, public_id: "public-17" },
      message: null,
    });
    mockWorkspace.get.mockResolvedValue({ id: 2, slug: "workspace" });
    mockWorkspaceThread.get.mockResolvedValue({ id: 3, slug: "thread" });
  });

  test("reserves the active Agent turn only in process memory", async () => {
    const result = await reserveAgentTurn({
      workspaceId: 2,
      threadId: 3,
      userId: 4,
      prompt: "hello",
      clientTurnId: "turn-1",
    });

    expect(result).toMatchObject({ publicId: null });
    expect(result.id).toMatch(/^ath_agent_turn_/);
    expect(result.reservationId).toBe(result.id);
    expect(mockWorkspaceChat.new).not.toHaveBeenCalled();
  });

  test("writes a memory-reserved Agent turn once after completion", async () => {
    const reservation = await reserveAgentTurn({
      workspaceId: 2,
      threadId: 3,
      userId: 4,
      prompt: "hello",
      clientTurnId: "turn-memory",
    });

    await expect(
      finalizeAgentTurn({
        chatId: reservation.id,
        reservationId: reservation.id,
        workspaceId: 2,
        threadId: 3,
        userId: 4,
        prompt: "hello",
        response: { text: "world", metrics: { model: "flash" } },
        clientTurnId: "turn-memory",
      })
    ).resolves.toMatchObject({ id: 17, publicId: "public-17" });

    expect(mockWorkspaceChat.new).toHaveBeenCalledTimes(1);
    expect(mockWorkspaceChat.upsert).not.toHaveBeenCalled();
  });

  test("finalizes, publishes sync, and queues title work as Chat owner", async () => {
    await expect(
      finalizeAgentTurn({
        chatId: 17,
        workspaceId: 2,
        threadId: 3,
        userId: 4,
        prompt: "hello",
        response: { text: "world", metrics: { model: "flash" } },
        clientTurnId: "turn-1",
      })
    ).resolves.toEqual({
      id: 17,
      publicId: "public-17",
      renamedThread: null,
    });

    expect(mockWorkspaceChat.upsert).toHaveBeenCalledWith(
      17,
      expect.objectContaining({
        workspaceId: 2,
        response: expect.objectContaining({ text: "world" }),
        sourceChannel: "agent",
      })
    );
    expect(mockPublishWorkspaceSyncEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat_finalized",
        chatId: 17,
        publicChatId: "public-17",
      })
    );
    expect(mockMaybeEnqueueTitleGenerationAfterChat).toHaveBeenCalled();
  });

  test("does not let an Agent process-local rename hint suppress Chat-owned title work", async () => {
    await finalizeAgentTurn({
      chatId: 17,
      workspaceId: 2,
      threadId: 3,
      userId: 4,
      prompt: "hello",
      response: { text: "world" },
      clientTurnId: "turn-recovered",
      renameThread: false,
    });

    expect(mockMaybeEnqueueTitleGenerationAfterChat).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 2,
        threadId: 3,
        userId: 4,
      })
    );
  });
});
