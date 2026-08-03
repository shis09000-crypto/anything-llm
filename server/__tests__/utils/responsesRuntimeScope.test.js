const { ResponsesRuntime } = require("../../utils/responsesRuntime/runtime");

describe("managed Responses ownership and retention", () => {
  const conversation = {
    id: "ath_conv_1",
    scopeKey: "thread:7:9",
    workspaceId: 7,
    threadId: 9,
    ownerUserId: 42,
    currentHeadResponseId: "ath_resp_head",
    deletedAt: null,
  };
  const response = {
    id: "ath_resp_1",
    conversationId: conversation.id,
    ownerUserId: 42,
    store: false,
    status: "completed",
    model: "deepseek-v4-flash",
    background: false,
    usageJson: "{}",
  };

  function runtimeWithRepository(overrides = {}) {
    const repository = {
      findResponse: jest.fn().mockResolvedValue(response),
      findConversation: jest.fn().mockResolvedValue(conversation),
      expiredConversationIds: jest.fn().mockResolvedValue([]),
      ...overrides,
    };
    return { runtime: new ResponsesRuntime({ repository }), repository };
  }

  test("permits the owning thread scope", async () => {
    const { runtime } = runtimeWithRepository();
    await expect(
      runtime.retrieve(response.id, {
        workspaceId: 7,
        threadId: 9,
        userId: 42,
      })
    ).resolves.toMatchObject({ id: response.id });
  });

  test("hides responses from another user or workspace", async () => {
    const { runtime } = runtimeWithRepository();
    await expect(
      runtime.retrieve(response.id, {
        workspaceId: 7,
        threadId: 9,
        userId: 99,
      })
    ).rejects.toMatchObject({
      code: "conversation_not_found",
      httpStatus: 404,
    });
    await expect(
      runtime.retrieve(response.id, {
        workspaceId: 8,
        threadId: 9,
        userId: 42,
      })
    ).rejects.toMatchObject({
      code: "conversation_not_found",
      httpStatus: 404,
    });
  });

  test("requires a concrete scope for retrieval", async () => {
    const { runtime } = runtimeWithRepository();
    await expect(runtime.retrieve(response.id)).rejects.toMatchObject({
      code: "response_scope_required",
      httpStatus: 400,
    });
  });

  test("maintenance compacts before pruning and remains P4", async () => {
    const { runtime, repository } = runtimeWithRepository({
      expiredConversationIds: jest.fn().mockResolvedValue([conversation.id]),
      pruneExpiredConversation: jest.fn().mockResolvedValue({ pruned: 3 }),
    });
    runtime.compact = jest.fn().mockResolvedValue({ id: "ath_comp_1" });
    const result = await runtime.maintain({ limit: 10 });
    expect(runtime.compact).toHaveBeenCalledWith({
      conversationId: conversation.id,
      privileged: true,
    });
    expect(runtime.compact.mock.invocationCallOrder[0]).toBeLessThan(
      repository.pruneExpiredConversation.mock.invocationCallOrder[0]
    );
    expect(result).toMatchObject({ taskPriority: "P4", pruned: 3 });
  });

  test("maintenance never prunes when compaction fails", async () => {
    const { runtime, repository } = runtimeWithRepository({
      expiredConversationIds: jest.fn().mockResolvedValue([conversation.id]),
      pruneExpiredConversation: jest.fn(),
    });
    runtime.compact = jest.fn().mockRejectedValue(new Error("unavailable"));
    const result = await runtime.maintain();
    expect(repository.pruneExpiredConversation).not.toHaveBeenCalled();
    expect(result.pruned).toBe(0);
  });
});
