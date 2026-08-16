jest.mock("../../../utils/observability/semanticEvents", () => ({
  emitSemanticEvent: jest.fn(),
}));

const {
  reconcileExpiredAgentRuns,
} = require("../../../utils/agents/agentRunRecovery");

describe("expired Agent run recovery", () => {
  function dependencies(run, response) {
    return {
      agentRuns: {
        expiredLeases: jest.fn().mockResolvedValue([run]),
        updateState: jest.fn().mockResolvedValue({}),
        claim: jest.fn().mockResolvedValue({ claimed: true }),
      },
      closeInvocation: jest.fn().mockResolvedValue(true),
      responseStatus: jest.fn().mockResolvedValue(response),
    };
  }

  test("completes an expired run that already has a final chat", async () => {
    const deps = dependencies(
      { invocationId: "agent-1", finalChatId: 55 },
      null
    );
    const result = await reconcileExpiredAgentRuns(deps);
    expect(deps.responseStatus).not.toHaveBeenCalled();
    expect(deps.agentRuns.updateState).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ status: "completed", terminal: true }),
      expect.any(String)
    );
    expect(result.results[0].outcome).toBe("completed_from_final_chat");
  });

  test("stops a completed provider response whose chat commit was lost", async () => {
    const deps = dependencies(
      { invocationId: "agent-2", finalChatId: null },
      { status: "completed" }
    );
    const result = await reconcileExpiredAgentRuns(deps);
    expect(deps.agentRuns.updateState).toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({
        status: "stopped",
        terminal: true,
        errorCode: "agent_response_transport_lost",
      }),
      expect.any(String)
    );
    expect(deps.closeInvocation).toHaveBeenCalledWith("agent-2");
    expect(result.results[0].outcome).toBe("stopped_transport_lost");
  });

  test("recovers a lease only when Responses confirms work is active", async () => {
    const deps = dependencies(
      { invocationId: "agent-3", finalChatId: null },
      { status: "in_progress" }
    );
    const result = await reconcileExpiredAgentRuns(deps);
    expect(deps.agentRuns.claim).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: "agent-3" })
    );
    expect(deps.agentRuns.updateState).not.toHaveBeenCalled();
    expect(result.results[0].outcome).toBe("provider_running_lease_recovered");
  });

  test("does not invent a terminal state when provider status is unknown", async () => {
    const deps = dependencies(
      { invocationId: "agent-4", finalChatId: null },
      null
    );
    const result = await reconcileExpiredAgentRuns(deps);
    expect(deps.agentRuns.updateState).not.toHaveBeenCalled();
    expect(deps.agentRuns.claim).not.toHaveBeenCalled();
    expect(result.results[0].outcome).toBe("response_unconfirmed");
  });
});
