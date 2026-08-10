import { getAppEnvironment } from "@/utils/appEnvironment";
import { getStoredAuthUser } from "@/utils/authUserStorage";
import { workspaceNavigationStore } from "@/utils/serverState/workspaceNavigationStore";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { threadHistoryCache } from "@/utils/chat/threadHistoryCache";
import { serverStateCache } from "@/utils/serverState/serverStateCache";

const STORAGE_VERSION = 2;
let descriptorCacheScope = null;
let descriptorCache = null;
let descriptorBatchDepth = 0;
let descriptorBatchDirty = false;
let descriptorCommits = 0;
let payloadCacheScope = null;
let payloadAvailableKeys = new Set();

function ownerScope() {
  const user = getStoredAuthUser();
  return [
    getAppEnvironment(),
    user?.authUserId || user?.id || user?.username || "anonymous",
  ].join(":");
}

function storageKey(kind) {
  return `athena-sync-v2:${STORAGE_VERSION}:${ownerScope()}:${kind}`;
}

function readJson(kind, fallback) {
  try {
    return (
      JSON.parse(window.localStorage.getItem(storageKey(kind))) ?? fallback
    );
  } catch {
    return fallback;
  }
}

function writeJson(kind, value) {
  try {
    window.localStorage.setItem(storageKey(kind), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function workspaceForId(workspaceId) {
  return (
    workspaceNavigationStore.getWorkspaces({ allowStale: true }) || []
  ).find((workspace) => Number(workspace.id) === Number(workspaceId));
}

function locationForThreadId(threadId) {
  const workspaces =
    workspaceNavigationStore.getWorkspaces({ allowStale: true }) || [];
  for (const workspace of workspaces) {
    const thread = (
      workspaceNavigationStore.getThreads(workspace.slug, {
        allowStale: true,
      }) || []
    ).find((item) => Number(item.id) === Number(threadId));
    if (thread) return { workspace, thread };
  }
  return null;
}

function descriptorMap() {
  const scope = ownerScope();
  if (descriptorCacheScope !== scope || !descriptorCache) {
    descriptorCacheScope = scope;
    descriptorCache = readJson("descriptors", {});
  }
  return descriptorCache;
}

function payloadKeys() {
  const scope = ownerScope();
  if (payloadCacheScope !== scope) {
    payloadCacheScope = scope;
    payloadAvailableKeys = new Set();
  }
  return payloadAvailableKeys;
}

function setDescriptor(descriptor) {
  if (!descriptor?.nodeKey) return;
  const descriptors = descriptorMap();
  descriptors[descriptor.nodeKey] = descriptor;
  descriptorBatchDirty = true;
  if (descriptorBatchDepth > 0) return;
  commitDescriptors(descriptors);
}

function commitDescriptors(descriptors = descriptorMap()) {
  if (!descriptorBatchDirty) return;
  if (!writeJson("descriptors", descriptors)) {
    throw new Error("sync_v2_descriptor_persist_failed");
  }
  descriptorCommits += 1;
  descriptorBatchDirty = false;
}

function cacheMeta(descriptor, extra = {}) {
  return { syncV2: descriptor, ...extra };
}

export const syncV2StateStore = {
  ownerScope,

  descriptors() {
    return descriptorMap();
  },

  descriptor(nodeKey) {
    return descriptorMap()[nodeKey] || null;
  },

  hasPayload(nodeKey) {
    return payloadKeys().has(nodeKey);
  },

  manifestHash() {
    return String(readJson("manifest-hash", "") || "");
  },

  cursor() {
    return Math.max(0, Number(readJson("cursor", 0)) || 0);
  },

  setCursor(seq) {
    const next = Math.max(this.cursor(), Number(seq) || 0);
    if (next !== this.cursor() && !writeJson("cursor", next)) {
      throw new Error("sync_v2_cursor_persist_failed");
    }
    return next;
  },

  changedNodes(manifest = {}) {
    const local = descriptorMap();
    return (manifest.nodes || [])
      .filter((remote) => {
        if (remote.hydration === "lazy") return false;
        const known = local[remote.nodeKey];
        if (!known) return true;
        if (!this.hasPayload(remote.nodeKey)) return true;
        if (Number(known.stateVersion) !== Number(remote.stateVersion))
          return true;
        return Boolean(known.hash && remote.hash && known.hash !== remote.hash);
      })
      .map((remote) => ({
        nodeKey: remote.nodeKey,
        // A descriptor without its projection cannot satisfy eager hydration.
        // Force the server to return payload even when the version is current.
        knownVersion: this.hasPayload(remote.nodeKey)
          ? Number(local[remote.nodeKey]?.stateVersion || 0)
          : 0,
        knownHash: this.hasPayload(remote.nodeKey)
          ? local[remote.nodeKey]?.hash || null
          : null,
      }));
  },

  rememberManifest(manifest = {}) {
    if (manifest.manifestHash)
      writeJson("manifest-hash", manifest.manifestHash);
    if (manifest.unchanged === true) return;
    const previous = descriptorMap();
    const descriptors = {};
    for (const descriptor of manifest.nodes || []) {
      descriptors[descriptor.nodeKey] = descriptor;
    }
    for (const nodeKey of Object.keys(previous)) {
      if (descriptors[nodeKey]) continue;
      serverStateCache.invalidateScope({ syncNodeKey: nodeKey });
      payloadKeys().delete(nodeKey);
    }
    descriptorCacheScope = ownerScope();
    descriptorCache = descriptors;
    descriptorBatchDirty = true;
    commitDescriptors(descriptors);
  },

  async applyNodesBatch(nodes = []) {
    if (!Array.isArray(nodes) || !nodes.length) return 0;
    const snapshot = { ...descriptorMap() };
    const payloadSnapshot = new Set(payloadKeys());
    descriptorBatchDepth += 1;
    try {
      let applied = 0;
      for (const node of nodes) {
        if (await this.applyNode(node)) applied += 1;
      }
      descriptorBatchDepth -= 1;
      if (descriptorBatchDepth === 0) commitDescriptors();
      return applied;
    } catch (error) {
      descriptorBatchDepth = Math.max(0, descriptorBatchDepth - 1);
      descriptorCache = snapshot;
      payloadAvailableKeys = payloadSnapshot;
      descriptorBatchDirty = false;
      throw error;
    }
  },

  async applyNode({ descriptor, payload, unchanged = false } = {}) {
    if (!descriptor?.nodeKey) return false;
    const known = this.descriptor(descriptor.nodeKey);
    const descriptorAdvanced =
      !known ||
      Number(descriptor.stateVersion || 0) > Number(known.stateVersion || 0);
    if (
      known &&
      Number(known.stateVersion || 0) > Number(descriptor.stateVersion || 0)
    ) {
      return false;
    }
    if (
      known &&
      Number(known.stateVersion) === Number(descriptor.stateVersion) &&
      known.hash &&
      descriptor.hash &&
      known.hash !== descriptor.hash
    ) {
      serverStateCache.invalidateScope({ syncNodeKey: descriptor.nodeKey });
      payloadKeys().delete(descriptor.nodeKey);
      return false;
    }
    setDescriptor(descriptor);
    if (unchanged || payload === undefined) {
      // A successful mutation may return only the new descriptor. Do not let
      // the previous projection masquerade as payload for that newer version.
      if (descriptorAdvanced) payloadKeys().delete(descriptor.nodeKey);
      return true;
    }
    payloadKeys().add(descriptor.nodeKey);

    let match = descriptor.nodeKey.match(/^users\/\d+\/workspaces\/index$/);
    if (match) {
      const previous =
        workspaceNavigationStore.getWorkspaces({ allowStale: true }) || [];
      const visibleSlugs = new Set(
        (payload || []).map((workspace) => workspace.slug)
      );
      for (const workspace of previous) {
        if (!visibleSlugs.has(workspace.slug)) {
          threadHistoryCache.invalidateWorkspace(workspace.slug);
          workspaceNavigationCache.removeWorkspace(workspace.slug);
        }
      }
      workspaceNavigationStore.setWorkspaces(payload || [], {
        meta: cacheMeta(descriptor),
      });
      return true;
    }
    match = descriptor.nodeKey.match(/^workspaces\/(\d+)\/metadata$/);
    if (match && payload?.slug) {
      workspaceNavigationStore.setWorkspaceDetail(payload.slug, payload, {
        meta: cacheMeta(descriptor),
      });
      return true;
    }
    match = descriptor.nodeKey.match(/^workspaces\/(\d+)\/threads\/index$/);
    if (match) {
      const workspace = workspaceForId(match[1]);
      if (workspace?.slug) {
        workspaceNavigationStore.setThreads(workspace.slug, payload || [], {
          meta: cacheMeta(descriptor),
        });
      }
      return true;
    }
    match = descriptor.nodeKey.match(/^threads\/(\d+)\/metadata$/);
    if (match && payload) {
      const workspace = workspaceForId(payload.workspace_id);
      if (workspace?.slug) {
        workspaceNavigationCache.updateThread(workspace.slug, payload);
      }
      return true;
    }
    match = descriptor.nodeKey.match(/^threads\/(\d+)\/messages$/);
    if (match) {
      const location = locationForThreadId(match[1]);
      if (location) {
        threadHistoryCache.invalidateThread(
          location.workspace.slug,
          location.thread.slug
        );
      }
      return true;
    }
    match = descriptor.nodeKey.match(
      /^users\/\d+\/preferences\/([^/]+)\/([^/]+)$/
    );
    if (match) {
      const namespace = decodeURIComponent(match[1]);
      const normalized = {
        namespace: payload?.namespace || namespace,
        scope: payload?.scope || "global",
        version: payload?.schemaVersion || "1",
        value: payload?.value ?? null,
        updatedAt: descriptor.updatedAt,
        stateVersion: Number(descriptor.stateVersion || 0),
      };
      serverStateCache.set(`user-state:${namespace}`, [normalized], {
        ttlMs: 30_000,
        ownerScope: ownerScope(),
        scope: {
          domain: "user-state",
          route: "user-state",
          namespaces: [namespace],
          syncNodeKey: descriptor.nodeKey,
        },
        meta: cacheMeta(descriptor),
      });
      return true;
    }
    if (/^users\/\d+\/profile$/.test(descriptor.nodeKey)) {
      const cacheKey = `account.profile:${descriptor.ownerId}`;
      const previous = serverStateCache.get(cacheKey, {
        allowStale: true,
        ownerScope: ownerScope(),
      });
      serverStateCache.set(`account.profile:${descriptor.ownerId}`, payload, {
        ttlMs: 30_000,
        ownerScope: ownerScope(),
        scope: { domain: "account", syncNodeKey: descriptor.nodeKey },
        meta: cacheMeta(descriptor),
      });
      window.dispatchEvent(
        new CustomEvent("athena-user-profile-refresh", {
          detail: {
            reason: "sync-v2",
            userId: descriptor.ownerId,
            projection: payload,
            stateVersion: descriptor.stateVersion,
            changedFields: Object.keys(payload || {}).filter(
              (field) =>
                JSON.stringify(previous?.[field]) !==
                JSON.stringify(payload?.[field])
            ),
          },
        })
      );
      return true;
    }
    match = descriptor.nodeKey.match(
      /^users\/\d+\/security\/(clients|passkeys|sessions|policies)$/
    );
    if (match) {
      window.dispatchEvent(
        new CustomEvent("athena-sync-v2-security-refresh", {
          detail: {
            kind: match[1],
            nodeKey: descriptor.nodeKey,
            stateVersion: descriptor.stateVersion,
          },
        })
      );
      return true;
    }
    match = descriptor.nodeKey.match(
      /^users\/\d+\/memory\/(candidates|structured|persona)$/
    );
    if (match) {
      window.dispatchEvent(
        new CustomEvent("athena-sync-v2-memory-refresh", {
          detail: {
            kind: match[1],
            nodeKey: descriptor.nodeKey,
            stateVersion: descriptor.stateVersion,
          },
        })
      );
      return true;
    }
    match = descriptor.nodeKey.match(
      /^users\/\d+\/(notifications|entitlements|integrations)$/
    );
    if (match) {
      window.dispatchEvent(
        new CustomEvent("athena-sync-v2-account-authority-refresh", {
          detail: {
            kind: match[1],
            nodeKey: descriptor.nodeKey,
            stateVersion: descriptor.stateVersion,
          },
        })
      );
      return true;
    }
    match = descriptor.nodeKey.match(
      /^workspaces\/(\d+)\/(documents|document-status)$/
    );
    if (match) {
      const workspace = workspaceForId(match[1]);
      if (workspace?.slug)
        workspaceNavigationStore.markWorkspaceDetailStale(
          workspace.slug,
          "sync-v2-workspace-documents"
        );
      window.dispatchEvent(
        new CustomEvent("athena-sync-v2-workspace-documents-refresh", {
          detail: {
            workspaceId: Number(match[1]),
            domain: match[2],
            workspaceSlug: workspace?.slug || null,
            nodeKey: descriptor.nodeKey,
            stateVersion: descriptor.stateVersion,
          },
        })
      );
      return true;
    }
    match = descriptor.nodeKey.match(
      /^workspaces\/(\d+)\/(cognition|agents|meetings|tasks|workflows)$/
    );
    if (match) {
      window.dispatchEvent(
        new CustomEvent("athena-sync-v2-workspace-activity-refresh", {
          detail: {
            workspaceId: Number(match[1]),
            domain: match[2],
            nodeKey: descriptor.nodeKey,
            stateVersion: descriptor.stateVersion,
          },
        })
      );
      return true;
    }
    return true;
  },

  clear(scope = ownerScope()) {
    try {
      const prefix = `athena-sync-v2:${STORAGE_VERSION}:${scope}:`;
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith(prefix)) window.localStorage.removeItem(key);
      }
    } catch {}
    descriptorCacheScope = null;
    descriptorCache = null;
    descriptorBatchDepth = 0;
    descriptorBatchDirty = false;
    payloadCacheScope = null;
    payloadAvailableKeys = new Set();
  },

  diagnostics() {
    return { sync_descriptor_commits: descriptorCommits };
  },
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (
      event.key ===
      `athena-sync-v2:${STORAGE_VERSION}:${descriptorCacheScope}:descriptors`
    ) {
      descriptorCache = null;
      descriptorBatchDirty = false;
      payloadAvailableKeys = new Set();
      window.dispatchEvent(
        new CustomEvent("athena-sync-v2-durable-state-invalidated", {
          detail: { ownerScope: descriptorCacheScope },
        })
      );
    }
  });
}

export default syncV2StateStore;
