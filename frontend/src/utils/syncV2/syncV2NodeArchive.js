import { envIndexedDbName } from "@/utils/appEnvironment";
import {
  decryptLocalCachePayload,
  encryptLocalCachePayload,
} from "@/utils/security/localCacheCrypto";

const DB_NAME = "athena-sync-v2-node-archive";
const DB_VERSION = 2;
const STORE_NAME = "archives";
const ARCHIVE_VERSION = 2;
const LEGACY_ARCHIVE_VERSION = 1;
const memoryShards = new Map();
const loadedOwners = new Set();
let archiveWrites = 0;
let archiveShardWrites = 0;
let legacyMigrations = 0;

function durabilityEnabled() {
  return (
    String(
      import.meta.env?.VITE_ATHENA_SYNC_DURABILITY_V2 || "true"
    ).toLowerCase() !== "false"
  );
}

// These nodes are safe stale-while-revalidate projections. Security,
// entitlements and integration payloads deliberately remain memory-only and
// must be revalidated before they can affect authority decisions.
function canPersistNode(nodeKey = "") {
  return (
    /^users\/\d+\/profile$/.test(nodeKey) ||
    /^users\/\d+\/preferences\/[^/]+\/[^/]+$/.test(nodeKey) ||
    /^users\/\d+\/workspaces\/index$/.test(nodeKey) ||
    /^workspaces\/\d+\/(metadata|threads\/index)$/.test(nodeKey) ||
    /^threads\/\d+\/metadata$/.test(nodeKey)
  );
}

function shardForNode(nodeKey = "", node = null) {
  if (/^users\/\d+\/profile$/.test(nodeKey)) return "user:profile";
  if (/^users\/\d+\/preferences\//.test(nodeKey)) return "user:preferences";
  if (/^users\/\d+\/workspaces\/index$/.test(nodeKey)) return "user:navigation";
  let match = nodeKey.match(/^workspaces\/(\d+)\//);
  if (match) return `workspace:${match[1]}`;
  match = nodeKey.match(/^threads\/(\d+)\/metadata$/);
  if (match) {
    const workspaceId = Number(
      node?.payload?.workspace_id || node?.payload?.workspaceId || 0
    );
    return workspaceId > 0 ? `workspace:${workspaceId}` : `thread:${match[1]}`;
  }
  return null;
}

function archiveNamespace(ownerScope, shardKey, version = ARCHIVE_VERSION) {
  if (Number(version) === LEGACY_ARCHIVE_VERSION)
    return `sync-v2-node-archive:${ownerScope}:v${LEGACY_ARCHIVE_VERSION}`;
  return `sync-v2-node-archive:${ownerScope}:${shardKey}:v${ARCHIVE_VERSION}`;
}

function archiveRecordKey(ownerScope, shardKey) {
  return `${ownerScope}::${shardKey}`;
}

function memoryKey(ownerScope, shardKey) {
  return archiveRecordKey(ownerScope, shardKey);
}

function emptyArchive(shardKey) {
  return {
    version: ARCHIVE_VERSION,
    shardKey,
    nodes: {},
    updatedAt: 0,
  };
}

function openDb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(envIndexedDbName(DB_NAME), DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: "ownerScope" });
      if (!store.indexNames.contains("baseOwnerScope")) {
        store.createIndex("baseOwnerScope", "baseOwnerScope", {
          unique: false,
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("sync_v2_archive_db_open_failed"));
    request.onblocked = () =>
      reject(new Error("sync_v2_archive_db_open_blocked"));
  });
}

async function readOwnerRecords(ownerScope) {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const store = db
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME);
    const canUseIndex =
      store.indexNames?.contains?.("baseOwnerScope") &&
      typeof IDBKeyRange !== "undefined";
    const request = canUseIndex
      ? store.index("baseOwnerScope").getAll(IDBKeyRange.only(ownerScope))
      : store.getAll();
    request.onsuccess = () => {
      const sharded = (request.result || []).filter(
        (record) => record.baseOwnerScope === ownerScope
      );
      const legacyRequest = store.get(ownerScope);
      legacyRequest.onsuccess = () =>
        resolve([
          ...sharded,
          ...(legacyRequest.result ? [legacyRequest.result] : []),
        ]);
      legacyRequest.onerror = () =>
        reject(
          legacyRequest.error || new Error("sync_v2_archive_legacy_read_failed")
        );
    };
    request.onerror = () =>
      reject(request.error || new Error("sync_v2_archive_read_failed"));
  });
}

