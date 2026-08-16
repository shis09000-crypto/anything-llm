/* eslint-env jest */

const {
  OperationsEventForwarder,
  forwardingEnabled,
  isSelfReferentialForwardingEvent,
} = require("../../utils/operations/remoteEventForwarder");

describe("Remote Operations event forwarder", () => {
  const env = {
    ATHENA_RUNTIME_TOPOLOGY: "distributed",
    ATHENA_RUNTIME_ROLE: "chat-runtime",
    ATHENA_OPERATIONS_INTERNAL_URL: "https://operations-plane:3015",
    ATHENA_OPERATIONS_HEARTBEAT_ENABLED: "false",
  };

  test("does not forward from the Operations Plane itself", () => {
    expect(forwardingEnabled(env)).toBe(true);
    expect(
      forwardingEnabled({
        ...env,
        ATHENA_RUNTIME_ROLE: "operations-plane",
      })
    ).toBe(false);
  });

  test("does not recursively forward observations about its own failed link", () => {
    expect(
      isSelfReferentialForwardingEvent({
        eventType: "aicp.rpc.observed",
        subject: { operation: "POST /internal/v1/operations/" },
        impact: { scope: "operations-plane", status: "failed" },
      })
    ).toBe(true);
    expect(
      isSelfReferentialForwardingEvent({
        eventType: "aicp.rpc.observed",
        subject: { operation: "POST /internal/v1/browser/" },
        impact: { scope: "browser-plane", status: "failed" },
      })
    ).toBe(false);
  });

  test("batches metadata events and uses the producer service identity", async () => {
    let sink;
    const unregister = jest.fn();
    const request = jest.fn().mockResolvedValue({ success: true, accepted: 2 });
    const forwarder = new OperationsEventForwarder({
      env,
      request,
      registerSink: (registered) => {
        sink = registered;
        return unregister;
      },
    });
    forwarder.start();
    sink({ eventId: "event-1", sensitivity: "metadata_only" });
    sink({ eventId: "event-2", sensitivity: "metadata_only" });
    await forwarder.flush();

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "chat-runtime",
        callerModule: "chat-runtime",
        targetModule: "operations-plane",
        capability: "operations.ingest-batch",
        contractVersion: "1.0",
        url: "https://operations-plane:3015/internal/v1/operations/ingest-batch",
        body: {
          events: [
            { eventId: "event-1", sensitivity: "metadata_only" },
            { eventId: "event-2", sensitivity: "metadata_only" },
          ],
        },
        coordinationContext: expect.objectContaining({
          center: "recovery",
          correlationId: "operations:event-1",
          causationId: "event-1",
          priority: "P2",
        }),
      })
    );
    expect(
      Date.parse(
        request.mock.calls[0][0].coordinationContext.deadlineAt
      )
    ).toBeGreaterThan(Date.now());
    expect(forwarder.snapshot()).toMatchObject({
      status: "running",
      queued: 0,
      sent: 2,
      dropped: 0,
    });
    await forwarder.stop();
    expect(unregister).toHaveBeenCalled();
  });

  test("keeps failed batches in a bounded retry queue without failing work", async () => {
    let sink;
    const request = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" })
      )
      .mockResolvedValueOnce({ success: true, accepted: 1 });
    const forwarder = new OperationsEventForwarder({
      env,
      request,
      registerSink: (registered) => {
        sink = registered;
        return () => {};
      },
    });
    forwarder.start();
    expect(() =>
      sink({ eventId: "retry-event", sensitivity: "metadata_only" })
    ).not.toThrow();
    await forwarder.flush();
    expect(forwarder.snapshot()).toMatchObject({
      status: "degraded",
      queued: 1,
      failures: 1,
      lastError: "ECONNREFUSED",
    });
    await forwarder.flush();
    expect(forwarder.snapshot()).toMatchObject({
      status: "running",
      queued: 0,
      sent: 1,
      failures: 0,
    });
    await forwarder.stop();
  });
});
