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
const { validateRegistered } = require("../../utils/operations/schemaRegistry");

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

  test("keeps metadata-only tool-run provenance without tool arguments", () => {
    const event = semanticEvent({
      eventType: "agent.tool.completed",
      category: "agent_tool",
      metadata: {
        runId: "run-123",
        resultSha256: "a".repeat(64),
        stored: true,
        resultSize: 52_000,
        fullResultExceededDefaultModelLimit: true,
        continuationTask: "crypto_market_analysis",
        arguments: { symbol: "BTC" },
      },
    });
    expect(event.metadata).toEqual({
      runId: "run-123",
      resultSha256: "a".repeat(64),
      stored: "true",
      resultSize: "52000",
      fullResultExceededDefaultModelLimit: "true",
      continuationTask: "crypto_market_analysis",
    });
    expect(JSON.stringify(event)).not.toContain("symbol");
    expect(validateRegistered(event)).toEqual({ valid: true, errors: [] });
  });

  test("accepts metadata-only interpretation validation events", () => {
    const event = semanticEvent({
      eventType: "crypto.analysis.interpretation_repaired",
      category: "agent_tool",
      metadata: {
        runId: "run-456",
        resultSha256: "b".repeat(64),
        validationStatus: "repaired",
        validationErrorCount: 3,
        validationErrorCodes: "schema_mismatch,scenario_state_mismatch",
        repairStrategy: "deterministic_patch",
        modelCallCount: 1,
        durationMs: 321,
      },
    });

    expect(event.metadata).toMatchObject({
      validationStatus: "repaired",
      validationErrorCount: "3",
      validationErrorCodes: "schema_mismatch,scenario_state_mismatch",
      repairStrategy: "deterministic_patch",
      modelCallCount: "1",
      durationMs: "321",
    });
    expect(validateRegistered(event)).toEqual({ valid: true, errors: [] });
  });

  test("retains low-cardinality Responses and tool-selection timings", () => {
    const event = semanticEvent({
      eventType: "response.state.completed",
      category: "responses_runtime",
      metadata: {
        requestedProtocol: "responses",
        effectiveProtocol: "responses",
        cachedTokens: 40_192,
        cacheMissTokens: 118,
        preprocessingMs: 412,
        providerTtftMs: 3_250,
        firstVisibleDeltaMs: 3_277,
        providerProjectionMs: 12,
        persistedEventBatches: 4,
        keyCustodyWrapCalls: 9,
        selectedCount: 12,
        availableCount: 43,
      },
    });
    expect(event.metadata).toMatchObject({
      requestedProtocol: "responses",
      effectiveProtocol: "responses",
      cachedTokens: "40192",
      preprocessingMs: "412",
      providerTtftMs: "3250",
      providerProjectionMs: "12",
      selectedCount: "12",
      availableCount: "43",
    });
    expect(validateRegistered(event)).toEqual({ valid: true, errors: [] });
  });

  test("preserves zero counts and numeric cache metrics after log redaction", () => {
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    try {
      const event = emitSemanticEvent({
        eventType: "agent.tools.selected",
        category: "agent",
        metadata: {
          cachedTokens: 30_208,
          cacheMissTokens: 0,
          selectedCount: 0,
          availableCount: 43,
        },
      });
      expect(event.metadata).toMatchObject({
        cachedTokens: "30208",
        cacheMissTokens: "0",
        selectedCount: "0",
        availableCount: "43",
      });
    } finally {
      log.mockRestore();
    }
  });
});
