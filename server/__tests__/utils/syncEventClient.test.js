/* global jest, describe, beforeEach, test, expect */

const mockRequestInternalService = jest.fn();

jest.mock("../../utils/microModules/internalClient", () => ({
  requestInternalService: (...args) => mockRequestInternalService(...args),
}));

const {
  appendSyncEventViaCapability,
  coordinationContextForEvent,
  moduleIdForRole,
  remoteSyncEventAppendEnabled,
} = require("../../utils/syncV2/syncEventClient");

describe("Sync V2 durable event capability client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("maps runtime roles to their manifest owners", () => {
    expect(moduleIdForRole("api")).toBe("athena-api");
    expect(moduleIdForRole("identity")).toBe("authentication");
    expect(moduleIdForRole("reader-worker")).toBe("reader-worker");
  });

  test("preserves task priority semantics in the coordination context", () => {
    const context = coordinationContextForEvent(
      {
        eventId: "event-1",
        eventPriority: "critical",
        origin: { requestId: "request-1" },
      },
      Date.parse("2026-08-03T00:00:00.000Z")
    );
    expect(context).toEqual({
      coordinationRunId: "event-1",
      stepId: "sync-event-append",
      correlationId: "event-1",
      center: "data",
      priority: "P0",
      deadlineAt: "2026-08-03T00:00:05.000Z",
      causationId: "request-1",
    });
  });

  test("uses the Sync V2 owner capability in distributed topology", async () => {
    const event = { eventId: "event-2", eventPriority: "normal" };
    mockRequestInternalService.mockResolvedValue({ success: true, event });
    const env = {
      ATHENA_RUNTIME_TOPOLOGY: "micro-modules",
      ATHENA_RUNTIME_ROLE: "api",
      ATHENA_REALTIME_GATEWAY_URL: "https://sync-v2:3013",
    };

    expect(remoteSyncEventAppendEnabled(env)).toBe(true);
    await expect(appendSyncEventViaCapability(event, env)).resolves.toBe(event);
    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "api",
        callerModule: "athena-api",
        targetModule: "sync-v2",
        capability: "sync.events.append",
        contractVersion: "1.0",
        url: "https://sync-v2:3013/internal/v1/sync/events/append",
        idempotencyKey: "event-2",
        coordinationContext: expect.objectContaining({
          center: "data",
          priority: "P2",
        }),
      })
    );
  });

  test("fails closed when a distributed producer has no owner endpoint", async () => {
    await expect(
      appendSyncEventViaCapability(
        { eventId: "event-3" },
        {
          ATHENA_RUNTIME_TOPOLOGY: "micro-modules",
          ATHENA_RUNTIME_ROLE: "reader-worker",
        }
      )
    ).rejects.toMatchObject({
      code: "sync_event_capability_unavailable",
      httpStatus: 503,
    });
    expect(mockRequestInternalService).not.toHaveBeenCalled();
  });
});
