import { syncV2Client } from "@/lib/communication/syncV2Client";
import { syncV2StateStore } from "./syncV2StateStore";
import { syncMutationQueue } from "./syncMutationQueue";
import { syncV2NodeArchive } from "./syncV2NodeArchive";

const HASH_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const LIVE_EVENT_BATCH_DELAY_MS = 25;
const MAX_NODE_BATCH_SIZE = 100;
let bootstrapPromise = null;
let bootstrapPromiseScope = null;
let enabled = false;
let bootstrappedScope = null;
let runtimeGeneration = 0;
let hashTimer = null;
let liveEventTimer = null;
let liveEventFlushRunning = false;
const liveEventQueue = [];
const runtimeMetrics = {
  sync_events_received: 0,
  sync_nodes_deduplicated: 0,
  sync_batch_get_requests: 0,
  sync_cursor_acks: 0,
  sync_locally_satisfied_events: 0,
};

function assertOwnerScope(expectedScope) {
  if (syncV2StateStore.ownerScope() === expectedScope) return;
  const error = new DOMException("Sync owner changed", "AbortError");
  error.code = "sync_v2_owner_scope_changed";
  throw error;
}

function assertGeneration(expectedGeneration) {
  if (runtimeGeneration === expectedGeneration) return;
  const error = new DOMException("Sync runtime reset", "AbortError");
  error.code = "sync_v2_runtime_reset";
  throw error;
}

function sortNodes(nodes = []) {
  const rank = (nodeKey = "") => {
    if (/\/workspaces\/index$/.test(nodeKey)) return 0;
    if (/^workspaces\/\d+\/metadata$/.test(nodeKey)) return 1;
    if (/\/threads\/index$/.test(nodeKey)) return 2;
    if (/^threads\/\d+\/metadata$/.test(nodeKey)) return 3;
    if (/^threads\/\d+\/messages$/.test(nodeKey)) return 4;
    return 5;
  };
  return [...nodes].sort(
    (left, right) =>
      rank(left?.descriptor?.nodeKey) - rank(right?.descriptor?.nodeKey)
  );
}

async function applyNodes(nodes = []) {
  return syncV2StateStore.applyNodesBatch(sortNodes(nodes));
}

async function persistAndApplyNodes(nodes = []) {
  if (!nodes.length) return { count: 0, payloadNodeKeys: new Set() };
  const persisted = await syncV2NodeArchive.storeMany(
    syncV2StateStore.ownerScope(),
    nodes
  );
  if (!persisted) {
    const error = new Error("sync_v2_node_archive_persist_failed");
    error.code = "sync_v2_node_archive_persist_failed";
    throw error;
  }
  const count = await applyNodes(nodes);
  return {
    count,
    payloadNodeKeys: new Set(
      nodes
        .filter((node) => node?.payload !== undefined && !node?.unchanged)
        .map((node) => node.descriptor?.nodeKey)
        .filter(Boolean)
    ),
  };
}

function deduplicateEvents(events = []) {
  const latestByNode = new Map();
  for (const event of events) {
    if (!event?.nodeKey) continue;
    const existing = latestByNode.get(event.nodeKey);
    if (
      !existing ||
      Number(event.stateVersion || 0) > Number(existing.stateVersion || 0) ||
      (Number(event.stateVersion || 0) === Number(existing.stateVersion || 0) &&
        Number(event.seq || 0) > Number(existing.seq || 0))
    ) {
      latestByNode.set(event.nodeKey, event);
    }
  }
  runtimeMetrics.sync_nodes_deduplicated += Math.max(
    0,
    events.length - latestByNode.size
  );
  return [...latestByNode.values()];
}

function requestsForEvents(events = []) {
  return deduplicateEvents(events)
    .filter((event) => {
      const known = syncV2StateStore.descriptor(event.nodeKey);
      if (!syncV2StateStore.hasPayload(event.nodeKey)) return true;
      if (Number(known?.stateVersion || 0) < Number(event.stateVersion || 0))
        return true;
      const hashMismatch = Boolean(
        known?.hash && event.hash && String(known.hash) !== String(event.hash)
      );
      if (!hashMismatch) runtimeMetrics.sync_locally_satisfied_events += 1;
      return hashMismatch;
    })
    .map((event) => {
      const known = syncV2StateStore.descriptor(event.nodeKey);
      const hasPayload = syncV2StateStore.hasPayload(event.nodeKey);
      return {
        nodeKey: event.nodeKey,
        knownVersion: hasPayload ? Number(known?.stateVersion || 0) : 0,
        knownHash: hasPayload ? known?.hash || null : null,
      };
    });
}

