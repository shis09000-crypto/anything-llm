import { recordCommunicationEvent } from "@/lib/communication/communicationMetrics";
import { getAppEnvironment } from "@/utils/appEnvironment";
import { getStoredAuthUser } from "@/utils/authUserStorage";
import { safeJsonParse } from "@/utils/request";

const WORKSPACES_TTL_MS = 1000 * 60 * 10;
const THREADS_TTL_MS = 1000 * 60 * 10;
const WORKSPACE_DETAIL_TTL_MS = 1000 * 60 * 10;
const SESSION_CACHE_VERSION = 1;
const SESSION_CACHE_PREFIX = "workspaceNavigationCache";

const workspacesEntry = { payload: null, updatedAt: 0 };
const threadsByWorkspace = new Map();
const workspaceDetailsBySlug = new Map();
const inFlightRequests = new Map();
const resolvedRequests = new Map();

function isFresh(entry, ttlMs) {
  return !!entry?.payload && Date.now() - entry.updatedAt < ttlMs;
}

function entryStatus(entry, ttlMs) {
  if (!entry?.payload) return "miss";
  return isFresh(entry, ttlMs) ? "fresh" : "stale";
}

function ageMs(entry) {
  return entry?.updatedAt ? Date.now() - entry.updatedAt : null;
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function currentUserScope() {
  if (typeof window === "undefined") return "server";
  const user = getStoredAuthUser();
  return [
    getAppEnvironment(),
    user?.authUserId || user?.id || user?.username || "anonymous",
  ].join(":");
}

function sessionKey(kind) {
  return `${SESSION_CACHE_PREFIX}:v${SESSION_CACHE_VERSION}:${currentUserScope()}:${kind}`;
}

function readSessionEntry(kind, ttlMs) {
  if (typeof window === "undefined") return null;
  try {
    const entry = safeJsonParse(
      window.sessionStorage.getItem(sessionKey(kind))
    );
    if (!entry?.payload || !entry?.updatedAt) return null;
    if (Date.now() - entry.updatedAt > ttlMs) return null;
    return {
      payload: clone(entry.payload),
      updatedAt: entry.updatedAt,
    };
  } catch {
    return null;
  }
}

function writeSessionEntry(kind, entry) {
  if (typeof window === "undefined" || !entry?.payload) return;
  try {
    window.sessionStorage.setItem(
      sessionKey(kind),
      JSON.stringify({
        payload: entry.payload,
        updatedAt: entry.updatedAt,
      })
    );
  } catch {}
}

function removeSessionEntry(kind) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(sessionKey(kind));
  } catch {}
}

function clearSessionScope() {
  if (typeof window === "undefined") return;
  const prefix = `${SESSION_CACHE_PREFIX}:v${SESSION_CACHE_VERSION}:${currentUserScope()}:`;
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(prefix)) window.sessionStorage.removeItem(key);
    }
  } catch {}
}

function hydrateWorkspacesFromSession() {
  if (workspacesEntry.payload) return;
  const entry = readSessionEntry("workspaces", WORKSPACES_TTL_MS);
  if (!entry) return;
  workspacesEntry.payload = entry.payload;
  workspacesEntry.updatedAt = entry.updatedAt;
  debugNavigationCache("workspaces:session-hydrate", {
    count: workspacesEntry.payload?.length || 0,
  });
}

