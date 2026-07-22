/* eslint-env jest */

const {
  clickHouseDateTime64,
  eventRow,
} = require("../../utils/operations/clickHouseEventStore");

describe("ClickHouse semantic event projection", () => {
  test("stores correlation and evidence metadata without user/model content", () => {
    const row = eventRow({
      schema: "athena.ops.event",
      schemaVersion: "1.0",
      eventId: "event-1",
      eventType: "agent.tool.completed",
      category: "agent",
      severity: "info",
      outcome: "succeeded",
      occurredAt: "2026-07-22T00:00:00.000Z",
      observedAt: "2026-07-22T00:00:00.100Z",
      producer: { service: "server", version: "1", runtimeRole: "api" },
      subject: { type: "tool", id: "market-data", component: "tool-runtime" },
      correlation: { operationId: "op-1", invocationId: "agent-1" },
      evidence: [{ type: "trace", ref: "trace:1" }],
      sensitivity: "metadata_only",
      retentionClass: "operations_180d",
      prompt: "must not persist",
      text: "must not persist",
      token: "must not persist",
    });
    expect(row).toMatchObject({
      event_id: "event-1",
      occurred_at: "2026-07-22 00:00:00.000",
      observed_at: "2026-07-22 00:00:00.100",
      operation_id: "op-1",
      invocation_id: "agent-1",
      subject_component: "tool-runtime",
    });
    expect(JSON.stringify(row)).not.toContain("must not persist");
  });

  test("rejects invalid timestamps before sending a ClickHouse row", () => {
    expect(() => clickHouseDateTime64("not-a-date")).toThrow(
      "clickhouse_invalid_event_timestamp"
    );
  });
});
