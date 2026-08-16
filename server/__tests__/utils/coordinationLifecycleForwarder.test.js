/* eslint-env jest */

const {
  LifecycleEventForwarder,
  lifecycleRecord,
} = require("../../utils/coordination/remoteLifecycleForwarder");

describe("coordination lifecycle forwarder", () => {
  const env = {
    ATHENA_RUNTIME_TOPOLOGY: "distributed",
    ATHENA_RUNTIME_ROLE: "chat-runtime",
    ATHENA_COORDINATION_INTERNAL_URL: "https://coordination-plane:3032",
  };

  function heartbeat(sequence = 2) {
    return {
      eventId: `heartbeat-${sequence}`,
      eventType: "module.lifecycle.heartbeat",
      occurredAt: "2026-08-01T12:00:00.000Z",
      outcome: "ready",
      subject: {
        id: "instance-1",
        component: "chat-runtime",
      },
      metadata: {
        moduleId: "chat-runtime",
        runtimeRole: "chat-runtime",
        version: "1.1.0",
        manifestFingerprint: "a".repeat(64),
        instanceId: "instance-1",
        sequence: String(sequence),
        ready: "true",
        heartbeatAt: "2026-08-01T12:00:00.000Z",
        leaseExpiresAt: "2026-08-01T12:01:30.000Z",
      },
    };
  }

  test("converts only metadata fields into a durable heartbeat", () => {
    expect(
      lifecycleRecord({
        ...heartbeat(),
        credentials: "must-not-forward",
        metadata: {
          ...heartbeat().metadata,
          balance: "must-not-forward",
          rootKey: "must-not-forward",
        },
      })
    ).toMatchObject({
      capability: "coordination.lifecycle.heartbeat",
      payload: {
        moduleId: "chat-runtime",
        instanceId: "instance-1",
        state: "ready",
        metadata: { ready: true },
      },
    });
    const serialized = JSON.stringify(lifecycleRecord(heartbeat()));
    expect(serialized).not.toMatch(/credential|balance|rootKey/i);
  });

  test("coalesces heartbeats and sends an AICP-bound command", async () => {
    let sink;
    const request = jest.fn().mockResolvedValue({ success: true });
    const forwarder = new LifecycleEventForwarder({
      env,
      request,
      registerSink: (registered) => {
        sink = registered;
        return () => {};
      },
    });
    forwarder.start();
    sink(heartbeat(2));
    sink(heartbeat(3));
    expect(forwarder.snapshot().queued).toBe(1);
    await forwarder.flush();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "chat-runtime",
        callerModule: "chat-runtime",
        targetModule: "coordination-plane",
        capability: "coordination.lifecycle.heartbeat",
        idempotencyKey: "heartbeat:instance-1:3",
        coordinationContext: expect.objectContaining({
          center: "recovery",
          idempotencyKey: "heartbeat:instance-1:3",
        }),
      })
    );
    expect(forwarder.snapshot()).toMatchObject({
      status: "running",
      queued: 0,
      sent: 1,
    });
    await forwarder.stop();
  });

  test("keeps failed observations queued without affecting the module", async () => {
    let sink;
    const request = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("down"), { code: "DOWN" }))
      .mockResolvedValueOnce({ success: true });
    const forwarder = new LifecycleEventForwarder({
      env,
      request,
      registerSink: (registered) => {
        sink = registered;
        return () => {};
      },
    });
    forwarder.start();
    expect(() => sink(heartbeat())).not.toThrow();
    await forwarder.flush();
    expect(forwarder.snapshot()).toMatchObject({
      status: "degraded",
      queued: 1,
      failures: 1,
    });
    await forwarder.flush();
    expect(forwarder.snapshot()).toMatchObject({
      status: "running",
      queued: 0,
      sent: 1,
    });
    await forwarder.stop();
  });
});
