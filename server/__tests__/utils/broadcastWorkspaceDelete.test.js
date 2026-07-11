const { _internals } = require("../../utils/broadcast");

describe("workspace delete broadcast isolation", () => {
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
});
