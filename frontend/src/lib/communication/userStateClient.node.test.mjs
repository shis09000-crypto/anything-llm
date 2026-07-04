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
