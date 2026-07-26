const {
  OperationsBatchProcessor,
  deliverySubject,
  subjectForSemanticEvent,
} = require("../../utils/operations/jetStreamTransport");
const { JSONCodec } = require("nats");
const { semanticEvent } = require("../../utils/observability/semanticEvents");

const codec = JSONCodec();

function config() {
  return {
    batch: {
      maxMessages: 256,
      maxBytes: 1024 * 1024,
      maxWaitMs: 1_000,
      workingIntervalMs: 20_000,
    },
    circuitBreaker: {
      baseDelayMs: 5_000,
      maxDelayMs: 120_000,
      jitterRatio: 0,
    },
  };
}

function message(event, sequence = 1) {
  const result = {
    data: codec.encode(event),
    seq: sequence,
    subject: "athena.test.operations.semantic.v1.system",
    info: {
      stream: "ATHENA_OPERATIONS",
      consumer: "athena-operations-clickhouse",
      streamSequence: sequence,
      deliveryCount: 1,
    },
    ack: jest.fn(() => {
      result.didAck = true;
    }),
    nak: jest.fn(),
    working: jest.fn(),
  };
  return result;
}

describe("operations JetStream transport", () => {
  test("uses a stable delivery subject for a durable queue consumer", () => {
    expect(deliverySubject("athena-ops-live-acceptance")).toBe(
      "_INBOX.ATHENA.OPERATIONS.athena-ops-live-acceptance"
    );
    expect(deliverySubject("unsafe.consumer/value")).toBe(
      "_INBOX.ATHENA.OPERATIONS.unsafe-consumer-value"
    );
  });

  test("keeps semantic event subjects scoped by environment and category", () => {
    expect(
      subjectForSemanticEvent(
        { category: "agent_tool" },
        {
          ATHENA_NATS_SERVERS: "nats://127.0.0.1:4222",
          ATHENA_OPERATIONS_NATS_SUBJECT: "operations.semantic.v1",
        }
      )
    ).toBe("athena.development.operations.semantic.v1.agent_tool");
  });

  test("persists and acknowledges a full 256-message batch once", async () => {
    const persist = jest.fn().mockResolvedValue(true);
    const processor = new OperationsBatchProcessor({
      config: config(),
      persist,
      publishDlq: jest.fn(),
      random: () => 0,
    });
    const messages = Array.from({ length: 256 }, (_unused, index) =>
      message(
        semanticEvent({
          eventType: "http.request.completed",
          correlation: { requestId: `request-${index}` },
        }),
        index + 1
      )
    );
    messages.forEach((entry) => processor.enqueue(entry));
    await processor.flush();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toHaveLength(256);
    expect(messages.every((entry) => entry.ack.mock.calls.length === 1)).toBe(
      true
    );
    processor.close();
  });

  test("holds leases without NAK storms until ClickHouse recovers", async () => {
    let now = 1_000;
    const persist = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("memory"), { code: 241 }))
      .mockRejectedValueOnce(
        Object.assign(new Error("too many parts"), { code: 252 })
      )
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(true);
    const processor = new OperationsBatchProcessor({
      config: config(),
      persist,
      publishDlq: jest.fn(),
      now: () => now,
      random: () => 0,
    });
    const entry = message(semanticEvent({ eventType: "login.completed" }));
    processor.enqueue(entry);

    for (const delay of [5_000, 10_000, 20_000]) {
      await processor.flush();
      processor.extendLeases();
      expect(entry.nak).not.toHaveBeenCalled();
      expect(entry.ack).not.toHaveBeenCalled();
      if (processor.flushTimer) clearTimeout(processor.flushTimer);
      processor.flushTimer = null;
      now += delay;
    }
    await processor.flush();

    expect(persist).toHaveBeenCalledTimes(4);
    expect(entry.working).toHaveBeenCalledTimes(3);
    expect(entry.ack).toHaveBeenCalledTimes(1);
    expect(processor.health().circuitState).toBe("closed");
    processor.close();
  });

  test("acks a permanently invalid message only after DLQ persistence", async () => {
    const publishDlq = jest.fn().mockResolvedValue(true);
    const persist = jest.fn();
    const processor = new OperationsBatchProcessor({
      config: config(),
      persist,
      publishDlq,
      random: () => 0,
    });
    const entry = message({ invalid: true });
    processor.enqueue(entry);
    await processor.flush();

    expect(publishDlq).toHaveBeenCalledTimes(1);
    expect(publishDlq.mock.calls[0][0]).toMatchObject({
      reason: "schema_validation_failed",
      sourceStreamSequence: 1,
    });
    expect(publishDlq.mock.calls[0][0]).not.toHaveProperty("payload");
    expect(entry.ack).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    processor.close();
  });

  test("keeps invalid and failed batches unacknowledged for restart recovery", async () => {
    const dlqFailure = new OperationsBatchProcessor({
      config: config(),
      persist: jest.fn(),
      publishDlq: jest.fn().mockRejectedValue(new Error("nats unavailable")),
      random: () => 0,
    });
    const invalid = message({ invalid: true });
    dlqFailure.enqueue(invalid);
    await dlqFailure.flush();
    expect(invalid.ack).not.toHaveBeenCalled();
    expect(invalid.nak).not.toHaveBeenCalled();
    expect(dlqFailure.health().queuedMessages).toBe(1);
    dlqFailure.close();

    const clickHouseFailure = new OperationsBatchProcessor({
      config: config(),
      persist: jest.fn().mockRejectedValue(new Error("clickhouse unavailable")),
      publishDlq: jest.fn(),
      random: () => 0,
    });
    const valid = message(semanticEvent({ eventType: "login.completed" }));
    clickHouseFailure.enqueue(valid);
    await clickHouseFailure.flush();
    clickHouseFailure.close();
    expect(valid.ack).not.toHaveBeenCalled();
    expect(valid.nak).not.toHaveBeenCalled();
  });
});