function hydrateThreadsFromSession(workspaceSlug) {
  if (!workspaceSlug || threadsByWorkspace.has(workspaceSlug)) return;
  const entry = readSessionEntry(`threads:${workspaceSlug}`, THREADS_TTL_MS);
  if (!entry) return;
  threadsByWorkspace.set(workspaceSlug, entry);
  debugNavigationCache("threads:session-hydrate", {
    workspaceSlug,
    count: entry.payload?.length || 0,
  });
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

export const workspaceNavigationCache = {
  ttl: {
    workspaces: WORKSPACES_TTL_MS,
    threads: THREADS_TTL_MS,
    workspaceDetail: WORKSPACE_DETAIL_TTL_MS,
  },
  debug(label, payload = {}) {
    debugNavigationCache(label, payload);
  },
  runInFlight(key, loader, { reuseResolvedWithinMs = 0 } = {}) {
    if (!key || typeof loader !== "function") return Promise.resolve(null);
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
    hydrateWorkspacesFromSession();
    return {
      status: entryStatus(workspacesEntry, WORKSPACES_TTL_MS),
      ageMs: ageMs(workspacesEntry),
      updatedAt: workspacesEntry.updatedAt,
      count: workspacesEntry.payload?.length || 0,
    };
  },
  getWorkspaces({ allowStale = true } = {}) {
    hydrateWorkspacesFromSession();
    if (!workspacesEntry.payload) {
      recordNavigationCache("miss", { path: "workspaces" });
      return null;
    }
    if (!allowStale && !isFresh(workspacesEntry, WORKSPACES_TTL_MS)) {
      recordNavigationCache("stale", { path: "workspaces" });
      return null;
    }
    recordNavigationCache(
      isFresh(workspacesEntry, WORKSPACES_TTL_MS) ? "hit" : "stale",
      {
        path: "workspaces",
        count: workspacesEntry.payload.length,
      }
    );
    return clone(workspacesEntry.payload);
  },
  setWorkspaces(workspaces = []) {
    workspacesEntry.payload = clone(workspaces);
    workspacesEntry.updatedAt = Date.now();
    writeSessionEntry("workspaces", workspacesEntry);
    debugNavigationCache("workspaces:set", {
      count: workspacesEntry.payload?.length || 0,
    });
  },
  upsertWorkspace(workspace = null) {
    if (!workspace?.id || !workspacesEntry.payload) return;
    const exists = workspacesEntry.payload.some(
      (item) => item.id === workspace.id
    );
    workspacesEntry.payload = exists
      ? workspacesEntry.payload.map((item) =>
          item.id === workspace.id ? { ...item, ...workspace } : item
        )
      : [...workspacesEntry.payload, workspace];
    workspacesEntry.updatedAt = Date.now();
  },
  invalidateWorkspaces() {
    workspacesEntry.payload = null;
    workspacesEntry.updatedAt = 0;
    removeSessionEntry("workspaces");
    recordNavigationCache("invalidate", { path: "workspaces" });
  },
  getThreadsMeta(workspaceSlug) {
    hydrateThreadsFromSession(workspaceSlug);
    const entry = workspaceSlug ? threadsByWorkspace.get(workspaceSlug) : null;
    return {
      status: entryStatus(entry, THREADS_TTL_MS),
      ageMs: ageMs(entry),
      updatedAt: entry?.updatedAt || 0,
      count: entry?.payload?.length || 0,
    };
  },
  getThreads(workspaceSlug, { allowStale = true } = {}) {
    if (!workspaceSlug) return null;
    hydrateThreadsFromSession(workspaceSlug);
    const entry = threadsByWorkspace.get(workspaceSlug);
    if (!entry?.payload) {
      recordNavigationCache("miss", { path: `threads:${workspaceSlug}` });
      return null;
    }
    if (!allowStale && !isFresh(entry, THREADS_TTL_MS)) {
      recordNavigationCache("stale", { path: `threads:${workspaceSlug}` });
      return null;
    }
    recordNavigationCache(isFresh(entry, THREADS_TTL_MS) ? "hit" : "stale", {
      path: `threads:${workspaceSlug}`,
      workspaceSlug,
      count: entry.payload.length,
    });
    return clone(entry.payload);
  },
  setThreads(workspaceSlug, threads = []) {
    if (!workspaceSlug) return;
    const entry = {
      payload: clone(threads),
      updatedAt: Date.now(),
    };
    threadsByWorkspace.set(workspaceSlug, entry);
    writeSessionEntry(`threads:${workspaceSlug}`, entry);
    debugNavigationCache("threads:set", {
      workspaceSlug,
      count: threads.length,
    });
  },
  updateThread(workspaceSlug, thread = null) {
    if (!workspaceSlug || !thread?.slug) return;
    const current = this.getThreads(workspaceSlug) || [];
    this.setThreads(workspaceSlug, [
      ...current.filter((item) => item.slug !== thread.slug),
      thread,
    ]);
  },
  removeThread(workspaceSlug, threadSlug = null) {
    if (!workspaceSlug || !threadSlug) return;
    const current = this.getThreads(workspaceSlug);
    if (!current) return;
    this.setThreads(
      workspaceSlug,
      current.filter((thread) => thread.slug !== threadSlug)
    );
  },
  invalidateThreads(workspaceSlug) {
    if (!workspaceSlug) return;
    threadsByWorkspace.delete(workspaceSlug);
    removeSessionEntry(`threads:${workspaceSlug}`);
    recordNavigationCache("invalidate", { path: `threads:${workspaceSlug}` });
  },
  getWorkspaceDetail(workspaceSlug, { allowStale = true } = {}) {
    if (!workspaceSlug) return null;
    const entry = workspaceDetailsBySlug.get(workspaceSlug);
    if (!entry?.payload) {
      recordNavigationCache("miss", { path: `workspace:${workspaceSlug}` });
      return null;
    }
    if (!allowStale && !isFresh(entry, WORKSPACE_DETAIL_TTL_MS)) {
      recordNavigationCache("stale", { path: `workspace:${workspaceSlug}` });
      return null;
    }
    recordNavigationCache(
      isFresh(entry, WORKSPACE_DETAIL_TTL_MS) ? "hit" : "stale",
      { path: `workspace:${workspaceSlug}`, workspaceSlug }
    );
    return clone(entry.payload);
  },
  getWorkspaceDetailMeta(workspaceSlug) {
    const entry = workspaceSlug
      ? workspaceDetailsBySlug.get(workspaceSlug)
      : null;
    return {
      status: entryStatus(entry, WORKSPACE_DETAIL_TTL_MS),
      ageMs: ageMs(entry),
      updatedAt: entry?.updatedAt || 0,
      hasDetail: !!entry?.payload,
    };
  },
  setWorkspaceDetail(workspaceSlug, workspace = null) {
    if (!workspaceSlug || !workspace) return;
    workspaceDetailsBySlug.set(workspaceSlug, {
      payload: clone(workspace),
      updatedAt: Date.now(),
    });
    this.upsertWorkspace(workspace);
    debugNavigationCache("workspace-detail:set", { workspaceSlug });
  },
  invalidateWorkspaceDetail(workspaceSlug) {
    if (!workspaceSlug) return;
    workspaceDetailsBySlug.delete(workspaceSlug);
    recordNavigationCache("invalidate", { path: `workspace:${workspaceSlug}` });
  },
  clear() {
    workspacesEntry.payload = null;
    workspacesEntry.updatedAt = 0;
    threadsByWorkspace.clear();
    workspaceDetailsBySlug.clear();
    inFlightRequests.clear();
    resolvedRequests.clear();
    clearSessionScope();
  },
  stats() {
    return {
      hasWorkspaces: !!workspacesEntry.payload,
      workspaceCount: workspacesEntry.payload?.length || 0,
      workspaces: this.getWorkspacesMeta(),
      threadWorkspaceCount: threadsByWorkspace.size,
      threadCount: [...threadsByWorkspace.values()].reduce(
        (sum, entry) => sum + (entry.payload?.length || 0),
        0
      ),
      workspaceDetailCount: workspaceDetailsBySlug.size,
      inFlightCount: inFlightRequests.size,
      inFlightKeys: [...inFlightRequests.keys()],
    };
  },
};
