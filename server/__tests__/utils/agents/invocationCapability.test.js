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
        effectiveModel: "deepseek-v4-flash-vision-exp",
        turnMode: "normal",
        goalId: "goal-1",
        planId: "plan-1",
        planAction: "execute",
      })
    ).toEqual({
      prompt: "hello",
      workspaceId: 4,
      userId: 7,
      threadId: 11,
      clientTurnId: "turn-1",
      requestedProvider: "deepseek",
      requestedModel: "deepseek-v4-flash",
      effectiveModel: "deepseek-v4-flash-vision-exp",
      turnMode: "normal",
      goalId: "goal-1",
      planId: "plan-1",
      planAction: "execute",
    });
  });

  test("rejects an invalid owner scope before touching the repository", () => {
    expect(() =>
      normalizedSubmission({ prompt: "hello", workspaceId: null })
    ).toThrow("agent_submit_workspace_id_required");
  });

  test("rejects an unknown plan action", () => {
    expect(() =>
      normalizedSubmission({
        prompt: "hello",
        workspaceId: 4,
        planAction: "mutate_everything",
      })
    ).toThrow("agent_submit_plan_action_invalid");
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
          effectiveModel: "deepseek-v4-flash-vision-exp",
          turnMode: "normal",
          goalId: "goal-1",
          planId: "plan-1",
          planAction: "execute",
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
      effectiveModel: "deepseek-v4-flash-vision-exp",
      turnMode: "normal",
      goalId: "goal-1",
      planId: "plan-1",
      planAction: "execute",
    });
  });
});
