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
      findResponseByIdempotencyKey: jest.fn().mockResolvedValue(null),
      createResponse: jest.fn().mockResolvedValue(null),
      updateResponse: jest.fn().mockResolvedValue(null),
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

  test("retries an empty failed native search stream before degrading", async () => {
    let attempt = 0;
    const modelClient = {
      stream: jest.fn(async (request) => request),
      events: jest.fn(async function* (request) {
        attempt += 1;
        if (attempt < 3) {
          yield {
            type: "response.created",
            response: { id: `provider-response-${attempt}` },
          };
          yield { type: "response.in_progress" };
          const error = new Error("responses_stream_failed");
          error.code = "responses_stream_failed";
          throw error;
        }
        expect(request.tools).not.toContainEqual({ type: "web_search" });
        expect(request.toolChoice).toBe("none");
        yield { type: "response.output_text.delta", delta: "fallback" };
        yield {
          type: "response.completed",
          response: {
            model: "deepseek-v4-flash",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      }),
    };
    const repository = {
      findResponseByIdempotencyKey: jest.fn().mockResolvedValue(null),
      createResponse: jest.fn().mockResolvedValue(null),
      updateResponse: jest.fn().mockResolvedValue(null),
    };
    const runtime = new ResponsesRuntime({ repository, modelClient });
    const events = [];
    for await (const event of runtime.stream({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      input: [{ role: "user", content: "latest news" }],
      store: false,
      tools: [],
      athena: { agentRunId: "retry-test" },
    }))
      events.push(event);

    expect(modelClient.stream).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        output_text: "fallback",
        athena: {
          degradedReason: "native_web_search_temporarily_unavailable",
        },
      },
    });
  });
});
