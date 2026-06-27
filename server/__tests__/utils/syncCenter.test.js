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

  it("filters events by scoped user id", () => {
    expect(syncEventVisibleToUser({ scope: { userId: 3 } }, 3)).toBe(true);
    expect(syncEventVisibleToUser({ scope: { userId: 3 } }, 4)).toBe(false);
    expect(syncEventVisibleToUser({ scope: { userId: null } }, null)).toBe(
      true
    );
    expect(syncEventVisibleToUser({ scope: { userId: null } }, 4)).toBe(false);
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
    });

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
