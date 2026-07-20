import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const storeUrl = new URL("./syncV2StateStore.js", import.meta.url);

async function loadStore() {
  const values = new Map();
  const writes = [];
  globalThis.window = {
    localStorage: {
      get length() {
        return values.size;
      },
      getItem(key) {
        return values.get(key) ?? null;
      },
      setItem(key, value) {
        values.set(key, value);
        writes.push(key);
      },
      removeItem(key) {
        values.delete(key);
      },
      key(index) {
        return [...values.keys()][index] || null;
      },
    },
    addEventListener() {},
    dispatchEvent() {},
  };
  globalThis.CustomEvent = class CustomEvent {};
  globalThis.__syncV2StoreDeps = {
    navigationStore: {
      getWorkspaces() {
        return [];
      },
    },
    navigationCache: {},
    threadHistoryCache: {},
    serverStateCache: {
      invalidateScope() {},
      set() {},
    },
  };
  const source = await readFile(storeUrl, "utf8");
  const body = source
    .replace(
      'import { getAppEnvironment } from "@/utils/appEnvironment";',
      'const getAppEnvironment = () => "web";'
    )
    .replace(
      'import { getStoredAuthUser } from "@/utils/authUserStorage";',
      "const getStoredAuthUser = () => ({ id: 1 });"
    )
    .replace(
      'import { workspaceNavigationStore } from "@/utils/serverState/workspaceNavigationStore";',
      "const workspaceNavigationStore = globalThis.__syncV2StoreDeps.navigationStore;"
    )
    .replace(
      'import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";',
      "const workspaceNavigationCache = globalThis.__syncV2StoreDeps.navigationCache;"
    )
    .replace(
      'import { threadHistoryCache } from "@/utils/chat/threadHistoryCache";',
      "const threadHistoryCache = globalThis.__syncV2StoreDeps.threadHistoryCache;"
    )
    .replace(
      'import { serverStateCache } from "@/utils/serverState/serverStateCache";',
      "const serverStateCache = globalThis.__syncV2StoreDeps.serverStateCache;"
    );
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(body).toString("base64")}#${Date.now()}-${Math.random()}`
  );
  return { store: module.syncV2StateStore, writes };
}

test("batch node application persists the descriptor map once", async () => {
  const { store, writes } = await loadStore();
  const nodes = Array.from({ length: 200 }, (_, index) => ({
    descriptor: {
      nodeKey: `custom/${index}`,
      stateVersion: 1,
      hash: `hash-${index}`,
    },
    payload: null,
  }));

  await store.applyNodesBatch(nodes);

  assert.equal(writes.filter((key) => key.endsWith(":descriptors")).length, 1);
  assert.equal(Object.keys(store.descriptors()).length, 200);
  assert.equal(store.diagnostics().sync_descriptor_commits, 1);
});
