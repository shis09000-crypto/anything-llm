const {
  sanitizeAgentProgress,
} = require("../../../utils/agents/agentProgress");
const {
  compactAgentEvents,
  sanitizeAgentEvent,
} = require("../../../utils/agents/toolResultStore");

describe("Agent progress events", () => {
  it("keeps only audited phase metadata", () => {
    expect(
      sanitizeAgentProgress({
        phase: "retrieval",
        status: "completed",
        sequence: 4,
        details: {
          toolName: "rag-memory",
          toolCategory: "rag",
          evidenceCount: 5,
          prompt: "must not be exposed",
          evidenceText: "must not be exposed",
        },
      })
    ).toEqual({
      type: "agentProgress",
      uuid: "agent_progress:retrieval:4",
      phase: "retrieval",
      status: "completed",
      sequence: 4,
      details: {
        toolName: "rag-memory",
        toolCategory: "rag",
        evidenceCount: 5,
      },
    });
  });

  it("rejects unknown phases and statuses", () => {
    expect(
      sanitizeAgentProgress({
        phase: "hidden_reasoning",
        status: "running",
      })
    ).toBeNull();
    expect(
      sanitizeAgentProgress({ phase: "routing", status: "unknown" })
    ).toBeNull();
  });

  it("persists progress without prompt or evidence bodies", () => {
    const persisted = sanitizeAgentEvent({
      type: "agent_progress",
      uuid: "progress-1",
      phase: "evidence_ready",
      status: "completed",
      sequence: 6,
      details: {
        evidenceCount: 5,
        toolName: "rag-memory",
        prompt: "must not be persisted",
        evidenceText: "must not be persisted",
      },
      content: "should not be needed",
    });
    expect(persisted).toEqual(
      expect.objectContaining({
        type: "agent_progress",
        phase: "evidence_ready",
        sequence: 6,
        details: { evidenceCount: 5, toolName: "rag-memory" },
      })
    );
    expect(persisted.content).toBeUndefined();
    expect(compactAgentEvents([persisted, persisted])).toHaveLength(1);
  });
});
