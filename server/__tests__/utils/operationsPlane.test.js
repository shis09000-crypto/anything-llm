/* eslint-env jest */

const { OperationsPlane } = require("../../utils/operations/operationsPlane");
const { semanticEvent } = require("../../utils/observability/semanticEvents");
const {
  AicpShadowObserver,
} = require("../../utils/modulePlatform/aicp/shadowObserver");

describe("AI Operations Plane", () => {
  function fixture() {
    let sink = null;
    const store = {
      ensureSchema: jest.fn().mockResolvedValue(true),
      insert: jest.fn().mockResolvedValue(true),
      timeline: jest.fn().mockResolvedValue([]),
      health: jest.fn(() => ({ configured: true, ready: true })),
    };
    const transport = {
      start: jest.fn(async (handler) => {
        transport.handler = handler;
        transport.ready = true;
      }),
      publish: jest.fn().mockResolvedValue({ accepted: true }),
      consumerState: jest.fn().mockResolvedValue({
        streamLastSeq: 10,
        ackFloorStreamSeq: 10,
        lag: 0,
        redeliveries: 0,
      }),
      drain: jest.fn().mockResolvedValue(true),
      health: jest.fn(() => ({ ready: Boolean(transport.ready) })),
    };
    const aicpObserver = new AicpShadowObserver({ env: {} });
    const plane = new OperationsPlane({
      env: {
        NODE_ENV: "development",
        ATHENA_OPERATIONS_ENABLED: "true",
        ATHENA_NATS_SERVERS: "nats://127.0.0.1:4222",
        ATHENA_CLICKHOUSE_URL: "http://127.0.0.1:8123",
      },
      store,
      transport,
      registerSink: (handler) => {
        sink = handler;
        return () => {
          sink = null;
        };
      },
      aicpObserver,
    });
    return { aicpObserver, getSink: () => sink, plane, store, transport };
  }

  test("validates then publishes events through the durable transport", async () => {
    const { aicpObserver, getSink, plane, store, transport } = fixture();
    await plane.start();
    const event = semanticEvent({ eventType: "login.completed" });
    await getSink()(event);
    expect(store.ensureSchema).toHaveBeenCalledTimes(1);
    expect(transport.publish).toHaveBeenCalledWith(event);
    await transport.handler(event);
    expect(store.insert).toHaveBeenCalledWith(event);
    expect(plane.health().producerCoverage).toMatchObject({
      observed: 1,
      stale: 0,
      producers: [
        expect.objectContaining({
          runtimeRole: event.producer.runtimeRole,
          service: event.producer.service,
          stale: false,
        }),
      ],
    });
    expect(aicpObserver.health()).toMatchObject({
      semanticEvents: 1,
      duplicateEvents: 1,
      mappedEvents: 1,
    });
    await plane.stop();
  });

  test("falls back to bounded NATS evidence with explicit degradation", async () => {
    const { plane, store, transport } = fixture();
    const event = semanticEvent({
      eventType: "login.completed",
      correlation: { operationId: "operation-fallback" },
    });
    store.timeline.mockRejectedValue(new Error("clickhouse unavailable"));
    store.health.mockReturnValue({
      configured: true,
      ready: false,
      persistedThrough: "2026-07-24T00:00:00.000Z",
    });
    transport.recentEvents = jest.fn().mockResolvedValue({
      events: [event],
      scanned: 500,
      completeness: "partial",
      streamFirstSeq: 1,
      streamLastSeq: 900,
    });

    const result = await plane.timelineWithMetadata({
      operationId: "operation-fallback",
      limit: 100,
    });

    expect(result).toMatchObject({
      events: [event],
      source: "nats",
      sources: ["nats", "recent-buffer"],
      degraded: true,
      completeness: "partial",
      streamLastSeq: 900,
    });
    expect(transport.recentEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, scanLimit: 1_000 })
    );
  });

  test("exposes the consumer redelivery count under the public contract name", async () => {
    const { plane, store, transport } = fixture();
    transport.consumerState.mockResolvedValueOnce({
      streamLastSeq: 12,
      ackFloorStreamSeq: 11,
      lag: 1,
      redelivered: 7,
    });
    store.latestPersistedAt = jest
      .fn()
      .mockResolvedValue("2026-07-25T12:00:00.000Z");

    await expect(
      plane.timelineWithMetadata({ limit: 5 })
    ).resolves.toMatchObject({
      source: "clickhouse",
      redelivered: 7,
      redeliveries: 7,
    });
  });

  test("clears a recovered error only after both durable stores are healthy", async () => {
    const { plane, store, transport } = fixture();
    plane.lastError = "20";
    plane.status = "degraded";

    store.health.mockReturnValue({ configured: true, ready: false });
    await plane.flushRetryQueue();
    expect(plane.lastError).toBe("20");
    expect(plane.status).toBe("degraded");

    store.health.mockReturnValue({ configured: true, ready: true });
    transport.ready = true;
    await plane.flushRetryQueue();
    expect(plane.lastError).toBeNull();
    expect(plane.status).toBe("running");
  });

  test("rejects unknown schemas before transport or storage", async () => {
    const { plane, store, transport } = fixture();
    await plane.start();
    await expect(
      plane.consume({ schema: "unknown", schemaVersion: "1" })
    ).rejects.toMatchObject({ code: "SEMANTIC_EVENT_SCHEMA_REJECTED" });
    expect(store.insert).not.toHaveBeenCalled();
    expect(transport.publish).not.toHaveBeenCalled();
    await plane.stop();
  });

  test("accepts module lifecycle metadata emitted by micro-module hosts", () => {
    const { semanticEvent } = require("../../utils/observability/semanticEvents");
    const { validateRegistered } = require("../../utils/operations/schemaRegistry");
    const event = semanticEvent({
      eventType: "module.lifecycle.heartbeat",
      category: "module_lifecycle",
      metadata: {
        moduleId: "browser-plane",
        runtimeRole: "browser-plane",
        version: "1.0.0",
        manifestFingerprint: "abc123",
        instanceId: "instance-1",
        sequence: "2",
        ready: "true",
        heartbeatAt: "2026-08-02T18:00:00.000Z",
        leaseExpiresAt: "2026-08-02T18:01:30.000Z",
        center: "task",
        priority: "P3",
        escalationLevel: "none",
      },
    });

    expect(validateRegistered(event)).toEqual({ valid: true, errors: [] });
  });

  test("re-establishes the durable consumer after a transient startup failure", async () => {
    jest.useFakeTimers();
    const { plane, transport } = fixture();
    transport.start
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "TIMEOUT" }))
      .mockImplementationOnce(async (handler) => {
        transport.handler = handler;
        transport.ready = true;
      });

    await plane.start();
    expect(plane.health()).toMatchObject({ status: "degraded", ready: false });

    await jest.advanceTimersByTimeAsync(5_000);

    expect(transport.start).toHaveBeenCalledTimes(2);
    expect(plane.health()).toMatchObject({ status: "running", ready: true });
    await plane.stop();
    jest.useRealTimers();
  });

  test("keeps the expected module contract stable across health reads", () => {
    const { plane } = fixture();
    const expected = plane.health().moduleHeartbeatCoverage.expected;

    expect(expected).toBeGreaterThan(0);
    expect(plane.health().moduleHeartbeatCoverage.expected).toBe(expected);
    expect(Object.isFrozen(plane.expectedModuleIds)).toBe(true);
  });
});
