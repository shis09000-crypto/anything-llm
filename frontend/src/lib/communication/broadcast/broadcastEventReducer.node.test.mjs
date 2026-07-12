import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reducerUrl = new URL("./broadcastEventReducer.js", import.meta.url);
const schemaUrl = new URL("./broadcastEventSchema.js", import.meta.url);

async function loadReducer(stubs) {
  const reducerSource = await readFile(reducerUrl, "utf8");
  const schemaSource = await readFile(schemaUrl, "utf8");
  const bodyStart = reducerSource.indexOf("const EVENT_CACHE_LIMIT");
  const source = `
const clearSigningSecretCache = (...args) => globalThis.__broadcastReducerStubs.clearSigningSecretCache(...args);
const getClientIdentity = () => globalThis.__broadcastReducerStubs.getClientIdentity();
const serverStateCache = globalThis.__broadcastReducerStubs.serverStateCache;
const serverStateTaskBridge = globalThis.__broadcastReducerStubs.serverStateTaskBridge;
const workspaceNavigationCache = globalThis.__broadcastReducerStubs.workspaceNavigationCache;
const recoveryCenter = globalThis.__broadcastReducerStubs.recoveryCenter;
const clearSensitiveClientSession = (...args) => globalThis.__broadcastReducerStubs.clearSensitiveClientSession(...args);
const sensitiveSessionCenter = globalThis.__broadcastReducerStubs.sensitiveSessionCenter;
const optimisticActionCenter = globalThis.__broadcastReducerStubs.optimisticActionCenter;
const dispatchThreadCreateVisual = (...args) => globalThis.__broadcastReducerStubs.dispatchThreadCreateVisual(...args);
const dispatchThreadDeleteVisual = (...args) => globalThis.__broadcastReducerStubs.dispatchThreadDeleteVisual(...args);
const dispatchThreadMoveVisual = (...args) => globalThis.__broadcastReducerStubs.dispatchThreadMoveVisual(...args);
const dispatchThreadPatchVisual = (...args) => globalThis.__broadcastReducerStubs.dispatchThreadPatchVisual(...args);
const dispatchWorkspacePatchVisual = (...args) => globalThis.__broadcastReducerStubs.dispatchWorkspacePatchVisual(...args);
const confirmWorkspaceDelete = (...args) => globalThis.__broadcastReducerStubs.confirmWorkspaceDelete(...args);
const failWorkspaceDelete = (...args) => globalThis.__broadcastReducerStubs.failWorkspaceDelete(...args);
const handleWorkspaceCreated = (...args) => globalThis.__broadcastReducerStubs.handleWorkspaceCreated(...args);
const handleWorkspaceDeleteRequested = (...args) => globalThis.__broadcastReducerStubs.handleWorkspaceDeleteRequested(...args);
${schemaSource.replaceAll("export ", "")}
${reducerSource.slice(bodyStart)}
`;
  globalThis.__broadcastReducerStubs = stubs;
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

function createStubs() {
  const calls = {
    prefixes: [],
    scopes: [],
    markStale: [],
    deleteRequests: [],
    deleteConfirms: [],
    deleteFailures: [],
    workspaceCreates: [],
    workspacePatches: [],
    threadCreateVisuals: [],
    threadDeleteVisuals: [],
    threadMoveVisuals: [],
    threadPatchVisuals: [],
    optimisticConfirms: [],
    workspaceSoftStale: [],
    workspaceDetailSoftStale: [],
    cachedThreads: new Map(),
    setThreads: [],
  };
  return {
    calls,
    clearSigningSecretCache: () => {},
    getClientIdentity: () => ({ clientId: "client-a" }),
    serverStateCache: {
      invalidatePrefix: (prefix) => calls.prefixes.push(prefix),
      invalidateScope: (scope) => calls.scopes.push(scope),
      invalidate: () => {},
    },
    serverStateTaskBridge: {
      invalidateScope: (scope, reason) => calls.scopes.push({ scope, reason }),
      markScopeStale: (scope, reason) =>
        calls.markStale.push({ scope, reason }),
    },
    workspaceNavigationCache: {
      invalidateWorkspaceDetail: () => {},
      invalidateThreads: () => {},
      invalidateWorkspaces: () => {},
      markThreadsStale: (workspaceSlug, reason) =>
        calls.markStale.push({ workspaceSlug, reason }),
      markWorkspaceDetailStale: (workspaceSlug, reason) =>
        calls.workspaceDetailSoftStale.push({ workspaceSlug, reason }),
      markWorkspacesStale: (reason) => calls.workspaceSoftStale.push(reason),
      getThreads: (workspaceSlug) => calls.cachedThreads.get(workspaceSlug),
      setThreads: (workspaceSlug, threads) =>
        calls.setThreads.push({ workspaceSlug, threads }),
      updateThread: (workspaceSlug, thread) =>
        calls.setThreads.push({ workspaceSlug, threads: [thread] }),
      removeWorkspace: () => {},
      removeThread: () => {},
      upsertWorkspace: (workspace) => calls.workspacePatches.push(workspace),
    },
    recoveryCenter: { handle: () => {} },
    clearSensitiveClientSession: () => {},
    sensitiveSessionCenter: { clearScope: () => {} },
    optimisticActionCenter: {
      confirmFromBroadcast: (payload) => {
        calls.optimisticConfirms.push(payload);
        return null;
      },
    },
    dispatchThreadCreateVisual: (detail) =>
      calls.threadCreateVisuals.push(detail),
    dispatchThreadDeleteVisual: (detail) =>
      calls.threadDeleteVisuals.push(detail),
    dispatchThreadMoveVisual: (detail) => calls.threadMoveVisuals.push(detail),
    dispatchThreadPatchVisual: (detail) =>
      calls.threadPatchVisuals.push(detail),
    dispatchWorkspacePatchVisual: (detail) =>
      calls.workspacePatches.push(detail),
    handleWorkspaceCreated: (event) => calls.workspaceCreates.push(event),
    handleWorkspaceDeleteRequested: (event) => calls.deleteRequests.push(event),
    confirmWorkspaceDelete: (event) => calls.deleteConfirms.push(event),
    failWorkspaceDelete: (event) => calls.deleteFailures.push(event),
  };
}

test("broadcast reducer refreshes user profile state and avatar cache", async () => {
  const originalWindow = globalThis.window;
  const originalCustomEvent = globalThis.CustomEvent;
  const dispatched = [];
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  globalThis.window = {
    dispatchEvent(event) {
      dispatched.push(event);
    },
  };

  try {
    const stubs = createStubs();
    const { broadcastEventReducer } = await loadReducer(stubs);
    const result = broadcastEventReducer.reduce({
      eventId: "profile-event-1",
      namespace: "user",
      type: "profile.updated",
      visibility: "user",
      scope: { userId: 7 },
      resource: { kind: "user-profile", id: 7 },
      payload: {
        changedFields: ["username", "pfpFilename"],
        reason: "profile-updated",
      },
      version: 10,
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, "user-profile-refresh");
    assert.deepEqual(stubs.calls.prefixes, [
      "account.avatar:",
      "account.profile:",
    ]);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, "athena-user-profile-refresh");
    assert.deepEqual(dispatched[0].detail, {
      eventId: "profile-event-1",
      userId: 7,
      changedFields: ["username", "pfpFilename"],
      reason: "profile-updated",
      sourceClientId: null,
      sourceActionId: null,
    });
  } finally {
    globalThis.window = originalWindow;
    globalThis.CustomEvent = originalCustomEvent;
    delete globalThis.__broadcastReducerStubs;
  }
});

test("broadcast reducer routes workspace and thread create/delete to local visual actions", async () => {
  const stubs = createStubs();
  const { broadcastEventReducer } = await loadReducer(stubs);

  const workspaceCreated = broadcastEventReducer.reduce({
    eventId: "workspace-created-visual-1",
    namespace: "workspace",
    type: "created",
    visibility: "user",
    scope: { userId: 7, workspaceId: 42, workspaceSlug: "workspace-a" },
    resource: { kind: "workspace", id: 42 },
    payload: { workspaceSlug: "workspace-a", workspaceName: "Workspace A" },
    version: 21,
  });

  const threadCreated = broadcastEventReducer.reduce({
    eventId: "thread-created-visual-1",
    namespace: "thread",
    type: "created",
    visibility: "user",
    scope: { userId: 7, workspaceSlug: "workspace-a", threadId: 99 },
    resource: { kind: "thread", id: 99 },
    payload: {
      workspaceSlug: "workspace-a",
      threadSlug: "thread-a",
      threadName: "Thread A",
    },
    version: 22,
  });

  const threadDeleted = broadcastEventReducer.reduce({
    eventId: "thread-deleted-visual-1",
    namespace: "thread",
    type: "deleted",
    visibility: "user",
    scope: { userId: 7, workspaceSlug: "workspace-a", threadId: 99 },
    resource: { kind: "thread", id: 99 },
    payload: { workspaceSlug: "workspace-a", threadSlug: "thread-a" },
    version: 23,
  });

  assert.equal(workspaceCreated.ok, true);
  assert.equal(workspaceCreated.action, "workspace-create-requested");
  assert.equal(threadCreated.ok, true);
  assert.equal(threadCreated.action, "thread-create-requested");
  assert.equal(threadDeleted.ok, true);
  assert.equal(threadDeleted.action, "thread-delete-requested");
  assert.equal(stubs.calls.workspaceCreates.length, 1);
  assert.equal(stubs.calls.threadCreateVisuals[0].workspaceSlug, "workspace-a");
  assert.equal(stubs.calls.threadCreateVisuals[0].thread.slug, "thread-a");
  assert.equal(stubs.calls.threadCreateVisuals[0].thread.name, "Thread A");
  assert.equal(stubs.calls.threadCreateVisuals[0].thread.thread_type, "chat");
  assert.equal(stubs.calls.threadCreateVisuals[0].source, "broadcast");
  assert.equal(
    stubs.calls.threadCreateVisuals[0].eventId,
    "thread-created-visual-1"
  );
  assert.deepEqual(stubs.calls.threadDeleteVisuals[0], {
    workspaceSlug: "workspace-a",
    threadSlug: "thread-a",
    source: "broadcast",
    eventId: "thread-deleted-visual-1",
  });
  assert.equal(stubs.calls.markStale.length, 0);
  assert.equal(stubs.calls.scopes.length, 0);
  delete globalThis.__broadcastReducerStubs;
});

test("broadcast reducer routes workspace delete lifecycle events", async () => {
  const stubs = createStubs();
  const { broadcastEventReducer } = await loadReducer(stubs);
  const baseEvent = {
    visibility: "user",
    scope: { userId: 7, workspaceId: 42, workspaceSlug: "workspace-a" },
    resource: { kind: "workspace", id: 42 },
    payload: {
      workspaceSlug: "workspace-a",
      deleteIntentId: "delete-intent-a",
    },
    sourceActionId: "workspace.delete:delete-intent-a",
    version: 11,
  };

  const requested = broadcastEventReducer.reduce({
    ...baseEvent,
    eventId: "workspace-delete-requested-1",
    namespace: "workspace",
    type: "delete.requested",
  });
  const confirmed = broadcastEventReducer.reduce({
    ...baseEvent,
    eventId: "workspace-deleted-1",
    namespace: "workspace",
    type: "deleted",
    version: 12,
  });
  const failed = broadcastEventReducer.reduce({
    ...baseEvent,
    eventId: "workspace-delete-failed-1",
    namespace: "workspace",
    type: "delete.failed",
    version: 13,
  });

  assert.equal(requested.ok, true);
  assert.equal(requested.action, "workspace-delete-requested");
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.action, "workspace-delete-confirmed");
  assert.equal(failed.ok, true);
  assert.equal(failed.action, "workspace-delete-failed");
  assert.equal(stubs.calls.deleteRequests.length, 1);
  assert.equal(stubs.calls.deleteConfirms.length, 1);
  assert.equal(stubs.calls.deleteFailures.length, 1);
  assert.equal(stubs.calls.optimisticConfirms.length, 0);
  assert.equal(stubs.calls.markStale.length, 0);
  assert.equal(stubs.calls.scopes.length, 0);
  delete globalThis.__broadcastReducerStubs;
});

