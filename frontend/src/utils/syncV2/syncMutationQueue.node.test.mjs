import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrl = new URL("./syncMutationQueue.js", import.meta.url);

async function loadQueue(api = {}) {
  const source = await readFile(moduleUrl, "utf8");
  delete globalThis.window;
  if (api.indexedDB) globalThis.indexedDB = api.indexedDB;
  else delete globalThis.indexedDB;
  globalThis.__mutationQueueEnvironment = () => "test-env";
  globalThis.__mutationQueueAuthUser = () => ({
    id: 7,
    authUserId: "auth-7",
  });
  globalThis.__mutationQueueEncrypt = async ({ payload }) => ({
    encrypted: true,
    payload,
  });
  globalThis.__mutationQueueDecrypt = async ({ encryptedPayload }) =>
    encryptedPayload.payload;
  globalThis.__mutationQueueClient = api.syncV2Client;
  globalThis.__mutationQueueStore = api.syncV2StateStore || {
    async applyNode() {},
  };

  const transformed = source
    .replaceAll(
      "import.meta.env?.VITE_ATHENA_SYNC_DURABILITY_V2",
      JSON.stringify(String(api.durability ?? true))
    )
    .replace(
      'import { envIndexedDbName, getAppEnvironment } from "@/utils/appEnvironment";',
      "const envIndexedDbName = (value) => value; const getAppEnvironment = globalThis.__mutationQueueEnvironment;"
    )
    .replace(
      'import { getStoredAuthUser } from "@/utils/authUserStorage";',
      "const getStoredAuthUser = globalThis.__mutationQueueAuthUser;"
    )
    .replace(
      /import \{[\s\S]*?\} from "@\/utils\/security\/localCacheCrypto";/,
      "const encryptLocalCachePayload = globalThis.__mutationQueueEncrypt; const decryptLocalCachePayload = globalThis.__mutationQueueDecrypt;"
    )
    .replace(
      'import { syncV2Client } from "@/lib/communication/syncV2Client";',
      "const syncV2Client = globalThis.__mutationQueueClient;"
    )
    .replace(
      'import { syncV2StateStore } from "./syncV2StateStore";',
      "const syncV2StateStore = globalThis.__mutationQueueStore;"
    );
  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

function abortingIndexedDb() {
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const tx = {
        error: new Error("injected_abort"),
        objectStore() {
          return { put() {} };
        },
      };
      queueMicrotask(() => tx.onabort?.());
      return tx;
    },
  };
  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = db;
        request.onsuccess?.();
      });
      return request;
    },
  };
}

test("enqueue rejects when IndexedDB aborts instead of reporting durable success", async () => {
  const { syncMutationQueue } = await loadQueue({
    indexedDB: abortingIndexedDb(),
    syncV2Client: {},
  });
  await assert.rejects(
    syncMutationQueue.enqueue({
      mutationId: "abort-1",
      nodeKey: "users/7/profile",
      baseVersion: 1,
      operation: "merge",
      changedPaths: ["bio"],
      payload: { bio: "local" },
    }),
    /injected_abort/
  );
});

test("durability rollback switch keeps queue in memory", async () => {
  const { syncMutationQueue } = await loadQueue({
    durability: false,
    indexedDB: abortingIndexedDb(),
    syncV2Client: {},
  });
  await syncMutationQueue.enqueue({
    mutationId: "memory-only-1",
    nodeKey: "users/7/profile",
    baseVersion: 1,
    operation: "merge",
    changedPaths: ["bio"],
    payload: { bio: "local" },
  });

  assert.equal((await syncMutationQueue.list()).length, 1);
  assert.equal(syncMutationQueue.snapshot().durabilityEnabled, false);
});

test("offline same-node chain advances only after the previous mutation succeeds", async () => {
  const sentBaseVersions = [];
  let serverVersion = 5;
  const { syncMutationQueue } = await loadQueue({
    syncV2Client: {
      async mutate(mutation) {
        sentBaseVersions.push(mutation.baseVersion);
        assert.equal(mutation.baseVersion, serverVersion);
        serverVersion += 1;
        return {
          success: true,
          descriptor: {
            nodeKey: mutation.nodeKey,
            stateVersion: serverVersion,
          },
        };
      },
    },
  });
  const nodeKey = "users/7/preferences/chat.draft/thread%3Aws-a%3Athread-a";

  await syncMutationQueue.enqueue({
    mutationId: "draft-1",
    nodeKey,
    baseVersion: 5,
    operation: "merge",
    changedPaths: ["text"],
    payload: { text: "first" },
  });
  await syncMutationQueue.enqueue({
    mutationId: "draft-2",
    nodeKey,
    baseVersion: 5,
    operation: "merge",
    changedPaths: ["text"],
    payload: { text: "second" },
  });

  await syncMutationQueue.flush();

  assert.deepEqual(sentBaseVersions, [5, 6]);
  assert.equal((await syncMutationQueue.list()).length, 0);
  assert.equal(syncMutationQueue.snapshot().counters.rebasedAfterLocalApply, 1);
});

test("offline chain does not rebase after the first server conflict", async () => {
  const sentBaseVersions = [];
  const { syncMutationQueue } = await loadQueue({
    syncV2Client: {
      async mutate(mutation) {
        sentBaseVersions.push(mutation.baseVersion);
        const error = new Error("state_version_conflict");
        error.code = "state_version_conflict";
        error.raw = { error: "state_version_conflict" };
        throw error;
      },
    },
  });
  const nodeKey = "users/7/preferences/chat.draft/thread%3Aws-a%3Athread-a";

  await syncMutationQueue.enqueue({
    mutationId: "conflict-1",
    nodeKey,
    baseVersion: 5,
    operation: "merge",
    changedPaths: ["text"],
    payload: { text: "local" },
  });
  await syncMutationQueue.enqueue({
    mutationId: "conflict-2",
    nodeKey,
    baseVersion: 5,
    operation: "merge",
    changedPaths: ["text"],
    payload: { text: "newer local" },
  });

  await syncMutationQueue.flush();

  assert.deepEqual(sentBaseVersions, [5]);
  assert.equal(syncMutationQueue.snapshot().counters.rebasedAfterLocalApply, 0);
  assert.equal((await syncMutationQueue.list()).length, 2);
});
