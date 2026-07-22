/* eslint-env jest */

const {
  OperationsShadowRuntime,
  normalizeCounterMetrics,
  shadowFindingEvent,
} = require("../../utils/operations/shadowAgents/runtime");

const incidentEvent = {
  eventId: "event-database-timeout",
  eventType: "database.query.timed_out",
  category: "database",
  severity: "error",
  outcome: "timeout",
  occurredAt: "2026-07-22T00:00:00.000Z",
  subject: {
    type: "service",
    id: "main-database",
    component: "main-database",
  },
  impact: { userEffect: "chat_unavailable" },
  evidence: [{ type: "trace", ref: "trace:database-timeout" }],
  correlation: { traceId: "database-timeout" },
};

describe("Operations Shadow Runtime", () => {
  test("reads evidence, emits advisory findings once, and exposes no action path", async () => {
    const emitted = [];
    const runtime = new OperationsShadowRuntime({
      env: {
        ATHENA_OPERATIONS_SHADOW_AGENTS_ENABLED: "true",
        ATHENA_OPERATIONS_SHADOW_INTERVAL_MS: "3600000",
      },
      plane: { timeline: jest.fn().mockResolvedValue([incidentEvent]) },
      metricsRegistry: { getMetricsAsJSON: jest.fn().mockResolvedValue([]) },
      emit: (event) => emitted.push(event),
    });

    await runtime.start();
    await runtime.scan();
    await runtime.stop();

    const snapshot = runtime.snapshot();
    expect(snapshot.mode).toBe("shadow");
    expect(snapshot.actionPolicy).toBe("observe_only");
    expect(snapshot.canExecuteActions).toBe(false);
    expect(snapshot.findings.length).toBeGreaterThan(0);
    expect(new Set(emitted.map((event) => event.eventId)).size).toBe(
      emitted.length
    );
    expect(
      emitted.every(
        (event) =>
          event.category === "operations_shadow" &&
          event.sensitivity === "metadata_only" &&
          event.recommendation.permission === "human_review"
      )
    ).toBe(true);
    expect(runtime.execute).toBeUndefined();
    expect(runtime.remediate).toBeUndefined();
  });

  test("uses counter deltas so startup totals do not create cost findings", () => {
    const families = [
      {
        name: "athena_ai_cost_micros_total",
        values: [{ labels: { provider: "test" }, value: 30_000_000 }],
      },
    ];
    const config = {
      costThresholdMicros: 25_000_000,
      tokenThreshold: 5_000_000,
    };
    const first = normalizeCounterMetrics(families, new Map(), config);
    const second = normalizeCounterMetrics(
      [
        {
          name: "athena_ai_cost_micros_total",
          values: [{ labels: { provider: "test" }, value: 60_000_001 }],
        },
      ],
      first.next,
      config
    );

    expect(first.observations).toHaveLength(0);
    expect(second.observations[0].delta).toBe(30_000_001);
  });

  test("converts findings to strict metadata-only Semantic Event v1 input", () => {
    const event = shadowFindingEvent({
      findingId: "finding-1",
      agentId: "ops-rca-agent",
      kind: "root_cause_hypothesis",
      severity: "error",
      occurredAt: "2026-07-22T00:00:00.000Z",
      subject: {
        type: "service",
        id: "main-database",
        component: "main-database",
      },
      evidenceRefs: ["trace:database-timeout"],
      hypotheses: [],
      impact: { userEffect: "chat_unavailable" },
      advisory: { actionId: "investigate:main-database" },
    });

    expect(event.sensitivity).toBe("metadata_only");
    expect(event.recommendation).toEqual({
      actionId: "investigate:main-database",
      risk: "none",
      permission: "human_review",
    });
    expect(JSON.stringify(event)).not.toMatch(/token|prompt|requestBody/i);
  });
});
