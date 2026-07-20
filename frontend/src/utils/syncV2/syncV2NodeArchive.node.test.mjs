import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrl = new URL("./syncV2NodeArchive.js", import.meta.url);

function fakeIndexedDb() {
  const records = new Map();
  let failNextWrite = false;
  const indexNames = { contains: () => false };
  const store = (tx) => ({
    indexNames,
    getAll() {
      const request = {};
      queueMicrotask(() => {
        request.result = [...records.values()];
        request.onsuccess?.();
      });
      return request;
    },
    get(key) {
      const request = {};
      queueMicrotask(() => {
        request.result = records.get(key) || null;
        request.onsuccess?.();
      });
      return request;
    },
    put(record) {
      tx.operations.push(() => records.set(record.ownerScope, record));
    },
    delete(key) {
      tx.operations.push(() => records.delete(key));
    },
  });
  const db = {
    objectStoreNames: { contains: () => true },
    transaction(_name, mode) {
      const tx = {
        error: null,
        operations: [],
        objectStore() {
          return store(tx);
        },
      };
      if (mode === "readwrite") {
        queueMicrotask(() => {
          if (failNextWrite) {
            failNextWrite = false;
            tx.error = new Error("injected_write_failure");
            tx.onabort?.();
            return;
          }
          for (const operation of tx.operations) operation();
          tx.oncomplete?.();
        });
      }
      return tx;
    },
  };
  return {
    indexedDB: {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = db;
          request.onsuccess?.();
        });
        return request;
      },
    },
    failNextWrite() {
      failNextWrite = true;
    },
    records,
    seed(record) {
      records.set(record.ownerScope, record);
    },
  };
}

async function loadArchive(fake, { durability = true } = {}) {
  const source = await readFile(moduleUrl, "utf8");
  globalThis.indexedDB = fake.indexedDB;
  globalThis.__archiveEncrypt = async ({ payload }) => ({
    encrypted: true,
    payload,
  });
  globalThis.__archiveDecrypt = async ({ encryptedPayload }) =>
    encryptedPayload.payload;
  const transformed = source
    .replaceAll(
      "import.meta.env?.VITE_ATHENA_SYNC_DURABILITY_V2",
      JSON.stringify(String(durability))
    )
    .replace(
      'import { envIndexedDbName } from "@/utils/appEnvironment";',
      "const envIndexedDbName = (value) => value;"
    )
    .replace(
      /import \{[\s\S]*?\} from "@\/utils\/security\/localCacheCrypto";/,
      "const encryptLocalCachePayload = globalThis.__archiveEncrypt; const decryptLocalCachePayload = globalThis.__archiveDecrypt;"
    );
  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

function node(nodeKey, version, payload) {
  return {
    descriptor: { nodeKey, stateVersion: version, hash: `v${version}` },
    payload,
  };
}

test("failed sharded archive transaction does not advance memory", async () => {
  const fake = fakeIndexedDb();
  const { syncV2NodeArchive } = await loadArchive(fake);
  const nodeKey = "users/7/profile";

  assert.equal(
    await syncV2NodeArchive.storeMany("owner", [
      node(nodeKey, 1, { displayName: "before" }),
    ]),
    true
  );
  fake.failNextWrite();
  assert.equal(
    await syncV2NodeArchive.storeMany("owner", [
      node(nodeKey, 2, { displayName: "after" }),
    ]),
    false
  );

  const restored = await syncV2NodeArchive.restore("owner");
  assert.equal(restored[0].descriptor.stateVersion, 1);
  assert.equal(restored[0].payload.displayName, "before");
});

test("updates only the changed domain shard", async () => {
  const fake = fakeIndexedDb();
  const { syncV2NodeArchive } = await loadArchive(fake);
  await syncV2NodeArchive.storeMany("owner-sharded", [
    node("users/7/profile", 1, { displayName: "Athena" }),
    node("workspaces/9/metadata", 1, { id: 9, slug: "workspace-9" }),
  ]);
  assert.equal(fake.records.size, 2);
  assert.equal(
    syncV2NodeArchive.diagnostics().sync_node_archive_shard_writes,
    2
  );

  await syncV2NodeArchive.storeMany("owner-sharded", [
    node("users/7/profile", 2, { displayName: "Athena 2" }),
  ]);
  const diagnostics = syncV2NodeArchive.diagnostics();
  assert.equal(diagnostics.sync_node_archive_writes, 2);
  assert.equal(diagnostics.sync_node_archive_shard_writes, 3);
  assert.equal(fake.records.size, 2);
});

test("migrates a legacy owner-wide archive without losing nodes", async () => {
  const fake = fakeIndexedDb();
  fake.seed({
    ownerScope: "legacy-owner",
    version: 1,
    encryptedPayload: {
      encrypted: true,
      payload: {
        version: 1,
        updatedAt: 100,
        nodes: {
          "users/7/profile": node("users/7/profile", 1, {
            displayName: "Legacy",
          }),
          "workspaces/9/metadata": node("workspaces/9/metadata", 1, {
            id: 9,
          }),
        },
      },
    },
  });
  const { syncV2NodeArchive } = await loadArchive(fake);
  const restored = await syncV2NodeArchive.restore("legacy-owner");

  assert.equal(restored.length, 2);
  assert.equal(fake.records.has("legacy-owner"), false);
  assert.equal(fake.records.has("legacy-owner::user:profile"), true);
  assert.equal(fake.records.has("legacy-owner::workspace:9"), true);
  assert.equal(
    syncV2NodeArchive.diagnostics().sync_node_archive_legacy_migrations,
    1
  );
});

test("prune deletes an empty shard and keeps allowed nodes", async () => {
  const fake = fakeIndexedDb();
  const { syncV2NodeArchive } = await loadArchive(fake);
  await syncV2NodeArchive.storeMany("owner-prune", [
    node("users/7/profile", 1, { displayName: "Athena" }),
    node("workspaces/9/metadata", 1, { id: 9 }),
  ]);
  await syncV2NodeArchive.prune("owner-prune", ["users/7/profile"]);

  assert.equal(fake.records.has("owner-prune::user:profile"), true);
  assert.equal(fake.records.has("owner-prune::workspace:9"), false);
  assert.deepEqual(
    (await syncV2NodeArchive.restore("owner-prune")).map(
      (entry) => entry.descriptor.nodeKey
    ),
    ["users/7/profile"]
  );
});

test("durability rollback switch bypasses archive persistence", async () => {
  const fake = fakeIndexedDb();
  const { syncV2NodeArchive } = await loadArchive(fake, { durability: false });
  fake.failNextWrite();

  assert.equal(
    await syncV2NodeArchive.storeMany("owner-disabled", [
      node("users/7/profile", 1, { displayName: "not-persisted" }),
    ]),
    true
  );
  assert.deepEqual(await syncV2NodeArchive.restore("owner-disabled"), []);
});
