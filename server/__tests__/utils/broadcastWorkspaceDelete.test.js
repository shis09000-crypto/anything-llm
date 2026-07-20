const { DataAccessCenter } = require("../../utils/dataAccess");
const {
  _internals,
  publishBroadcastEventDurably,
  subscribeToBroadcastEvents,
} = require("../../utils/broadcast");

describe("workspace delete broadcast isolation", () => {
  it("does not persist in a Jest worker when production branches are tested", () => {
    expect(
      _internals.shouldPersistDurableEvents({
        NODE_ENV: "production",
        JEST_WORKER_ID: "1",
      })
    ).toBe(false);
    expect(
      _internals.shouldPersistDurableEvents({
        NODE_ENV: "production",
        JEST_WORKER_ID: "1",
        ATHENA_SYNC_EVENT_TEST_PERSIST: "true",
      })
    ).toBe(true);
  });

  function userSubscription() {
    return new Map([["user", { visibility: "user" }]]);
  }

  it("only delivers workspace delete lifecycle events to the scoped user", () => {
    const event = _internals.normalizeBroadcastEvent({
      namespace: "workspace",
      type: "delete.requested",
      visibility: "user",
      scope: {
        userId: 7,
        workspaceId: 42,
        workspaceSlug: "shared-slug",
      },
      resource: { kind: "workspace", id: 42 },
      payload: {
        workspaceSlug: "shared-slug",
        deleteIntentId: "delete-intent-a",
      },
    });

    expect(
      _internals.connectionSubscribedToEvent(event, {
        userId: 7,
        clientId: "client-a",
        subscriptions: userSubscription(),
      })
    ).toBe(true);
    expect(
      _internals.connectionSubscribedToEvent(event, {
        userId: 8,
        clientId: "client-b",
        subscriptions: userSubscription(),
      })
    ).toBe(false);
  });

  it("does not deliver null-user workspace delete events to authenticated users", () => {
    const event = _internals.normalizeBroadcastEvent({
      namespace: "workspace",
      type: "delete.failed",
      visibility: "user",
      scope: {
        userId: null,
        workspaceId: 42,
        workspaceSlug: "shared-slug",
      },
      resource: { kind: "workspace", id: 42 },
      payload: {
        workspaceSlug: "shared-slug",
        deleteIntentId: "delete-intent-a",
        errorCode: "workspace_delete_failed",
      },
    });

    expect(
      _internals.connectionSubscribedToEvent(event, {
        userId: 7,
        clientId: "client-a",
        subscriptions: userSubscription(),
      })
    ).toBe(false);
  });

  it("delivers iOS-only preference events to iOS and iPad clients only", () => {
    const event = _internals.normalizeBroadcastEvent({
      namespace: "userState",
      type: "updated",
      visibility: "user",
      audience: ["ios", "ipad"],
      scope: { userId: 7 },
      resource: { kind: "user-state", id: "ios.drawer.pins" },
      payload: { namespaces: ["ios.drawer.pins"] },
    });

    expect(
      _internals.connectionSubscribedToEvent(event, {
        userId: 7,
        platform: "ios",
        subscriptions: userSubscription(),
      })
    ).toBe(true);
    expect(
      _internals.connectionSubscribedToEvent(event, {
        userId: 7,
        platform: "web",
        subscriptions: userSubscription(),
      })
    ).toBe(false);
  });

  it("does not fan out a durable event before replay persistence commits", async () => {
    const previous = process.env.ATHENA_SYNC_EVENT_TEST_PERSIST;
    process.env.ATHENA_SYNC_EVENT_TEST_PERSIST = "true";
    let releasePersistence;
    const persisted = new Promise((resolve) => {
      releasePersistence = resolve;
    });
    const persist = jest
      .spyOn(DataAccessCenter.syncEvent, "persist")
      .mockImplementation(async (event) => {
        await persisted;
        return event;
      });
    const handler = jest.fn();
    const unsubscribe = subscribeToBroadcastEvents(handler);
    try {
      const publish = publishBroadcastEventDurably(
        {
          namespace: "syncV2",
          type: "changed",
          visibility: "user",
          scope: { userId: 7 },
          resource: { kind: "sync-node", id: "users/7/profile" },
        },
        { coalesce: false }
      );
      await Promise.resolve();
      expect(persist).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();

      releasePersistence();
      await publish;
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      persist.mockRestore();
      if (previous === undefined)
        delete process.env.ATHENA_SYNC_EVENT_TEST_PERSIST;
      else process.env.ATHENA_SYNC_EVENT_TEST_PERSIST = previous;
    }
  });

  it("does not fan out when durable replay persistence fails", async () => {
    const previous = process.env.ATHENA_SYNC_EVENT_TEST_PERSIST;
    process.env.ATHENA_SYNC_EVENT_TEST_PERSIST = "true";
    const persist = jest
      .spyOn(DataAccessCenter.syncEvent, "persist")
      .mockRejectedValueOnce(new Error("persist failed"));
    const handler = jest.fn();
    const unsubscribe = subscribeToBroadcastEvents(handler);
    try {
      await expect(
        publishBroadcastEventDurably(
          {
            namespace: "syncV2",
            type: "changed",
            visibility: "user",
            scope: { userId: 7 },
            resource: { kind: "sync-node", id: "users/7/profile" },
          },
          { coalesce: false }
        )
      ).rejects.toThrow("persist failed");
      expect(handler).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      persist.mockRestore();
      if (previous === undefined)
        delete process.env.ATHENA_SYNC_EVENT_TEST_PERSIST;
      else process.env.ATHENA_SYNC_EVENT_TEST_PERSIST = previous;
    }
  });
});
