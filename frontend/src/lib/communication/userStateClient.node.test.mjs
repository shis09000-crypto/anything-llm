import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const moduleUrl = new URL("./userStateClient.js", import.meta.url);

async function loadClient(api = {}) {
  const source = await readFile(moduleUrl, "utf8");
  globalThis.__userStateClientApi = api;
  const transformed = source.replace(
    'import { deleteJson, getJson, patchJson } from "./apiClient";',
    "const { deleteJson, getJson, patchJson } = globalThis.__userStateClientApi;"
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
});

test("patchUserStates wraps single state and returns saved states", async () => {
  let body;
  const client = await loadClient({
    patchJson: async (path, nextBody) => {
      assert.equal(path, "/system/user/state");
      body = nextBody;
      return { data: { states: nextBody.states } };
    },
  });

  const states = await client.patchUserStates({
    namespace: "chat.draft",
    scope: "workspace:ws-a",
    value: { text: "hello" },
  });

  assert.equal(body.states.length, 1);
  assert.equal(states[0].namespace, "chat.draft");
});

test("deleteUserState preserves namespace and scope", async () => {
  let body;
  const client = await loadClient({
    deleteJson: async (path, options) => {
      assert.equal(path, "/system/user/state");
      body = options.body;
      return { data: { success: true, deletedCount: 1 } };
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
});
