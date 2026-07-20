import { envIndexedDbName, getAppEnvironment } from "@/utils/appEnvironment";
import { getStoredAuthUser } from "@/utils/authUserStorage";
import {
  decryptLocalCachePayload,
  encryptLocalCachePayload,
} from "@/utils/security/localCacheCrypto";
import { syncV2Client } from "@/lib/communication/syncV2Client";
import { syncV2StateStore } from "./syncV2StateStore";

const DB_NAME = "athena-sync-v2-mutations";
const DB_VERSION = 1;
const STORE_NAME = "mutations";
const replayableNode =
  /^(?:users\/\d+\/profile|users\/\d+\/preferences\/[^/]+\/[^/]+|workspaces\/\d+\/metadata|threads\/\d+\/metadata)$/;
const memoryQueue = new Map();
let flushing = null;
const counters = {
  queued: 0,
  applied: 0,
  failed: 0,
  conflicts: 0,
  rebasedAfterLocalApply: 0,
};

function durabilityEnabled() {
  return (
    String(
      import.meta.env?.VITE_ATHENA_SYNC_DURABILITY_V2 || "true"
    ).toLowerCase() !== "false"
  );
}

function shouldQueueTransportFailure(error) {
  const status = Number(error?.status || 0);
  if (!status) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isStateVersionConflict(error) {
  return (
    error?.code === "state_version_conflict" ||
    error?.raw?.error === "state_version_conflict"
  );
}

async function rememberAppliedDescriptor(result) {
  if (!result?.descriptor?.nodeKey) return;
  await syncV2StateStore.applyNode({
    descriptor: result.descriptor,
    ...(result.projection === undefined
      ? { unchanged: true }
      : { payload: result.projection, unchanged: false }),
  });
}

function currentUserScope() {
  const user = getStoredAuthUser();
  return [
    getAppEnvironment(),
    user?.authUserId || user?.id || user?.username || "anonymous",
  ].join(":");
}

function namespace(id) {
  return `sync-v2-mutation:${currentUserScope()}:${id}`;
}

async function sealMutation(id, mutation) {
  const encryptedPayload = await encryptLocalCachePayload({
    namespace: namespace(id),
    payload: mutation,
  });
  if (!encryptedPayload?.encrypted) {
    const error = new Error("sync_v2_encrypted_queue_unavailable");
    error.code = "sync_v2_encrypted_queue_unavailable";
    throw error;
  }
  return encryptedPayload;
}

function openDb() {
  if (!durabilityEnabled()) return Promise.resolve(null);
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(envIndexedDbName(DB_NAME), DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("userScope", "userScope", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("sync_v2_mutation_db_open_failed"));
    request.onblocked = () =>
      reject(new Error("sync_v2_mutation_db_open_blocked"));
  });
}

async function allRecords() {
  const db = await openDb();
  if (!db)
    return [...memoryQueue.values()].filter(
      (record) => record.userScope === currentUserScope()
    );
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .getAll();
    request.onsuccess = () =>
      resolve(
        (request.result || []).filter(
          (record) => record.userScope === currentUserScope()
        )
      );
    request.onerror = () =>
      reject(request.error || new Error("sync_v2_mutation_read_failed"));
  });
}

async function putRecord(record) {
  if (typeof indexedDB === "undefined") {
    memoryQueue.set(record.id, record);
    return true;
  }
  const db = await openDb();
  if (!db) {
    memoryQueue.set(record.id, record);
    return true;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () =>
      reject(tx.error || new Error("sync_v2_mutation_write_failed"));
    tx.onabort = () =>
      reject(tx.error || new Error("sync_v2_mutation_write_aborted"));
  });
}

async function deleteRecord(id) {
  if (typeof indexedDB === "undefined") return memoryQueue.delete(id);
  const db = await openDb();
  if (!db) return memoryQueue.delete(id);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () =>
      reject(tx.error || new Error("sync_v2_mutation_delete_failed"));
    tx.onabort = () =>
      reject(tx.error || new Error("sync_v2_mutation_delete_aborted"));
  });
}

