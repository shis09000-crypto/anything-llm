import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const moduleUrl = new URL("./userStateClient.js", import.meta.url);

async function loadClient(api = {}) {
  const source = await readFile(moduleUrl, "utf8");
  globalThis.__userStateClientApi = api;
  globalThis.__userStateClientAppEnvironment =
    api.getAppEnvironment || (() => "test-env");
  globalThis.__userStateClientAuthUser =
    api.getStoredAuthUser || (() => ({ id: "test-user" }));
  globalThis.__userStateClientServerStateCache = api.serverStateCache || {
    invalidatePrefix: () => 0,
  };
  globalThis.__userStateClientBridge = api.serverStateTaskBridge || {
    ensure: ({ fetcher, signal }) => fetcher({ signal, handle: null }),
  };
  globalThis.__userStateClientSensitiveGuard =
    api.isSensitiveStateKey ||
    ((value = "") =>
      /(^|[._:-])(secret|token|password|credential|api[-_]?key|vault|signing[-_]?secret|private[-_]?config|sensitive[-_]?session|grant)([._:-]|$)/i.test(
        String(value || "")
      ));
  globalThis.__userStateClientMutationQueue = api.syncMutationQueue || {
    async submit() {
      return { queued: false };
    },
  };
  globalThis.__userStateClientSyncRuntime = api.syncV2Runtime || {
    enabled: () => false,
  };
  globalThis.__userStateClientSyncStore = api.syncV2StateStore || {
    descriptor: () => null,
  };
  globalThis.__userStateClientSyncV2Enabled =
    api.syncV2Enabled === true ? "true" : "false";
  const transformed = source
    .replace(
      'import { deleteJson, getJson, patchJson } from "./apiClient";',
      "const { deleteJson, getJson, patchJson } = globalThis.__userStateClientApi;"
    )
    .replace(
      'import { getAppEnvironment } from "@/utils/appEnvironment";',
      "const getAppEnvironment = globalThis.__userStateClientAppEnvironment;"
    )
    .replace(
      'import { getStoredAuthUser } from "@/utils/authUserStorage";',
      "const getStoredAuthUser = globalThis.__userStateClientAuthUser;"
    )
    .replace(
      'import { serverStateCache } from "@/utils/serverState/serverStateCache";',
      "const serverStateCache = globalThis.__userStateClientServerStateCache;"
    )
    .replace(
      'import { serverStateTaskBridge } from "@/utils/serverState/serverStateTaskBridge";',
      "const serverStateTaskBridge = globalThis.__userStateClientBridge;"
    )
    .replace(
      'import { isSensitiveStateKey } from "@/utils/sensitive/sensitiveDataGuards";',
      "const isSensitiveStateKey = globalThis.__userStateClientSensitiveGuard;"
    )
    .replace(
      'import { syncMutationQueue } from "@/utils/syncV2/syncMutationQueue";',
      "const syncMutationQueue = globalThis.__userStateClientMutationQueue;"
    )
    .replace(
      'import { syncV2Runtime } from "@/utils/syncV2/syncV2Runtime";',
      "const syncV2Runtime = globalThis.__userStateClientSyncRuntime;"
    )
    .replace(
      'import { syncV2StateStore } from "@/utils/syncV2/syncV2StateStore";',
      "const syncV2StateStore = globalThis.__userStateClientSyncStore;"
    )
    .replace(
      'String(import.meta.env?.VITE_SYNC_V2_ENABLED || "false")',
      "String(globalThis.__userStateClientSyncV2Enabled || 'false')"
    );
  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("getUserStates sends namespace query and returns states", async () => {
  const calls = [];
  const client = await loadClient({
    getJson: async (path, options) => {
      calls.push({ path, options });
      return { data: { states: [{ namespace: "recent.navigation" }] } };
    },
  });

  const states = await client.getUserStates(["recent.navigation"], {
    signal: "sig",
  });

  assert.deepEqual(states, [{ namespace: "recent.navigation" }]);
  assert.equal(
    calls[0].path,
    "/system/user/state?namespaces=recent.navigation"
  );
  assert.equal(calls[0].options.signal, "sig");
  assert.equal(calls[0].options.task, false);
});

test("getUserStates uses server-state dedupe key and sorted namespaces", async () => {
  const bridgeCalls = [];
  const client = await loadClient({
    getJson: async () => ({ data: { states: [] } }),
    serverStateTaskBridge: {
      ensure: async (options) => {
        bridgeCalls.push(options);
        return await options.fetcher({ signal: options.signal });
      },
    },
  });

  await client.getUserStates(["workspace.order", "recent.navigation"]);

  assert.equal(bridgeCalls.length, 1);
  assert.equal(
    bridgeCalls[0].key,
    "user-state:recent.navigation,workspace.order"
  );
  assert.equal(
    bridgeCalls[0].dedupeKey,
    "server-state:user-state:recent.navigation,workspace.order"
  );
  assert.equal(bridgeCalls[0].ownerScope, "server");
});

test("patchUserStates wraps single state and returns saved states", async () => {
  let body;
  let invalidatedPrefix = null;
  const client = await loadClient({
    patchJson: async (path, nextBody) => {
      assert.equal(path, "/system/user/state");
      body = nextBody;
      return { data: { states: nextBody.states } };
    },
    serverStateCache: {
      invalidatePrefix: (prefix) => {
        invalidatedPrefix = prefix;
        return 1;
      },
    },
  });

  const states = await client.patchUserStates({
    namespace: "chat.draft",
    scope: "workspace:ws-a",
    value: { text: "hello" },
  });

  assert.equal(body.states.length, 1);
  assert.equal(states[0].namespace, "chat.draft");
  assert.equal(invalidatedPrefix, "user-state:");
});

test("Sync V2 submits cross-device draft plaintext for server at-rest protection", async () => {
  const submitted = [];
  const client = await loadClient({
    syncV2Enabled: true,
    getStoredAuthUser: () => ({ id: 7 }),
    syncV2Runtime: { enabled: () => true },
    syncV2StateStore: {
      descriptor: () => ({ stateVersion: 9 }),
    },
    syncMutationQueue: {
      async submit(mutation) {
        submitted.push(mutation);
        return {
          descriptor: { nodeKey: mutation.nodeKey, stateVersion: 10 },
        };
      },
    },
  });

  await client.patchUserStates({
    namespace: "chat.draft",
    scope: "thread:ws-a:thread-a",
    value: {
      text: "device A draft",
      workspaceSlug: "ws-a",
      threadSlug: "thread-a",
      updatedAt: "client-clock",
    },
  });

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].payload.text, "device A draft");
  assert.equal(submitted[0].payload.updatedAt, undefined);
  assert.equal(submitted[0].baseVersion, 9);
});