test("broadcast reducer keeps workspace thread and chat updates scoped", async () => {
  const stubs = createStubs();
  stubs.calls.cachedThreads.set("workspace-a", [
    { slug: "thread-a", name: "Old Thread", title: "Old Thread" },
  ]);
  const { broadcastEventReducer } = await loadReducer(stubs);

  const workspaceUpdated = broadcastEventReducer.reduce({
    eventId: "workspace-updated-scoped-1",
    namespace: "workspace",
    type: "updated",
    visibility: "user",
    scope: { userId: 7, workspaceId: 42, workspaceSlug: "workspace-a" },
    resource: { kind: "workspace", id: 42 },
    payload: { workspaceSlug: "workspace-a", workspaceName: "Workspace B" },
    version: 31,
  });

  const threadUpdated = broadcastEventReducer.reduce({
    eventId: "thread-updated-scoped-1",
    namespace: "thread",
    type: "updated",
    visibility: "workspace",
    scope: { userId: 7, workspaceSlug: "workspace-a", threadId: 99 },
    resource: { kind: "thread", id: 99 },
    payload: {
      workspaceSlug: "workspace-a",
      threadSlug: "thread-a",
      threadName: "Thread B",
    },
    version: 32,
  });

  const chatUpdated = broadcastEventReducer.reduce({
    eventId: "chat-updated-scoped-1",
    namespace: "chat",
    type: "updated",
    visibility: "workspace",
    scope: { userId: 7, workspaceSlug: "workspace-a", threadId: 99 },
    resource: { kind: "chat", id: 123 },
    payload: { workspaceSlug: "workspace-a", threadSlug: "thread-a" },
    version: 33,
  });

  assert.equal(workspaceUpdated.ok, true);
  assert.equal(workspaceUpdated.action, "workspace-soft-stale");
  assert.equal(threadUpdated.ok, true);
  assert.equal(threadUpdated.action, "thread-patch");
  assert.equal(chatUpdated.ok, true);
  assert.equal(chatUpdated.action, "chat-soft-stale");
  assert.equal(stubs.calls.scopes.length, 0);
  assert.equal(stubs.calls.workspaceDetailSoftStale.length, 1);
  assert.equal(stubs.calls.workspaceSoftStale.length, 1);
  assert.equal(stubs.calls.threadPatchVisuals.length, 1);
  assert.equal(stubs.calls.threadPatchVisuals[0].thread.name, "Thread B");
  assert.ok(stubs.calls.markStale.length >= 2);
  delete globalThis.__broadcastReducerStubs;
});