async function deleteRecordsForScope(userScope) {
  if (!userScope) return;
  const db = await openDb();
  if (!db) {
    for (const [id, record] of memoryQueue.entries()) {
      if (record.userScope === userScope) memoryQueue.delete(id);
    }
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store
      .index("userScope")
      .openCursor(IDBKeyRange.only(userScope));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () =>
      reject(tx.error || new Error("sync_v2_mutation_scope_delete_failed"));
    tx.onabort = () =>
      reject(tx.error || new Error("sync_v2_mutation_scope_delete_aborted"));
  });
}

async function replaceRecord(oldId, record) {
  if (typeof indexedDB === "undefined") {
    memoryQueue.set(record.id, record);
    memoryQueue.delete(oldId);
    return true;
  }
  const db = await openDb();
  if (!db) {
    memoryQueue.set(record.id, record);
    memoryQueue.delete(oldId);
    return true;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(record);
    store.delete(oldId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () =>
      reject(tx.error || new Error("sync_v2_mutation_replace_failed"));
    tx.onabort = () =>
      reject(tx.error || new Error("sync_v2_mutation_replace_aborted"));
  });
}

async function unseal(record) {
  try {
    return await decryptLocalCachePayload({
      namespace: namespace(record.id),
      encryptedPayload: record.encryptedPayload,
    });
  } catch {
    return null;
  }
}

function assertReplayable(mutation) {
  if (!replayableNode.test(String(mutation?.nodeKey || ""))) {
    const error = new Error("sync_v2_offline_replay_forbidden");
    error.code = "sync_v2_offline_replay_forbidden";
    throw error;
  }
  if (
    !["merge", "replace", "delete", "set-add", "set-remove"].includes(
      mutation.operation
    )
  ) {
    const error = new Error("sync_v2_offline_operation_forbidden");
    error.code = "sync_v2_offline_operation_forbidden";
    throw error;
  }
}

async function pendingMutations() {
  const results = [];
  for (const record of await allRecords()) {
    const mutation = await unseal(record);
    if (!mutation) continue;
    results.push({ record, mutation });
  }
  return results.sort((a, b) => a.record.createdAt - b.record.createdAt);
}