async function replaceRecords({ puts = [], deletes = [] } = {}) {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const record of puts) store.put(record);
    for (const key of deletes) store.delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () =>
      reject(tx.error || new Error("sync_v2_archive_write_failed"));
    tx.onabort = () =>
      reject(tx.error || new Error("sync_v2_archive_write_aborted"));
  });
}

async function unseal(ownerScope, record) {
  if (!record?.encryptedPayload?.encrypted) return null;
  const version = Number(record.version || LEGACY_ARCHIVE_VERSION);
  const shardKey = record.shardKey || null;
  try {
    const archive = await decryptLocalCachePayload({
      namespace: archiveNamespace(ownerScope, shardKey, version),
      encryptedPayload: record.encryptedPayload,
    });
    if (
      ![LEGACY_ARCHIVE_VERSION, ARCHIVE_VERSION].includes(
        Number(archive?.version)
      )
    )
      return null;
    return archive;
  } catch {
    return null;
  }
}

function partitionNodes(nodes = {}) {
  const shards = new Map();
  for (const [nodeKey, node] of Object.entries(nodes || {})) {
    const shardKey = shardForNode(nodeKey, node);
    if (!shardKey) continue;
    if (!shards.has(shardKey)) shards.set(shardKey, {});
    shards.get(shardKey)[nodeKey] = node;
  }
  return shards;
}

async function sealShard(ownerScope, shardKey, archive) {
  const encryptedPayload = await encryptLocalCachePayload({
    namespace: archiveNamespace(ownerScope, shardKey),
    payload: archive,
  });
  if (!encryptedPayload?.encrypted) {
    throw new Error("sync_v2_archive_encryption_unavailable");
  }
  return {
    ownerScope: archiveRecordKey(ownerScope, shardKey),
    baseOwnerScope: ownerScope,
    shardKey,
    version: ARCHIVE_VERSION,
    updatedAt: archive.updatedAt,
    encryptedPayload,
  };
}

async function persistArchives(ownerScope, archives, deleteKeys = []) {
  const entries = [...archives.entries()];
  const puts = new Array(entries.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length) {
        const index = next;
        next += 1;
        const [shardKey, archive] = entries[index];
        puts[index] = await sealShard(ownerScope, shardKey, archive);
      }
    })
  );
  const persisted = await replaceRecords({ puts, deletes: deleteKeys });
  if (persisted) {
    archiveWrites += 1;
    archiveShardWrites += puts.length;
  }
  return persisted;
}

function ownerMemoryEntries(ownerScope) {
  const prefix = `${ownerScope}::`;
  return [...memoryShards.entries()].filter(([key]) => key.startsWith(prefix));
}

async function ensureOwnerLoaded(ownerScope) {
  if (loadedOwners.has(ownerScope)) return;
  const records = await readOwnerRecords(ownerScope);
  let legacyArchive = null;
  for (const record of records) {
    const archive = await unseal(ownerScope, record);
    if (!archive) continue;
    if (Number(archive.version) === LEGACY_ARCHIVE_VERSION) {
      legacyArchive = archive;
      continue;
    }
    const shardKey = record.shardKey || archive.shardKey;
    if (!shardKey) continue;
    memoryShards.set(memoryKey(ownerScope, shardKey), archive);
  }

  if (legacyArchive) {
    const legacyShards = partitionNodes(legacyArchive.nodes || {});
    const migration = new Map();
    for (const [shardKey, nodes] of legacyShards.entries()) {
      const existing =
        memoryShards.get(memoryKey(ownerScope, shardKey)) ||
        emptyArchive(shardKey);
      const archive = {
        version: ARCHIVE_VERSION,
        shardKey,
        nodes: { ...nodes, ...(existing.nodes || {}) },
        updatedAt: Math.max(
          Number(legacyArchive.updatedAt || 0),
          Number(existing.updatedAt || 0),
          Date.now()
        ),
      };
      migration.set(shardKey, archive);
    }
    try {
      if (await persistArchives(ownerScope, migration, [ownerScope])) {
        for (const [shardKey, archive] of migration.entries()) {
          memoryShards.set(memoryKey(ownerScope, shardKey), archive);
        }
        legacyMigrations += 1;
      }
    } catch {
      for (const [shardKey, archive] of migration.entries()) {
        if (!memoryShards.has(memoryKey(ownerScope, shardKey)))
          memoryShards.set(memoryKey(ownerScope, shardKey), archive);
      }
    }
  }
  loadedOwners.add(ownerScope);
}

