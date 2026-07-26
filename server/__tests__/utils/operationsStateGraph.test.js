/* eslint-env jest */

const {
  affectedServices,
  buildStateGraph,
  explainEvent,
} = require("../../utils/operations/stateGraph");
const { serviceCatalog } = require("../../utils/operations/serviceCatalog");

describe("Operations State Graph", () => {
  const event = {
    eventId: "event-1",
    eventType: "knowledge.retrieval.degraded",
    severity: "error",
    outcome: "failed",
    occurredAt: "2026-07-22T00:00:00.000Z",
    subject: { type: "service", id: "rag", component: "rag" },
    impact: { userEffect: "answer_quality_degraded" },
    evidence: [{ type: "trace", ref: "trace:abc" }],
    hypotheses: [{ reason: "vector_database_timeout", confidence: 0.82 }],
    correlation: { operationId: "operation-1" },
  };

  test("walks reverse dependencies to calculate blast radius", () => {
    const affected = affectedServices("vector-database", serviceCatalog());
    expect(affected).toEqual(
      expect.arrayContaining([
        "vector-database",
        "rag",
        "knowledge-ingest",
        "chat-runtime",
        "agent-runtime",
      ])
    );
  });

  test("answers what happened, who was affected, and where evidence lives", () => {
    expect(explainEvent(event)).toMatchObject({
      whatHappened: {
        eventType: "knowledge.retrieval.degraded",
        severity: "error",
      },
      affectedSubjects: {
        direct: { component: "rag" },
        services: expect.arrayContaining(["rag", "chat-runtime"]),
      },
      evidence: [{ type: "trace", ref: "trace:abc" }],
    });
  });

  test("combines service, agent, event, and Sync V2 state", () => {
    const graph = buildStateGraph({
      events: [event],
      agents: [
        {
          id: "workspace-agent",
          name: "Workspace Agent",
          version: "1",
          status: "active",
          capabilities: ["tool"],
        },
      ],
      syncState: { ready: true, deadLetterOutbox: 0, pendingOutbox: 2 },
    });
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rag",
          state: {
            status: "degraded",
            severity: "error",
            lastEventAt: event.occurredAt,
            evidenceEventIds: ["event-1"],
          },
        }),
        expect.objectContaining({ id: "agent:workspace-agent" }),
        expect.objectContaining({
          id: "sync-v2",
          state: expect.objectContaining({
            status: "healthy",
            pendingOutbox: 2,
          }),
        }),
      ])
    );
  });

  test("maps provider and tool names onto stable catalog components", () => {
    expect(
      explainEvent({
        ...event,
        category: "model",
        subject: { type: "model", component: "deepseek" },
      }).affectedSubjects.services
    ).toEqual(expect.arrayContaining(["model-provider", "chat-runtime"]));
    expect(
      explainEvent({
        ...event,
        category: "agent_tool",
        subject: { type: "tool", component: "crypto-market" },
      }).affectedSubjects.services
    ).toEqual(expect.arrayContaining(["tool-runtime", "agent-runtime"]));
  });
});
