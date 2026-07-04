import { recordCommunicationEvent } from "@/lib/communication/communicationMetrics";
import { workspaceNavigationStore } from "@/utils/serverState/workspaceNavigationStore";

const inFlightRequests = new Map();
const resolvedRequests = new Map();

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function debugNavigationCache(label, payload = {}) {
  try {
    if (
      typeof window === "undefined" ||
      window.localStorage.getItem("workspaceNavigationCacheDebug") !== "true"
    ) {
      return;
    }
    console.debug("[workspace-navigation-cache]", label, payload);
  } catch {}
}

function recordNavigationCache(action, payload = {}) {
  recordCommunicationEvent({
    type: "navigation-cache",
    method: "CACHE",
    path: payload.path || payload.key || "workspace-navigation",
    communicationScene: "workspace-navigation",
    cache: action,
    durationMs: 0,
    requestBytes: 0,
    responseBytes: 0,
    ok: true,
    ...payload,
  });
}

function knownNavigationRefresh(key, loader, options = {}) {
  if (key === "workspaces" || key === "workspaces:all") {
    return workspaceNavigationStore.ensureWorkspaces(loader, {
      staleWhileRevalidate: options.staleWhileRevalidate ?? false,
      priority: options.priority || "P0",
      intentRank: options.intentRank ?? 0,
      policy: options.policy || "foreground",
      emergency: options.emergency ?? true,
      kind: options.kind || "navigation",
      signal: options.signal,
      resource: options.resource,
      dedupeKey: options.dedupeKey || "server-state:workspace.list",
      label: options.label || "workspace:list",
    });
  }

  const workspaceMatch = String(key || "").match(/^workspace:([^:]+)$/);
  if (workspaceMatch?.[1]) {
    const workspaceSlug = workspaceMatch[1];
    return workspaceNavigationStore.ensureWorkspaceDetail(
      workspaceSlug,
      loader,
      {
        staleWhileRevalidate: options.staleWhileRevalidate ?? false,
        priority: options.priority || "P0",
        intentRank: options.intentRank ?? 2,
        policy: options.policy || "foreground",
        emergency: options.emergency ?? true,
        kind: options.kind || "navigation",
        signal: options.signal,
        resource: options.resource,
        dedupeKey:
          options.dedupeKey || `server-state:workspace.detail:${workspaceSlug}`,
        label: options.label || `workspace:detail:${workspaceSlug}`,
      }
    );
  }

  const threadsMatch = String(key || "").match(/^threads:([^:]+)$/);
  if (threadsMatch?.[1]) {
    const workspaceSlug = threadsMatch[1];
    return workspaceNavigationStore.ensureThreads(workspaceSlug, loader, {
      staleWhileRevalidate: options.staleWhileRevalidate ?? false,
      priority: options.priority || "P0",
      intentRank: options.intentRank ?? 1,
      policy: options.policy || "foreground",
      emergency: options.emergency ?? true,
      kind: options.kind || "navigation",
      signal: options.signal,
      resource: options.resource,
      dedupeKey:
        options.dedupeKey || `server-state:workspace.threads:${workspaceSlug}`,
      label: options.label || `workspace:threads:${workspaceSlug}`,
    });
  }

  return null;
}

