const {
  normalizedSubmission,
  submitAgentInvocation,
} = require("../../../utils/agents/invocationCapability");

describe("Agent invocation capability", () => {
  test("normalizes the bounded internal submission contract", () => {
    expect(
      normalizedSubmission({
        prompt: "  hello  ",
        workspaceId: 4,
        userId: 7,
        threadId: 11,
        clientTurnId: "turn-1",
        requestedProvider: "deepseek",
        requestedModel: "deepseek-v4-flash",
      })
    ).toEqual({
      prompt: "hello",
      workspaceId: 4,
      userId: 7,
      threadId: 11,
      clientTurnId: "turn-1",
      requestedProvider: "deepseek",
      requestedModel: "deepseek-v4-flash",
    });
  });

  test("rejects an invalid owner scope before touching the repository", () => {
    expect(() =>
      normalizedSubmission({ prompt: "hello", workspaceId: null })
    ).toThrow("agent_submit_workspace_id_required");
  });

  test("persists through the Agent-owned repository and returns a minimal result", async () => {
    const workspaceAgentInvocation = {
      new: jest.fn().mockResolvedValue({
        invocation: { uuid: "invocation-1", clientTurnId: "turn-1" },
        replayed: false,
      }),
    };
    await expect(
      submitAgentInvocation(
        {
          prompt: "hello",
          workspaceId: 4,
          userId: 7,
          threadId: 11,
          clientTurnId: "turn-1",
          requestedProvider: "deepseek",
          requestedModel: "deepseek-v4-flash",
        },
        { workspaceAgentInvocation }
      )
    ).resolves.toEqual({
      invocation: { uuid: "invocation-1", clientTurnId: "turn-1" },
      replayed: false,
    });
    expect(workspaceAgentInvocation.new).toHaveBeenCalledWith({
      prompt: "hello",
      workspace: { id: 4 },
      user: { id: 7 },
      thread: { id: 11 },
      clientTurnId: "turn-1",
      requestedProvider: "deepseek",
      requestedModel: "deepseek-v4-flash",
    });
  });

  test("rejects an oversized model snapshot", () => {
    expect(() =>
      normalizedSubmission({
        prompt: "hello",
        workspaceId: 4,
        requestedProvider: "deepseek",
        requestedModel: "x".repeat(161),
      })
    ).toThrow("agent_submit_requested_model_invalid");
  });
});
