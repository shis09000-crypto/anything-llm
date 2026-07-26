/* eslint-env jest */

const {
  emitSemanticEvent,
  resetSemanticEventsForTests,
  semanticEvent,
  semanticEventSnapshot,
} = require("../../utils/observability/semanticEvents");
const {
  runWithOperationContext,
} = require("../../utils/observability/operationContext");

describe("Semantic Event v1", () => {
  afterEach(() => resetSemanticEventsForTests());

  test("produces a versioned, correlated, metadata-only event", () =>
    runWithOperationContext(
      {
        operationId: "op-event",
        requestId: "request-event",
        traceId: "a".repeat(32),
      },
      () => {
        const event = semanticEvent({
          eventType: "knowledge.retrieval.degraded",
          category: "knowledge",
          severity: "warning",
          outcome: "degraded",
          subject: {
            type: "knowledge",
            component: "vector_search",
            operation: "retrieve",
          },
          evidence: [{ type: "metric", metric: "rag_latency_p95" }],
          impact: { userEffect: "answer_quality_decreased" },
          metadata: { durationMs: 420 },
          prompt: "must never be serialized",
          token: "must never be serialized",
        });
        expect(event).toMatchObject({
          schema: "athena.ops.event",
          schemaVersion: "1.0",
          eventType: "knowledge.retrieval.degraded",
          outcome: "degraded",
          correlation: { operationId: "op-event", requestId: "request-event" },
        });
        expect(JSON.stringify(event)).not.toContain("must never be serialized");
        expect(event.evidence).toHaveLength(1);
      }
    ));

  test("emits a structured event without requiring an OTLP endpoint", () => {
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    try {
      emitSemanticEvent({
        eventType: "system.health.changed",
        category: "system",
        severity: "info",
        stateTransition: { from: "starting", to: "ready" },
      });
      expect(semanticEventSnapshot()).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(
        "[semantic-event:v1]",
        expect.stringContaining("system.health.changed")
      );
    } finally {
      log.mockRestore();
    }
  });
});
