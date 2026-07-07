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
      markThreadsStale: () => {},
    },
    recoveryCenter: { handle: () => {} },
    clearSensitiveClientSession: () => {},
    sensitiveSessionCenter: { clearScope: () => {} },
    optimisticActionCenter: { confirmFromBroadcast: () => null },
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
