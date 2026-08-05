/* eslint-env jest */

const {
  remoteWorkspaceCognitionEnabled,
  serializableFinalizedTurn,
  syncFinalizedWorkspaceTurn,
} = require("../../utils/workspaceCognition/turnSync");

describe("workspace cognition finalized turn boundary", () => {
  const chat = {
    id: 42,
    workspaceId: 7,
    thread_id: 11,
    user_id: 3,
    api_session_id: null,
    include: true,
    prompt: "hello",
    response: { type: "chat", textResponse: "world" },
    sources: [{ id: "source-1" }],
    created_from: "agent",
    unrelatedSecret: "must-not-cross-boundary",
  };

  test("only chat-runtime delegates workspace-owned cognition writes", () => {
    expect(
      remoteWorkspaceCognitionEnabled({ ATHENA_RUNTIME_ROLE: "chat-runtime" })
    ).toBe(true);
    expect(
      remoteWorkspaceCognitionEnabled({ ATHENA_RUNTIME_ROLE: "api" })
    ).toBe(false);
  });

  test("projects only fields required by the cognition owner", () => {
    expect(serializableFinalizedTurn(chat)).toEqual({
      id: 42,
      workspaceId: 7,
      thread_id: 11,
      user_id: 3,
      api_session_id: null,
      include: true,
      prompt: "hello",
      response: { type: "chat", textResponse: "world" },
      sources: [{ id: "source-1" }],
      created_from: "agent",
      lastUpdatedAt: null,
    });
  });

  test("delegates the write through the declared AICP capability", async () => {
    const request = jest.fn().mockResolvedValue({
      success: true,
      enqueued: true,
    });
    const result = await syncFinalizedWorkspaceTurn({
      chat,
      sourceChannel: "agent",
      replaceEvidence: true,
      env: {
        ATHENA_RUNTIME_ROLE: "chat-runtime",
        ATHENA_API_INTERNAL_URL: "https://api.internal:3024/",
      },
      request,
    });

    expect(result).toEqual({ success: true, enqueued: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "chat-runtime",
        targetModule: "athena-api",
        capability: "workspace.cognition.turn.sync",
        contractVersion: "1.0",
        url: "https://api.internal:3024/internal/v1/workspace/cognition/turn/sync",
        body: expect.objectContaining({
          sourceChannel: "agent",
          replaceEvidence: true,
          chat: expect.not.objectContaining({ unrelatedSecret: expect.anything() }),
        }),
      })
    );
  });
});
