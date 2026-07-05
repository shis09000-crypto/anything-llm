import { getAppEnvironment } from "../appEnvironment.js";
import { getStoredAuthUser } from "../authUserStorage.js";
import { safeJsonParse } from "../request.js";
import { serverStateCache } from "./serverStateCache.js";
import { serverStateTaskBridge } from "./serverStateTaskBridge.js";

export const WORKSPACE_NAVIGATION_TTL_MS = 1000 * 60 * 10;
const SESSION_CACHE_VERSION = 1;
const SESSION_CACHE_PREFIX = "workspaceNavigationCache";

export const WORKSPACE_NAVIGATION_KEYS = {
  workspaces: "workspace.list",
  workspaceDetail: (workspaceSlug) => `workspace.detail:${workspaceSlug}`,
  workspaceThreads: (workspaceSlug) => `workspace.threads:${workspaceSlug}`,
};

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

function readSessionEntry(kind) {
  if (typeof window === "undefined") return null;
  try {
    const entry = safeJsonParse(
      window.sessionStorage.getItem(sessionKey(kind))
    );
    if (!entry?.payload || !entry?.updatedAt) return null;
    if (Date.now() - entry.updatedAt > WORKSPACE_NAVIGATION_TTL_MS) return null;
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

function workspaceScope(extra = {}) {
  return {
    domain: "workspace-navigation",
    route: "workspace-sidebar",
    ...extra,
  };
}

function workspaceTaskOptions({
  key,
  scope,
  priority = "P0",
  intentRank = 0,
  policy = "foreground",
  staleWhileRevalidate = true,
  ...options
} = {}) {
  return {
    key,
    ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
    ownerScope: currentUserScope(),
    scope,
    priority,
    intentRank,
    policy,
    staleWhileRevalidate,
    dedupeKey: `server-state:${key}`,
    ...options,
  };
}

function hydrateFromSession({ cacheKey, sessionKind, scope }) {
  const meta = serverStateCache.meta(cacheKey, {
    ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
    ownerScope: currentUserScope(),
  });
  if (meta.hasValue) return;
  const entry = readSessionEntry(sessionKind);
  if (!entry) return;
  serverStateCache.set(cacheKey, entry.payload, {
    ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
    ownerScope: currentUserScope(),
    updatedAt: entry.updatedAt,
    scope,
    meta: {
      source: "session",
      count: Array.isArray(entry.payload) ? entry.payload.length : undefined,
    },
  });
}

function writeCacheAndSession({ cacheKey, sessionKind, payload, scope, meta }) {
  const updatedAt = Date.now();
  serverStateCache.set(cacheKey, payload, {
    ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
    ownerScope: currentUserScope(),
    updatedAt,
    scope,
    meta,
  });
  writeSessionEntry(sessionKind, {
    payload: clone(payload),
    updatedAt,
  });
}

export const workspaceNavigationStore = {
  ownerScope: currentUserScope,
  ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
  keys: WORKSPACE_NAVIGATION_KEYS,

  hydrateWorkspacesFromSession() {
    hydrateFromSession({
      cacheKey: WORKSPACE_NAVIGATION_KEYS.workspaces,
      sessionKind: "workspaces",
      scope: workspaceScope({ surface: "workspaces" }),
    });
  },

  hydrateWorkspaceDetailFromSession(workspaceSlug) {
    if (!workspaceSlug) return;
    hydrateFromSession({
      cacheKey: WORKSPACE_NAVIGATION_KEYS.workspaceDetail(workspaceSlug),
      sessionKind: `workspace:${workspaceSlug}`,
      scope: workspaceScope({
        surface: "workspace-detail",
        workspaceSlug,
      }),
    });
  },

  hydrateWorkspaceThreadsFromSession(workspaceSlug) {
    if (!workspaceSlug) return;
    hydrateFromSession({
      cacheKey: WORKSPACE_NAVIGATION_KEYS.workspaceThreads(workspaceSlug),
      sessionKind: `threads:${workspaceSlug}`,
      scope: workspaceScope({
        surface: "threads",
        workspaceSlug,
      }),
    });
  },

  getWorkspaces(options = {}) {
    this.hydrateWorkspacesFromSession();
    return serverStateCache.get(WORKSPACE_NAVIGATION_KEYS.workspaces, {
      allowStale: options.allowStale !== false,
      ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
      ownerScope: currentUserScope(),
    });
  },

  getWorkspacesMeta() {
    this.hydrateWorkspacesFromSession();
    const meta = serverStateCache.meta(WORKSPACE_NAVIGATION_KEYS.workspaces, {
      ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
      ownerScope: currentUserScope(),
    });
    const workspaces = serverStateCache.get(
      WORKSPACE_NAVIGATION_KEYS.workspaces,
      {
        allowStale: true,
        ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
        ownerScope: currentUserScope(),
      }
    );
    return {
      status: meta.status,
      ageMs: meta.ageMs,
      updatedAt: meta.updatedAt,
      count: Array.isArray(workspaces) ? workspaces.length : 0,
    };
  },

  setWorkspaces(workspaces = []) {
    writeCacheAndSession({
      cacheKey: WORKSPACE_NAVIGATION_KEYS.workspaces,
      sessionKind: "workspaces",
      payload: workspaces,
      scope: workspaceScope({ surface: "workspaces" }),
      meta: { count: Array.isArray(workspaces) ? workspaces.length : 0 },
    });
  },

  ensureWorkspaces(fetcher, options = {}) {
    this.hydrateWorkspacesFromSession();
    const key = WORKSPACE_NAVIGATION_KEYS.workspaces;
    return serverStateTaskBridge.ensure(
      workspaceTaskOptions({
        key,
        fetcher,
        scope: workspaceScope({ surface: "workspaces" }),
        priority: options.priority || "P0",
        intentRank: options.intentRank ?? 0,
        policy: options.policy || "foreground",
        staleWhileRevalidate: options.staleWhileRevalidate !== false,
        dedupeKey: options.dedupeKey,
        emergency: options.emergency,
        resource: options.resource,
        signal: options.signal,
        label: options.label || "workspace:list",
        meta: options.meta,
      })
    );
  },

  upsertWorkspace(workspace = null) {
    if (!workspace?.id) return;
    const current = this.getWorkspaces({ allowStale: true });
    if (!Array.isArray(current)) return;
    const exists = current.some((item) => item.id === workspace.id);
    this.setWorkspaces(
      exists
        ? current.map((item) =>
            item.id === workspace.id ? { ...item, ...workspace } : item
          )
        : [...current, workspace]
    );
  },

  invalidateWorkspaces() {
    serverStateCache.invalidate(WORKSPACE_NAVIGATION_KEYS.workspaces, {
      ownerScope: currentUserScope(),
    });
    removeSessionEntry("workspaces");
  },

  markWorkspacesStale(reason = "workspace-navigation-soft-stale") {
    return serverStateCache.markStale(WORKSPACE_NAVIGATION_KEYS.workspaces, {
      ownerScope: currentUserScope(),
      reason,
    });
  },

  getWorkspaceDetail(workspaceSlug, options = {}) {
    if (!workspaceSlug) return null;
    this.hydrateWorkspaceDetailFromSession(workspaceSlug);
    return serverStateCache.get(
      WORKSPACE_NAVIGATION_KEYS.workspaceDetail(workspaceSlug),
      {
        allowStale: options.allowStale !== false,
        ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
        ownerScope: currentUserScope(),
      }
    );
  },

  getWorkspaceDetailMeta(workspaceSlug) {
    if (!workspaceSlug) {
      return {
        status: "miss",
        ageMs: null,
        updatedAt: 0,
        hasDetail: false,
      };
    }
    this.hydrateWorkspaceDetailFromSession(workspaceSlug);
    const meta = serverStateCache.meta(
      WORKSPACE_NAVIGATION_KEYS.workspaceDetail(workspaceSlug),
      {
        ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
        ownerScope: currentUserScope(),
      }
    );
    return {
      status: meta.status,
      ageMs: meta.ageMs,
      updatedAt: meta.updatedAt,
      hasDetail: meta.hasValue,
    };
  },

  setWorkspaceDetail(workspaceSlug, workspace = null) {
    if (!workspaceSlug || !workspace) return;
    writeCacheAndSession({
      cacheKey: WORKSPACE_NAVIGATION_KEYS.workspaceDetail(workspaceSlug),
      sessionKind: `workspace:${workspaceSlug}`,
      payload: workspace,
      scope: workspaceScope({
        surface: "workspace-detail",
        workspaceSlug,
      }),
    });
    this.upsertWorkspace(workspace);
  },

  ensureWorkspaceDetail(workspaceSlug, fetcher, options = {}) {
    if (!workspaceSlug) return Promise.resolve(null);
    this.hydrateWorkspaceDetailFromSession(workspaceSlug);
    const key = WORKSPACE_NAVIGATION_KEYS.workspaceDetail(workspaceSlug);
    return serverStateTaskBridge.ensure(
      workspaceTaskOptions({
        key,
        fetcher,
        scope: workspaceScope({
          surface: "workspace-detail",
          workspaceSlug,
        }),
        priority: options.priority || "P0",
        intentRank: options.intentRank ?? 2,
        policy: options.policy || "foreground",
        staleWhileRevalidate: options.staleWhileRevalidate !== false,
        dedupeKey: options.dedupeKey,
        emergency: options.emergency,
        resource: options.resource,
        signal: options.signal,
        label: options.label || `workspace:detail:${workspaceSlug}`,
        meta: options.meta,
      })
    );
  },

  invalidateWorkspaceDetail(workspaceSlug) {
    if (!workspaceSlug) return;
    serverStateCache.invalidate(
      WORKSPACE_NAVIGATION_KEYS.workspaceDetail(workspaceSlug),
      { ownerScope: currentUserScope() }
    );
    removeSessionEntry(`workspace:${workspaceSlug}`);
  },

  markWorkspaceDetailStale(
    workspaceSlug,
    reason = "workspace-detail-soft-stale"
  ) {
    if (!workspaceSlug) return 0;
    return serverStateCache.markStale(
      WORKSPACE_NAVIGATION_KEYS.workspaceDetail(workspaceSlug),
      { ownerScope: currentUserScope(), reason }
    );
  },

  getThreads(workspaceSlug, options = {}) {
    if (!workspaceSlug) return null;
    this.hydrateWorkspaceThreadsFromSession(workspaceSlug);
    return serverStateCache.get(
      WORKSPACE_NAVIGATION_KEYS.workspaceThreads(workspaceSlug),
      {
        allowStale: options.allowStale !== false,
        ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
        ownerScope: currentUserScope(),
      }
    );
  },

  getThreadsMeta(workspaceSlug) {
    if (!workspaceSlug) {
      return {
        status: "miss",
        ageMs: null,
        updatedAt: 0,
        count: 0,
      };
    }
    this.hydrateWorkspaceThreadsFromSession(workspaceSlug);
    const meta = serverStateCache.meta(
      WORKSPACE_NAVIGATION_KEYS.workspaceThreads(workspaceSlug),
      {
        ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
        ownerScope: currentUserScope(),
      }
    );
    const threads = serverStateCache.get(
      WORKSPACE_NAVIGATION_KEYS.workspaceThreads(workspaceSlug),
      {
        allowStale: true,
        ttlMs: WORKSPACE_NAVIGATION_TTL_MS,
        ownerScope: currentUserScope(),
      }
    );
    return {
      status: meta.status,
      ageMs: meta.ageMs,
      updatedAt: meta.updatedAt,
      count: Array.isArray(threads) ? threads.length : 0,
    };
  },

  setThreads(workspaceSlug, threads = []) {
    if (!workspaceSlug) return;
    writeCacheAndSession({
      cacheKey: WORKSPACE_NAVIGATION_KEYS.workspaceThreads(workspaceSlug),
      sessionKind: `threads:${workspaceSlug}`,
      payload: threads,
      scope: workspaceScope({
        surface: "threads",
        workspaceSlug,
      }),
      meta: { count: Array.isArray(threads) ? threads.length : 0 },
    });
  },

  ensureThreads(workspaceSlug, fetcher, options = {}) {
    if (!workspaceSlug) return Promise.resolve(null);
    this.hydrateWorkspaceThreadsFromSession(workspaceSlug);
    const key = WORKSPACE_NAVIGATION_KEYS.workspaceThreads(workspaceSlug);
    return serverStateTaskBridge.ensure(
      workspaceTaskOptions({
        key,
        fetcher,
        scope: workspaceScope({
          surface: "threads",
          workspaceSlug,
        }),
        priority: options.priority || "P0",
        intentRank: options.intentRank ?? 1,
        policy: options.policy || "foreground",
        staleWhileRevalidate: options.staleWhileRevalidate !== false,
        dedupeKey: options.dedupeKey,
        emergency: options.emergency,
        resource: options.resource,
        signal: options.signal,
        label: options.label || `workspace:threads:${workspaceSlug}`,
        meta: options.meta,
      })
    );
  },

  updateThread(workspaceSlug, thread = null) {
    if (!workspaceSlug || !thread?.slug) return;
    const current = this.getThreads(workspaceSlug, { allowStale: true }) || [];
    this.setThreads(workspaceSlug, [
      ...current.filter((item) => item.slug !== thread.slug),
      thread,
    ]);
  },

  removeThread(workspaceSlug, threadSlug = null) {
    if (!workspaceSlug || !threadSlug) return;
    const current = this.getThreads(workspaceSlug, { allowStale: true });
    if (!Array.isArray(current)) return;
    this.setThreads(
      workspaceSlug,
      current.filter((thread) => thread.slug !== threadSlug)
    );
  },

  invalidateThreads(workspaceSlug) {
    if (!workspaceSlug) return;
    serverStateCache.invalidate(
      WORKSPACE_NAVIGATION_KEYS.workspaceThreads(workspaceSlug),
      { ownerScope: currentUserScope() }
    );
    removeSessionEntry(`threads:${workspaceSlug}`);
  },

  markThreadsStale(workspaceSlug, reason = "threads-soft-stale") {
    if (!workspaceSlug) return 0;
    return serverStateCache.markStale(
      WORKSPACE_NAVIGATION_KEYS.workspaceThreads(workspaceSlug),
      { ownerScope: currentUserScope(), reason }
    );
  },

  clear() {
    serverStateCache.invalidateScope(
      { domain: "workspace-navigation" },
      { ownerScope: currentUserScope() }
    );
    clearSessionScope();
  },

  stats() {
    const snapshot = serverStateCache.snapshot();
    const ownerScope = currentUserScope();
    const workspaceEntries = snapshot.entries.filter(
      (entry) =>
        entry.ownerScope === ownerScope &&
        entry.scope?.domain === "workspace-navigation"
    );
    return {
      workspaces: this.getWorkspacesMeta(),
      hasWorkspaces: this.getWorkspaces({ allowStale: true }) !== null,
      workspaceCount: this.getWorkspacesMeta().count,
      workspaceDetailCount: workspaceEntries.filter(
        (entry) => entry.scope?.surface === "workspace-detail"
      ).length,
      threadWorkspaceCount: workspaceEntries.filter(
        (entry) => entry.scope?.surface === "threads"
      ).length,
      threadCount: workspaceEntries
        .filter((entry) => entry.scope?.surface === "threads")
        .reduce((sum, entry) => sum + (entry.meta?.count || 0), 0),
      serverStateEntries: workspaceEntries,
    };
  },
};