export const syncV2NodeArchive = {
  async restore(ownerScope) {
    if (!ownerScope || !durabilityEnabled()) return [];
    await ensureOwnerLoaded(ownerScope);
    return ownerMemoryEntries(ownerScope).flatMap(([, archive]) =>
      Object.values(archive.nodes || {}).filter(
        (node) => node?.descriptor?.nodeKey && node.payload !== undefined
      )
    );
  },

  async storeMany(ownerScope, nodes = [], { retainNodeKeys = null } = {}) {
    if (!ownerScope) return false;
    if (!durabilityEnabled()) return true;
    try {
      await ensureOwnerLoaded(ownerScope);
      const drafts = new Map();
      const changedShards = new Set();
      const draftFor = (shardKey) => {
        if (!drafts.has(shardKey)) {
          const previous =
            memoryShards.get(memoryKey(ownerScope, shardKey)) ||
            emptyArchive(shardKey);
          drafts.set(shardKey, {
            version: ARCHIVE_VERSION,
            shardKey,
            nodes: { ...(previous.nodes || {}) },
            updatedAt: previous.updatedAt || 0,
          });
        }
        return drafts.get(shardKey);
      };

      if (retainNodeKeys) {
        const allowed = new Set(retainNodeKeys);
        for (const [, archive] of ownerMemoryEntries(ownerScope)) {
          const draft = draftFor(archive.shardKey);
          for (const nodeKey of Object.keys(draft.nodes)) {
            if (allowed.has(nodeKey)) continue;
            delete draft.nodes[nodeKey];
            changedShards.add(archive.shardKey);
          }
        }
      }

      for (const node of nodes) {
        const nodeKey = node?.descriptor?.nodeKey;
        if (!nodeKey || !canPersistNode(nodeKey)) continue;
        const existingShard = ownerMemoryEntries(ownerScope).find(
          ([, archive]) => archive.nodes?.[nodeKey]
        )?.[1]?.shardKey;
        const shardKey = existingShard || shardForNode(nodeKey, node);
        if (!shardKey) continue;
        const draft = draftFor(shardKey);
        if (node.descriptor.deletedAt) {
          if (draft.nodes[nodeKey]) {
            delete draft.nodes[nodeKey];
            changedShards.add(shardKey);
          }
          continue;
        }
        if (node.payload === undefined) continue;
        const prior = draft.nodes[nodeKey];
        if (
          Number(prior?.descriptor?.stateVersion || 0) ===
            Number(node.descriptor.stateVersion || 0) &&
          String(prior?.descriptor?.hash || "") ===
            String(node.descriptor.hash || "")
        ) {
          continue;
        }
        draft.nodes[nodeKey] = {
          descriptor: node.descriptor,
          payload: node.payload,
        };
        changedShards.add(shardKey);
      }
      if (!changedShards.size) return true;

      const archives = new Map();
      const deletes = [];
      for (const shardKey of changedShards) {
        const archive = draftFor(shardKey);
        if (!Object.keys(archive.nodes).length) {
          deletes.push(archiveRecordKey(ownerScope, shardKey));
          continue;
        }
        archive.updatedAt = Date.now();
        archives.set(shardKey, archive);
      }
      const persisted = await persistArchives(ownerScope, archives, deletes);
      if (!persisted) return false;
      for (const shardKey of changedShards) {
        const archive = archives.get(shardKey);
        if (archive) memoryShards.set(memoryKey(ownerScope, shardKey), archive);
        else memoryShards.delete(memoryKey(ownerScope, shardKey));
      }
      return true;
    } catch {
      return false;
    }
  },

  async prune(ownerScope, allowedNodeKeys = []) {
    return this.storeMany(ownerScope, [], { retainNodeKeys: allowedNodeKeys });
  },

  async clear(ownerScope) {
    if (!ownerScope) return false;
    try {
      const records = await readOwnerRecords(ownerScope);
      const keys = records.map((record) => record.ownerScope).filter(Boolean);
      if (keys.length) await replaceRecords({ deletes: keys });
      for (const [key] of ownerMemoryEntries(ownerScope))
        memoryShards.delete(key);
      loadedOwners.delete(ownerScope);
      return true;
    } catch {
      return false;
    }
  },

  invalidate(ownerScope) {
    if (!ownerScope) return;
    for (const [key] of ownerMemoryEntries(ownerScope))
      memoryShards.delete(key);
    loadedOwners.delete(ownerScope);
  },

  diagnostics() {
    return {
      sync_node_archive_writes: archiveWrites,
      sync_node_archive_shard_writes: archiveShardWrites,
      sync_node_archive_shards_loaded: memoryShards.size,
      sync_node_archive_legacy_migrations: legacyMigrations,
      sync_durability_v2_enabled: durabilityEnabled(),
    };
  },
};

export const __test = { archiveRecordKey, canPersistNode, shardForNode };

export default syncV2NodeArchive;
