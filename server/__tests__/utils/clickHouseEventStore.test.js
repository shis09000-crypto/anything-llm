/* eslint-env jest */

const {
  ClickHouseEventStore,
  clickHouseDateTime64,
  eventRow,
} = require("../../utils/operations/clickHouseEventStore");
const { semanticEvent } = require("../../utils/observability/semanticEvents");

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

  test("writes a confirmed JSONEachRow batch with async insert settings", async () => {
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = jest.fn(async (url, options) => {
      requests.push({ url: new URL(url), options });
      return { ok: true, text: async () => "" };
    });
    try {
      const store = new ClickHouseEventStore({
        ATHENA_CLICKHOUSE_URL: "http://clickhouse:8123",
        ATHENA_CLICKHOUSE_DATABASE: "athena_operations",
        ATHENA_CLICKHOUSE_ASYNC_INSERT_BUSY_TIMEOUT_MS: "250",
      });
      const events = [
        semanticEvent({ eventType: "login.started" }),
        semanticEvent({ eventType: "login.completed" }),
      ];
      await store.insertBatch(events);

      expect(requests).toHaveLength(1);
      expect(requests[0].url.searchParams.get("async_insert")).toBe("1");
      expect(requests[0].url.searchParams.get("wait_for_async_insert")).toBe(
        "1"
      );
      expect(
        requests[0].url.searchParams.get("async_insert_busy_timeout_ms")
      ).toBe("250");
      expect(requests[0].options.body.split("\n").filter(Boolean)).toHaveLength(
        2
      );
      expect(store.health()).toMatchObject({
        inserted: 2,
        consecutiveFailures: 0,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