export const syncMutationQueue = {
  async enqueue(mutation) {
    assertReplayable(mutation);
    const normalized = {
      ...mutation,
      mutationId: mutation.mutationId || crypto.randomUUID(),
      dirty: true,
    };
    const id = normalized.mutationId;
    const encryptedPayload = await sealMutation(id, normalized);
    await putRecord({
      id,
      userScope: currentUserScope(),
      createdAt: Date.now(),
      attempts: 0,
      status: "pending",
      encryptedPayload,
    });
    counters.queued += 1;
    return normalized;
  },

  async submit(mutation, { allowOffline = true, signal = null } = {}) {
    assertReplayable(mutation);
    try {
      const result = await syncV2Client.mutate(mutation, { signal });
      await rememberAppliedDescriptor(result);
      return result;
    } catch (error) {
      if (isStateVersionConflict(error)) {
        const queued = await this.enqueue(mutation);
        const record = (await allRecords()).find(
          (candidate) => candidate.id === queued.mutationId
        );
        if (record) {
          await putRecord({
            ...record,
            status: "conflict",
            lastError: error?.raw?.error || "state_version_conflict",
            conflictCurrent: error?.raw?.current || null,
            requiresFullSync: error?.raw?.requiresFullSync === true,
            conflictReason: error?.raw?.conflictReason || null,
            lastAttemptAt: Date.now(),
          });
        }
        counters.conflicts += 1;
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("athena-sync-v2-conflict", {
              detail: {
                mutationId: queued.mutationId,
                nodeKey: mutation.nodeKey,
                current: error?.raw?.current || null,
                requiresFullSync: error?.raw?.requiresFullSync === true,
                conflictReason: error?.raw?.conflictReason || null,
              },
            })
          );
        }
        throw error;
      }
      if (!allowOffline || !shouldQueueTransportFailure(error)) throw error;
      const queued = await this.enqueue(mutation);
      return { success: true, queued: true, mutationId: queued.mutationId };
    }
  },

  async flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const grouped = new Map();
      for (const item of await pendingMutations()) {
        if (item.record.status !== "pending") continue;
        if (!grouped.has(item.mutation.nodeKey))
          grouped.set(item.mutation.nodeKey, []);
        grouped.get(item.mutation.nodeKey).push(item);
      }
      await Promise.all(
        [...grouped.values()].map(async (items) => {
          let previousOriginalBaseVersion = null;
          let previousResultVersion = null;
          for (const item of items) {
            try {
              const originalBaseVersion = Number(
                item.mutation.baseVersion || 0
              );
              const canAdvanceLocalChain =
                previousResultVersion !== null &&
                originalBaseVersion === previousOriginalBaseVersion;
              const outboundMutation = canAdvanceLocalChain
                ? {
                    ...item.mutation,
                    baseVersion: previousResultVersion,
                  }
                : item.mutation;
              if (canAdvanceLocalChain) counters.rebasedAfterLocalApply += 1;
              const result = await syncV2Client.mutate(outboundMutation);
              if (!result?.success)
                throw Object.assign(new Error(result?.error), result);
              await rememberAppliedDescriptor(result);
              await deleteRecord(item.record.id);
              counters.applied += 1;
              previousOriginalBaseVersion = originalBaseVersion;
              previousResultVersion = Number(
                result.descriptor?.stateVersion ?? outboundMutation.baseVersion
              );
            } catch (error) {
              const conflict = isStateVersionConflict(error);
              const terminal = !conflict && !shouldQueueTransportFailure(error);
              await putRecord({
                ...item.record,
                attempts: Number(item.record.attempts || 0) + 1,
                status: conflict ? "conflict" : terminal ? "failed" : "pending",
                lastError: error?.code || error?.message || "sync_failed",
                conflictCurrent: conflict ? error?.raw?.current || null : null,
                requiresFullSync:
                  conflict && error?.raw?.requiresFullSync === true,
                conflictReason: conflict
                  ? error?.raw?.conflictReason || null
                  : null,
                lastAttemptAt: Date.now(),
              });
              if (conflict) counters.conflicts += 1;
              else counters.failed += 1;
              if (conflict && typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("athena-sync-v2-conflict", {
                    detail: {
                      mutationId: item.record.id,
                      nodeKey: item.mutation.nodeKey,
                      current: error?.raw?.current || null,
                      requiresFullSync: error?.raw?.requiresFullSync === true,
                      conflictReason: error?.raw?.conflictReason || null,
                    },
                  })
                );
              }
              break;
            }
          }
        })
      );
      return this.list();
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  },

  async list() {
    return (await pendingMutations()).map(({ record, mutation }) => ({
      mutation,
      status: record.status,
      attempts: record.attempts || 0,
      lastError: record.lastError || null,
      current: record.conflictCurrent || null,
      requiresFullSync: record.requiresFullSync === true,
      conflictReason: record.conflictReason || null,
      createdAt: record.createdAt,
    }));
  },

  async discard(mutationId) {
    return deleteRecord(mutationId);
  },

  async clearCurrentScope(userScope = currentUserScope()) {
    await deleteRecordsForScope(userScope);
  },

  async retry(mutationId, updates = {}) {
    const record = (await allRecords()).find(
      (candidate) => candidate.id === mutationId
    );
    if (!record) return { success: false, error: "mutation_not_found" };
    const mutation = await unseal(record);
    if (!mutation) return { success: false, error: "mutation_unreadable" };
    const nextMutationId = crypto.randomUUID();
    const nextMutation = {
      ...mutation,
      ...updates,
      mutationId: nextMutationId,
      dirty: true,
    };
    assertReplayable(nextMutation);
    const encryptedPayload = await sealMutation(nextMutationId, nextMutation);
    await replaceRecord(mutationId, {
      ...record,
      id: nextMutationId,
      status: "pending",
      lastError: null,
      conflictCurrent: null,
      requiresFullSync: false,
      conflictReason: null,
      encryptedPayload,
    });
    return this.flush();
  },

  snapshot() {
    return {
      durabilityEnabled: durabilityEnabled(),
      flushing: Boolean(flushing),
      counters: { ...counters },
    };
  },
};

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    void syncMutationQueue.flush().catch(() => null);
  });
}

export default syncMutationQueue;
