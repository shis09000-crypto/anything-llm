const {
  publishSyncEvent,
  subscribeToSyncEvents,
  syncEventVisibleToUser,
  _internals,
} = require("../../utils/syncCenter");
const {
  publishWorkspaceSyncEvent,
  workspaceEventFromSyncEvent,
} = require("../../utils/chats/workspaceSyncEvents");

describe("information sync center", () => {
  afterEach(() => {
    _internals.syncCenterEvents.removeAllListeners();
    for (const key of _internals.pendingCoalesced.keys()) {
      _internals.flushCoalesced(key);
    }
  });

  it("normalizes and publishes generic sync events", () => {
    const received = [];
    const unsubscribe = subscribeToSyncEvents((event) => received.push(event));

    const event = publishSyncEvent({
      namespace: "chat",
      type: "finalized",
      scope: { userId: "7", workspaceId: "2", threadId: "9" },
      resource: { kind: "chat", id: 11, publicId: "pub_11" },
      origin: { clientId: "client_a" },
      payload: { workspaceSlug: "ws", threadSlug: "th" },
    });
    _internals.flushCoalesced(event.coalesceKey);

    unsubscribe();
    expect(event.namespace).toBe("chat");
    expect(event.type).toBe("finalized");
    expect(event.scope).toEqual({
      userId: 7,
      workspaceId: 2,
      threadId: 9,
    });
    expect(event.resource).toMatchObject({
      kind: "chat",
      id: 11,
      publicId: "pub_11",
    });
    expect(received).toHaveLength(1);
    expect(received[0].eventId).toBe(event.eventId);
  });

  it("does not delay critical events behind coalescing", () => {
    const received = [];
    const unsubscribe = subscribeToSyncEvents((event) => received.push(event));

    const event = publishSyncEvent({
      namespace: "client",
      type: "revoked",
      eventPriority: "critical",
      visibility: "client",
      scope: { userId: 7, clientId: "client_a" },
    });

    unsubscribe();
    expect(event.eventPriority).toBe("critical");
    expect(received).toHaveLength(1);
    expect(received[0].eventId).toBe(event.eventId);
  });

  it("coalesces rapid events for the same resource", () => {
    const received = [];
    const unsubscribe = subscribeToSyncEvents((event) => received.push(event));

    const first = publishSyncEvent({
      namespace: "thread",
      type: "updated",
      scope: { userId: 7, workspaceId: 2, threadId: 9 },
      resource: { kind: "thread", id: 9 },
      payload: { workspaceSlug: "ws", threadSlug: "th", title: "first" },
      version: 1,
    });
    const second = publishSyncEvent({
      namespace: "thread",
      type: "updated",
      scope: { userId: 7, workspaceId: 2, threadId: 9 },
      resource: { kind: "thread", id: 9 },
      payload: { workspaceSlug: "ws", threadSlug: "th", title: "second" },
      version: 2,
    });
    _internals.flushCoalesced(first.coalesceKey);

    unsubscribe();
    expect(second.coalesceKey).toBe(first.coalesceKey);
    expect(received).toHaveLength(1);
    expect(received[0].payload.title).toBe("second");
    expect(received[0].version).toBe(2);
  });

  it("filters events by scoped user id", () => {
    expect(syncEventVisibleToUser({ scope: { userId: 3 } }, 3)).toBe(true);
    expect(syncEventVisibleToUser({ scope: { userId: 3 } }, 4)).toBe(false);
    expect(syncEventVisibleToUser({ scope: { userId: null } }, null)).toBe(
      true
    );
    expect(syncEventVisibleToUser({ scope: { userId: null } }, 4)).toBe(false);
  });

  it("filters client-visible events by exact client id", () => {
    const event = {
      visibility: "client",
      scope: { userId: 3, clientId: "client_a" },
    };
    expect(syncEventVisibleToUser(event, 3, "client_a")).toBe(true);
    expect(syncEventVisibleToUser(event, 3, "client_b")).toBe(false);
    expect(syncEventVisibleToUser(event, 3, null)).toBe(false);
  });

  it("keeps the workspace sync wrapper backward compatible", () => {
    const event = publishWorkspaceSyncEvent({
      type: "chat_finalized",
      workspaceId: 2,
      workspaceSlug: "ws",
      userId: 7,
      threadId: 9,
      threadSlug: "th",
      chatId: 11,
      publicChatId: "pub_11",
      senderClientId: "client_a",
      clientTurnId: "turn_a",
      message: "large chat body must not be broadcast",
    });
    const pendingKey = _internals.pendingCoalesced.keys().next().value;
    const rawEvent = _internals.flushCoalesced(pendingKey);

    expect(event).toMatchObject({
      type: "chat_finalized",
      workspaceId: 2,
      workspaceSlug: "ws",
      userId: 7,
      threadId: 9,
      threadSlug: "th",
      chatId: 11,
      publicChatId: "pub_11",
      senderClientId: "client_a",
      clientTurnId: "turn_a",
    });
    expect(rawEvent.payload.message).toBeUndefined();
    expect(rawEvent.payload.hasMessage).toBe(true);
  });

  it("publishes thread list events at workspace visibility", () => {
    const event = publishWorkspaceSyncEvent({
      type: "thread_created",
      workspaceId: 2,
      workspaceSlug: "ws",
      userId: 7,
      threadId: 9,
      threadSlug: "new-thread",
      senderClientId: "client_a",
    });
    const pendingKey = _internals.pendingCoalesced.keys().next().value;
    const rawEvent = _internals.flushCoalesced(pendingKey);

    expect(event.type).toBe("thread_created");
    expect(rawEvent.broadcastType || rawEvent.type).toBe("thread.created");
    expect(rawEvent.visibility).toBe("workspace");
  });

  it("converts generic sync events back to workspace sync events", () => {
    const event = workspaceEventFromSyncEvent({
      eventId: "evt",
      namespace: "thread",
      type: "deleted",
      scope: { userId: 7, workspaceId: 2, threadId: 9 },
      resource: { kind: "thread", id: 9 },
      origin: { clientId: "client_a" },
      payload: { workspaceSlug: "ws", threadSlug: "th" },
      createdAt: "2026-06-26T00:00:00.000Z",
    });

    expect(event).toMatchObject({
      eventId: "evt",
      type: "thread_deleted",
      workspaceId: 2,
      workspaceSlug: "ws",
      userId: 7,
      threadId: 9,
      threadSlug: "th",
      senderClientId: "client_a",
    });
  });
});