async function fetchAndApplyRequests(requests = [], signal = null) {
  if (!requests.length) return { count: 0, payloadNodeKeys: new Set() };
  const requestScope = syncV2StateStore.ownerScope();
  const requestGeneration = runtimeGeneration;
  const nodes = [];
  for (let index = 0; index < requests.length; index += MAX_NODE_BATCH_SIZE) {
    runtimeMetrics.sync_batch_get_requests += 1;
    const result = await syncV2Client.batchGet(
      requests.slice(index, index + MAX_NODE_BATCH_SIZE),
      { signal }
    );
    assertOwnerScope(requestScope);
    assertGeneration(requestGeneration);
    nodes.push(...(result?.nodes || []));
  }
  return persistAndApplyNodes(nodes);
}

async function acknowledgeCursor(cursor, signal = null) {
  if (!cursor) return;
  await syncV2Client.acknowledge(cursor, { signal });
  runtimeMetrics.sync_cursor_acks += 1;
}

async function fetchAndApplyNode(nodeKey, signal = null) {
  const known = syncV2StateStore.descriptor(nodeKey);
  return fetchAndApplyRequests(
    [
      {
        nodeKey,
        knownVersion: Number(known?.stateVersion || 0),
        knownHash: known?.hash || null,
      },
    ],
    signal
  );
}

async function replayEvents(after, signal = null) {
  let cursor = Math.max(0, Number(after) || 0);
  while (!signal?.aborted) {
    const page = await syncV2Client.events(cursor, { signal, limit: 200 });
    if (page?.requiresFullSync) return { requiresFullSync: true, cursor };
    const events = page?.events || [];
    runtimeMetrics.sync_events_received += events.length;
    await fetchAndApplyRequests(requestsForEvents(events), signal);
    const eventSeq = events.length
      ? Math.max(...events.map((event) => Number(event.seq) || 0))
      : cursor;
    cursor = syncV2StateStore.setCursor(page?.nextSeq || eventSeq || cursor);
    await acknowledgeCursor(cursor, signal);
    if (!page?.hasMore) break;
  }
  return { requiresFullSync: false, cursor };
}

async function fullReconcile(signal = null) {
  const fresh = await syncV2Client.manifest({ signal });
  const all = (fresh.nodes || [])
    .filter((descriptor) => descriptor.hydration !== "lazy")
    .map((descriptor) => ({
      nodeKey: descriptor.nodeKey,
      knownVersion: 0,
      knownHash: null,
    }));
  await fetchAndApplyRequests(all, signal);
  const pruned = await syncV2NodeArchive.prune(
    syncV2StateStore.ownerScope(),
    (fresh.nodes || []).map((descriptor) => descriptor.nodeKey)
  );
  if (!pruned) throw new Error("sync_v2_node_archive_prune_failed");
  syncV2StateStore.rememberManifest(fresh);
  const cursor = syncV2StateStore.setCursor(fresh.checkpointSeq || 0);
  await acknowledgeCursor(cursor, signal);
  return { requiresFullSync: false, cursor };
}

async function reconcileEvents(signal = null) {
  const replay = await replayEvents(syncV2StateStore.cursor(), signal);
  if (!replay.requiresFullSync) return replay;
  return fullReconcile(signal);
}

async function applySyncEvents(syncEvents = [], signal = null) {
  const events = syncEvents.filter((event) => event?.seq && event?.nodeKey);
  if (!events.length) return { processed: false, appliedNodeKeys: new Set() };
  runtimeMetrics.sync_events_received += events.length;
  const applied = await fetchAndApplyRequests(
    requestsForEvents(events),
    signal
  );
  const maxSeq = Math.max(...events.map((event) => Number(event.seq) || 0));
  const cursor = syncV2StateStore.setCursor(maxSeq);
  await acknowledgeCursor(cursor, signal);
  return { processed: true, appliedNodeKeys: applied.payloadNodeKeys };
}

function abortError() {
  return new DOMException("Sync event application aborted", "AbortError");
}

