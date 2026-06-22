import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const systemRuntimeClientUrl = new URL(
  "./systemRuntimeClient.js",
  import.meta.url
);
const webPushClientUrl = new URL("./webPushClient.js", import.meta.url);

async function loadClient(url) {
  const source = await readFile(url, "utf8");
  globalThis.__runtimeClientTest = {
    calls: [],
    getJson: async (path, options = {}) => {
      globalThis.__runtimeClientTest.calls.push({
        type: "getJson",
        path,
        options,
      });
      return { response: { status: 200 }, data: { ok: true } };
    },
    postJson: async (path, body, options = {}) => {
      globalThis.__runtimeClientTest.calls.push({
        type: "postJson",
        path,
        body,
        options,
      });
      return { response: { status: 200 }, data: { ok: true } };
    },
  };

  const transformed = source.replace(
    'import { getJson, postJson } from "./apiClient";',
    "const { getJson, postJson } = globalThis.__runtimeClientTest;"
  );

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("fetchSystemEnvironment skips auth headers and uses no-cache by default", async () => {
  const { fetchSystemEnvironment } = await loadClient(systemRuntimeClientUrl);
  await fetchSystemEnvironment();

  assert.deepEqual(globalThis.__runtimeClientTest.calls, [
    {
      type: "getJson",
      path: "/system/environment",
      options: { cache: "no-cache", includeBaseHeaders: false },
    },
  ]);
});

test("system runtime client preserves token check and user action semantics", async () => {
  const { checkSessionToken, recordUserAction } = await loadClient(
    systemRuntimeClientUrl
  );
  await checkSessionToken();
  await recordUserAction("message_submit");

  assert.deepEqual(globalThis.__runtimeClientTest.calls, [
    {
      type: "getJson",
      path: "/system/check-token",
      options: { cache: "default" },
    },
    {
      type: "postJson",
      path: "/system/user-action",
      body: { reason: "message_submit" },
      options: {},
    },
  ]);
});

test("web push client uses JSON client endpoints", async () => {
  const { fetchWebPushPublicKey, subscribeWebPush } =
    await loadClient(webPushClientUrl);
  const subscription = { endpoint: "https://push.example/subscription" };

  await fetchWebPushPublicKey();
  await subscribeWebPush(subscription);

  assert.deepEqual(globalThis.__runtimeClientTest.calls, [
    {
      type: "getJson",
      path: "/web-push/pubkey",
      options: {},
    },
    {
      type: "postJson",
      path: "/web-push/subscribe",
      body: subscription,
      options: {},
    },
  ]);
});
