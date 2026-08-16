import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const storeUrl = new URL("./syncV2StateStore.js", import.meta.url);

async function loadStore({ workspaces = [], events = [] } = {}) {
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
    dispatchEvent(event) {
      events.push(event);
    },
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  globalThis.__syncV2StoreDeps = {
    navigationStore: {
      getWorkspaces() {
        return workspaces;
      },
      markWorkspaceDetailStale() {},
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

test("document sync marks workspace detail stale without hard invalidation", async () => {
  const events = [];
  let stale = null;
  let invalidations = 0;
  const workspaces = [{ id: 9, slug: "alpha", threads: [] }];
  const { store } = await loadStore({ workspaces, events });
  globalThis.__syncV2StoreDeps.navigationStore.markWorkspaceDetailStale = (
    slug,
    reason
  ) => {
    stale = { slug, reason };
  };
  globalThis.__syncV2StoreDeps.navigationStore.invalidateWorkspaceDetail =
    () => {
      invalidations += 1;
    };

  await store.applyNode({
    descriptor: {
      nodeKey: "workspaces/9/documents",
      stateVersion: 2,
      hash: "documents-v2",
    },
    payload: { changed: true },
  });

  assert.deepEqual(stale, {
    slug: "alpha",
    reason: "sync-v2-workspace-documents",
  });
  assert.equal(invalidations, 0);
  assert.equal(
    events.at(-1)?.type,
    "athena-sync-v2-workspace-documents-refresh"
  );
  assert.equal(events.at(-1)?.detail?.workspaceSlug, "alpha");
});