async function flushLiveEventQueue() {
  if (liveEventFlushRunning) return;
  if (liveEventTimer) {
    window.clearTimeout(liveEventTimer);
    liveEventTimer = null;
  }
  liveEventFlushRunning = true;
  try {
    while (liveEventQueue.length) {
      const batch = liveEventQueue.splice(0, MAX_NODE_BATCH_SIZE);
      const active = batch.filter((item) => !item.signal?.aborted);
      for (const item of batch) {
        if (item.signal?.aborted) item.reject(abortError());
      }
      if (!active.length) continue;
      try {
        const signal = active.find((item) => item.signal)?.signal || null;
        const result = await applySyncEvents(
          active.map((item) => item.event),
          signal
        );
        for (const item of active) {
          item.resolve({
            processed: result.processed,
            syncV2Applied: result.appliedNodeKeys.has(item.event.nodeKey),
          });
        }
      } catch (error) {
        for (const item of active) item.reject(error);
      }
    }
  } finally {
    liveEventFlushRunning = false;
    if (liveEventQueue.length) scheduleLiveEventFlush();
  }
}

function scheduleLiveEventFlush() {
  if (liveEventFlushRunning || liveEventTimer) return;
  if (liveEventQueue.length >= MAX_NODE_BATCH_SIZE) {
    queueMicrotask(() => void flushLiveEventQueue());
    return;
  }
  liveEventTimer = window.setTimeout(() => {
    liveEventTimer = null;
    void flushLiveEventQueue();
  }, LIVE_EVENT_BATCH_DELAY_MS);
}

function enqueueSyncEvent(syncEvent, signal = null) {
  if (!syncEvent?.seq || !syncEvent?.nodeKey) return Promise.resolve(false);
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    liveEventQueue.push({ event: syncEvent, signal, resolve, reject });
    scheduleLiveEventFlush();
  });
}

async function hashSample() {
  if (!enabled || document.visibilityState === "hidden") return;
  const descriptors = Object.values(syncV2StateStore.descriptors());
  if (!descriptors.length) return;
  const offset = Math.floor(Math.random() * descriptors.length);
  const sample = [...descriptors, ...descriptors]
    .slice(offset, offset + Math.min(5, descriptors.length))
    .map((descriptor) => {
      const hasPayload = syncV2StateStore.hasPayload(descriptor.nodeKey);
      return {
        nodeKey: descriptor.nodeKey,
        knownVersion: hasPayload ? descriptor.stateVersion : 0,
        knownHash: hasPayload ? descriptor.hash || null : null,
      };
    });
  const result = await syncV2Client.batchGet(sample);
  runtimeMetrics.sync_batch_get_requests += 1;
  await persistAndApplyNodes(result?.nodes || []);
}

function startHashChecks() {
  if (hashTimer) return;
  hashTimer = window.setInterval(() => {
    void hashSample().catch(() => null);
  }, HASH_CHECK_INTERVAL_MS);
}

function canUseCachedOffline(error) {
  const status = Number(error?.status || 0);
  if (status === 404 || status === 503) return false;
  const retryable =
    !status || status === 408 || status === 429 || status >= 500;
  return retryable && Object.keys(syncV2StateStore.descriptors()).length > 0;
}

