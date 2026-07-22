/* eslint-env jest */

const { OperationsPlane } = require("../../utils/operations/operationsPlane");
const { semanticEvent } = require("../../utils/observability/semanticEvents");

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
      drain: jest.fn().mockResolvedValue(true),
      health: jest.fn(() => ({ ready: Boolean(transport.ready) })),
    };
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
    });
    return { getSink: () => sink, plane, store, transport };
  }

  test("validates then publishes events through the durable transport", async () => {
    const { getSink, plane, store, transport } = fixture();
    await plane.start();
    const event = semanticEvent({ eventType: "login.completed" });
    await getSink()(event);
    expect(store.ensureSchema).toHaveBeenCalledTimes(1);
    expect(transport.publish).toHaveBeenCalledWith(event);
    await transport.handler(event);
    expect(store.insert).toHaveBeenCalledWith(event);
    await plane.stop();
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
});