export const workspaceNavigationCache = {
  ttl: {
    workspaces: workspaceNavigationStore.ttlMs,
    threads: workspaceNavigationStore.ttlMs,
    workspaceDetail: workspaceNavigationStore.ttlMs,
  },
  debug(label, payload = {}) {
    debugNavigationCache(label, payload);
  },
  runInFlight(key, loader, { reuseResolvedWithinMs = 0, ...options } = {}) {
    if (!key || typeof loader !== "function") return Promise.resolve(null);
    const knownRefresh = knownNavigationRefresh(key, loader, options);
    if (knownRefresh) {
      debugNavigationCache("server-state-refresh", { key });
      recordNavigationCache("server-state-refresh", { key });
      return knownRefresh;
    }
    const existing = inFlightRequests.get(key);
    if (existing) {
      debugNavigationCache("dedupe", { key });
      recordNavigationCache("dedupe", { key });
      return existing;
    }
    const resolved = resolvedRequests.get(key);
    if (
      reuseResolvedWithinMs > 0 &&
      resolved?.payload &&
      Date.now() - resolved.resolvedAt < reuseResolvedWithinMs
    ) {
      debugNavigationCache("reuse-resolved", { key });
      recordNavigationCache("reuse-resolved", { key });
      return Promise.resolve(clone(resolved.payload));
    }
    const promise = Promise.resolve()
      .then(loader)
      .then((payload) => {
        resolvedRequests.set(key, {
          payload: clone(payload),
          resolvedAt: Date.now(),
        });
        return payload;
      })
      .finally(() => inFlightRequests.delete(key));
    inFlightRequests.set(key, promise);
    return promise;
  },
  getWorkspacesMeta() {
    return workspaceNavigationStore.getWorkspacesMeta();
  },
  getWorkspaces({ allowStale = true } = {}) {
    const workspaces = workspaceNavigationStore.getWorkspaces({ allowStale });
    const meta = workspaceNavigationStore.getWorkspacesMeta();
    if (!workspaces) {
      recordNavigationCache(meta.status === "stale" ? "stale" : "miss", {
        path: "workspaces",
      });
      return null;
    }
    recordNavigationCache(meta.status === "fresh" ? "hit" : "stale", {
      path: "workspaces",
      count: workspaces.length,
    });
    return clone(workspaces);
  },
  setWorkspaces(workspaces = []) {
    workspaceNavigationStore.setWorkspaces(workspaces);
    debugNavigationCache("workspaces:set", {
      count: workspaces?.length || 0,
    });
  },
  upsertWorkspace(workspace = null) {
    workspaceNavigationStore.upsertWorkspace(workspace);
  },
  invalidateWorkspaces() {
    workspaceNavigationStore.invalidateWorkspaces();
    recordNavigationCache("invalidate", { path: "workspaces" });
  },
  getThreadsMeta(workspaceSlug) {
    return workspaceNavigationStore.getThreadsMeta(workspaceSlug);
  },
  getThreads(workspaceSlug, { allowStale = true } = {}) {
    if (!workspaceSlug) return null;
    const threads = workspaceNavigationStore.getThreads(workspaceSlug, {
      allowStale,
    });
    const meta = workspaceNavigationStore.getThreadsMeta(workspaceSlug);
    if (!threads) {
      recordNavigationCache(meta.status === "stale" ? "stale" : "miss", {
        path: `threads:${workspaceSlug}`,
        workspaceSlug,
      });
      return null;
    }
    recordNavigationCache(meta.status === "fresh" ? "hit" : "stale", {
      path: `threads:${workspaceSlug}`,
      workspaceSlug,
      count: threads.length,
    });
    return clone(threads);
  },
  setThreads(workspaceSlug, threads = []) {
    if (!workspaceSlug) return;
    workspaceNavigationStore.setThreads(workspaceSlug, threads);
    debugNavigationCache("threads:set", {
      workspaceSlug,
      count: threads.length,
    });
  },
  updateThread(workspaceSlug, thread = null) {
    workspaceNavigationStore.updateThread(workspaceSlug, thread);
  },
  removeThread(workspaceSlug, threadSlug = null) {
    workspaceNavigationStore.removeThread(workspaceSlug, threadSlug);
  },
  invalidateThreads(workspaceSlug) {
    if (!workspaceSlug) return;
    workspaceNavigationStore.invalidateThreads(workspaceSlug);
    recordNavigationCache("invalidate", { path: `threads:${workspaceSlug}` });
  },
  getWorkspaceDetail(workspaceSlug, { allowStale = true } = {}) {
    if (!workspaceSlug) return null;
    const workspace = workspaceNavigationStore.getWorkspaceDetail(
      workspaceSlug,
      { allowStale }
    );
    const meta = workspaceNavigationStore.getWorkspaceDetailMeta(workspaceSlug);
    if (!workspace) {
      recordNavigationCache(meta.status === "stale" ? "stale" : "miss", {
        path: `workspace:${workspaceSlug}`,
        workspaceSlug,
      });
      return null;
    }
    recordNavigationCache(meta.status === "fresh" ? "hit" : "stale", {
      path: `workspace:${workspaceSlug}`,
      workspaceSlug,
    });
    return clone(workspace);
  },
  getWorkspaceDetailMeta(workspaceSlug) {
    return workspaceNavigationStore.getWorkspaceDetailMeta(workspaceSlug);
  },
  setWorkspaceDetail(workspaceSlug, workspace = null) {
    workspaceNavigationStore.setWorkspaceDetail(workspaceSlug, workspace);
    debugNavigationCache("workspace-detail:set", { workspaceSlug });
  },
  invalidateWorkspaceDetail(workspaceSlug) {
    if (!workspaceSlug) return;
    workspaceNavigationStore.invalidateWorkspaceDetail(workspaceSlug);
    recordNavigationCache("invalidate", { path: `workspace:${workspaceSlug}` });
  },
  clear() {
    workspaceNavigationStore.clear();
    inFlightRequests.clear();
    resolvedRequests.clear();
  },
  stats() {
    const workspaceStats = workspaceNavigationStore.stats();
    return {
      hasWorkspaces: workspaceStats.hasWorkspaces,
      workspaceCount: workspaceStats.workspaceCount,
      workspaces: workspaceStats.workspaces,
      threadWorkspaceCount: workspaceStats.threadWorkspaceCount,
      threadCount: workspaceStats.threadCount,
      workspaceDetailCount: workspaceStats.workspaceDetailCount,
      serverStateEntries: workspaceStats.serverStateEntries,
      inFlightCount: inFlightRequests.size,
      inFlightKeys: [...inFlightRequests.keys()],
    };
  },
};