export const syncV2Runtime = {
  async bootstrap({ signal = null } = {}) {
    if (String(import.meta.env?.VITE_SYNC_V2_ENABLED || "false") !== "true") {
      enabled = false;
      return { enabled: false, reason: "client_disabled" };
    }
    const requestedScope = syncV2StateStore.ownerScope();
    if (enabled && bootstrappedScope === requestedScope) {
      return { enabled: true, reused: true, cursor: syncV2StateStore.cursor() };
    }
    if (bootstrappedScope && bootstrappedScope !== requestedScope) {
      enabled = false;
    }
    if (bootstrapPromise) {
      if (bootstrapPromiseScope === requestedScope) return bootstrapPromise;
      try {
        await bootstrapPromise;
      } catch {}
      return this.bootstrap({ signal });
    }
    bootstrapPromiseScope = requestedScope;
    bootstrapPromise = (async () => {
      try {
        const cachedNodes = await syncV2NodeArchive.restore(requestedScope);
        assertOwnerScope(requestedScope);
        if (cachedNodes.length) await applyNodes(cachedNodes);
        const manifest = await syncV2Client.manifest({
          signal,
          manifestHash: syncV2StateStore.manifestHash(),
        });
        assertOwnerScope(requestedScope);
        const effectiveManifest =
          manifest.unchanged === true
            ? {
                ...manifest,
                nodes: Object.values(syncV2StateStore.descriptors()),
              }
            : manifest;
        const changed = syncV2StateStore.changedNodes(effectiveManifest);
        if (changed.length) {
          for (let index = 0; index < changed.length; index += 100) {
            await fetchAndApplyRequests(
              changed.slice(index, index + MAX_NODE_BATCH_SIZE),
              signal
            );
            assertOwnerScope(requestedScope);
          }
        }
        if (manifest.unchanged !== true) {
          const visibleNodeKeys = (manifest.nodes || []).map(
            (descriptor) => descriptor.nodeKey
          );
          const pruned = await syncV2NodeArchive.prune(
            syncV2StateStore.ownerScope(),
            visibleNodeKeys
          );
          if (!pruned) throw new Error("sync_v2_node_archive_prune_failed");
        }
        assertOwnerScope(requestedScope);
        // Manifest versions are only committed after every required payload is
        // durably archived and applied. A failed batch can therefore replay
        // from the last committed cursor without a false cache hit.
        syncV2StateStore.rememberManifest(manifest);
        const replay = await reconcileEvents(signal);
        enabled = true;
        bootstrappedScope = requestedScope;
        startHashChecks();
        void syncMutationQueue.flush().catch(() => null);
        return { enabled: true, ...replay };
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (canUseCachedOffline(error)) {
          enabled = true;
          bootstrappedScope = requestedScope;
          startHashChecks();
          void syncMutationQueue.flush().catch(() => null);
          return {
            enabled: true,
            offline: true,
            error: error?.code || error?.message,
          };
        }
        enabled = false;
        bootstrappedScope = null;
        return { enabled: false, error: error?.code || error?.message };
      }
    })().finally(() => {
      bootstrapPromise = null;
      bootstrapPromiseScope = null;
    });
    return bootstrapPromise;
  },

  async processBroadcastEvent(event = {}) {
    const syncEvent = event?.payload?.syncV2;
    if (!syncEvent) return false;
    return enqueueSyncEvent({
      ...syncEvent,
      originClientId:
        syncEvent.originClientId ||
        event.sourceClientId ||
        event.origin?.clientId,
      mutationId:
        syncEvent.mutationId || event.sourceActionId || event.origin?.actionId,
    });
  },

  async processEvent(syncEvent, { signal = null } = {}) {
    return enqueueSyncEvent(syncEvent, signal);
  },

  async reconcile({ signal = null } = {}) {
    if (!enabled) return { enabled: false, reason: "client_disabled" };
    return reconcileEvents(signal);
  },

  async refreshNode(nodeKey, { signal = null } = {}) {
    if (!enabled || !nodeKey) return false;
    await fetchAndApplyNode(nodeKey, signal);
    return true;
  },

  enabled() {
    return enabled;
  },

  reset() {
    runtimeGeneration += 1;
    enabled = false;
    bootstrappedScope = null;
    if (hashTimer) window.clearInterval(hashTimer);
    hashTimer = null;
    if (liveEventTimer) window.clearTimeout(liveEventTimer);
    liveEventTimer = null;
    const error = new DOMException("Sync runtime reset", "AbortError");
    while (liveEventQueue.length) liveEventQueue.shift()?.reject(error);
  },

  snapshot() {
    return {
      enabled,
      cursor: syncV2StateStore.cursor(),
      nodeCount: Object.keys(syncV2StateStore.descriptors()).length,
      queue: syncMutationQueue.snapshot(),
      metrics: {
        ...runtimeMetrics,
        ...syncV2StateStore.diagnostics(),
        ...syncV2NodeArchive.diagnostics(),
      },
    };
  },
};

export default syncV2Runtime;

if (typeof window !== "undefined") {
  window.addEventListener(
    "athena-sync-v2-durable-state-invalidated",
    (event) => {
      const scope = event?.detail?.ownerScope;
      if (!scope || scope !== syncV2StateStore.ownerScope()) return;
      syncV2NodeArchive.invalidate(scope);
      enabled = false;
      bootstrappedScope = null;
      void syncV2Runtime.bootstrap().catch(() => null);
    }
  );
}