test("same-node Sync V2 writes are ordered and refresh baseVersion", async () => {
  const submitted = [];
  let descriptorVersion = 9;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const client = await loadClient({
    syncV2Enabled: true,
    getStoredAuthUser: () => ({ id: 7, authUserId: "auth-7" }),
    syncV2Runtime: { enabled: () => true },
    syncV2StateStore: {
      descriptor: () => ({ stateVersion: descriptorVersion }),
    },
    syncMutationQueue: {
      async submit(mutation) {
        submitted.push(mutation);
        if (submitted.length === 1) await firstGate;
        descriptorVersion += 1;
        return {
          descriptor: {
            nodeKey: mutation.nodeKey,
            stateVersion: descriptorVersion,
          },
        };
      },
    },
  });

  const first = client.patchUserStates({
    namespace: "chat.draft",
    scope: "thread:ws-a:thread-a",
    value: { text: "first" },
  });
  const second = client.patchUserStates({
    namespace: "chat.draft",
    scope: "thread:ws-a:thread-a",
    value: { text: "second" },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(submitted.length, 1);
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(
    submitted.map((mutation) => mutation.baseVersion),
    [9, 10]
  );
  assert.deepEqual(
    submitted.map((mutation) => mutation.payload.text),
    ["first", "second"]
  );
});

test("same-node draft clear waits for the pending save", async () => {
  const operations = [];
  let releaseSave;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  let descriptorVersion = 4;
  const client = await loadClient({
    syncV2Enabled: true,
    getStoredAuthUser: () => ({ id: 7 }),
    syncV2Runtime: { enabled: () => true },
    syncV2StateStore: {
      descriptor: () => ({ stateVersion: descriptorVersion }),
    },
    syncMutationQueue: {
      async submit(mutation) {
        operations.push(mutation.operation);
        if (mutation.operation !== "delete") await saveGate;
        descriptorVersion += 1;
        return {
          descriptor: {
            nodeKey: mutation.nodeKey,
            stateVersion: descriptorVersion,
          },
        };
      },
    },
  });

  const save = client.patchUserStates({
    namespace: "chat.draft",
    scope: "thread:ws-a:thread-a",
    value: { text: "will be cleared" },
  });
  const clear = client.deleteUserState({
    namespace: "chat.draft",
    scope: "thread:ws-a:thread-a",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(operations, ["merge"]);
  releaseSave();
  await Promise.all([save, clear]);
  assert.deepEqual(operations, ["merge", "delete"]);
});

test("deleteUserState preserves namespace and scope", async () => {
  let body;
  let invalidatedPrefix = null;
  const client = await loadClient({
    deleteJson: async (path, options) => {
      assert.equal(path, "/system/user/state");
      body = options.body;
      return { data: { success: true, deletedCount: 1 } };
    },
    serverStateCache: {
      invalidatePrefix: (prefix) => {
        invalidatedPrefix = prefix;
        return 1;
      },
    },
  });

  const result = await client.deleteUserState({
    namespace: "chat.draft",
    scope: "workspace:ws-a",
  });

  assert.deepEqual(body, {
    namespace: "chat.draft",
    scope: "workspace:ws-a",
  });
  assert.equal(result.deletedCount, 1);
  assert.equal(invalidatedPrefix, "user-state:");
});
