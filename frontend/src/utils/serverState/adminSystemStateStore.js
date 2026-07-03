import { getAppEnvironment } from "../appEnvironment.js";
import { getStoredAuthUser } from "../authUserStorage.js";
import { serverStateCache } from "./serverStateCache.js";
import { serverStateTaskBridge } from "./serverStateTaskBridge.js";

export const ADMIN_SYSTEM_STATE_TTL_MS = 1000 * 60;
export const ADMIN_SYSTEM_FAST_TTL_MS = 1000 * 20;
export const ADMIN_SYSTEM_VERSION_TTL_MS = 1000 * 60 * 60;

export const ADMIN_SYSTEM_STATE_KEYS = {
  adminUsersPage: ({ limit = 50, offset = 0 } = {}) =>
    `admin.users.page:${limit}:${offset}`,
  adminUsers: "admin.users.all",
  adminInvitesPage: ({ limit = 50, offset = 0 } = {}) =>
    `admin.invites.page:${limit}:${offset}`,
  adminInvites: "admin.invites.all",
  adminWorkspacesPage: ({ limit = 50, offset = 0 } = {}) =>
    `admin.workspaces.page:${limit}:${offset}`,
  adminWorkspaces: "admin.workspaces.all",
  adminWorkspaceUsers: (workspaceId) => `admin.workspace-users:${workspaceId}`,
  adminSystemPreferences: (labels = []) =>
    `admin.system-preferences:${normalizeLabels(labels)}`,
  systemPatrolStatus: "system.patrol.status",
  systemDocumentProcessor: "system.document-processing.status",
  systemAcceptedDocumentTypes: "system.accepted-document-types",
  systemChats: ({ offset = 0, limit = 20 } = {}) =>
    `system.chats:${offset}:${limit}`,
  systemEventLogs: (offset = 0) => `system.event-logs:${offset}`,
  systemEmbeddingBatchJobs: (limit = 50) =>
    `system.embedding-batch-jobs:${limit}`,
  systemAppVersion: "system.app-version",
};

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function normalizeLabels(labels = []) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => String(label || "").trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

function currentUserScope() {
  if (typeof window === "undefined") return "server";
  const user = getStoredAuthUser();
  return [
    getAppEnvironment(),
    user?.authUserId || user?.id || user?.username || "anonymous",
  ].join(":");
}

function stateScope(surface, extra = {}) {
  return {
    domain: "admin-system-state",
    route: "settings",
    surface,
    ...extra,
  };
}

export const adminSystemStateStore = {
  ownerScope: currentUserScope,
  ttlMs: ADMIN_SYSTEM_STATE_TTL_MS,
  keys: ADMIN_SYSTEM_STATE_KEYS,

  get(key, options = {}) {
    return serverStateCache.get(key, {
      allowStale: options.allowStale !== false,
      ttlMs: options.ttlMs || ADMIN_SYSTEM_STATE_TTL_MS,
      ownerScope: currentUserScope(),
    });
  },

  set(key, value, options = {}) {
    return serverStateCache.set(key, clone(value), {
      ttlMs: options.ttlMs || ADMIN_SYSTEM_STATE_TTL_MS,
      ownerScope: currentUserScope(),
      scope: stateScope(options.surface || "misc", options.scope),
      meta: options.meta,
    });
  },

  ensure(key, fetcher, options = {}) {
    return serverStateTaskBridge.ensure({
      key,
      fetcher,
      ttlMs: options.ttlMs || ADMIN_SYSTEM_STATE_TTL_MS,
      ownerScope: currentUserScope(),
      scope: stateScope(options.surface || "misc", options.scope),
      priority: options.priority || "P2",
      intentRank: options.intentRank ?? 3,
      policy: options.policy || "background",
      staleWhileRevalidate: options.staleWhileRevalidate !== false,
      dedupeKey: options.dedupeKey || `server-state:${key}`,
      signal: options.signal,
      label: options.label || `admin-system:${key}`,
      meta: options.meta,
    });
  },

  getOrFallback(key, fallback, options = {}) {
    const cached = this.get(key, { ...options, allowStale: true });
    return cached === null || cached === undefined ? fallback : cached;
  },

  invalidate(keyOrPrefix, options = {}) {
    return serverStateCache.invalidate(keyOrPrefix, {
      prefix: options.prefix,
      ownerScope: currentUserScope(),
    });
  },

  invalidatePrefix(prefix) {
    return serverStateCache.invalidatePrefix(prefix, {
      ownerScope: currentUserScope(),
    });
  },

  invalidateAdminUsers() {
    this.invalidatePrefix("admin.users.");
  },

  invalidateAdminInvites() {
    this.invalidatePrefix("admin.invites.");
  },

  invalidateAdminWorkspaces() {
    this.invalidatePrefix("admin.workspaces.");
    this.invalidatePrefix("admin.workspace-users:");
  },

  invalidateAdminSystemPreferences() {
    this.invalidatePrefix("admin.system-preferences:");
  },

  invalidateSystemEventLogs() {
    this.invalidatePrefix("system.event-logs:");
  },

  invalidateSystemEmbeddingBatchJobs() {
    this.invalidatePrefix("system.embedding-batch-jobs:");
  },

  stats() {
    const ownerScope = currentUserScope();
    const entries = serverStateCache
      .snapshot()
      .entries.filter(
        (entry) =>
          entry.ownerScope === ownerScope &&
          entry.scope?.domain === "admin-system-state"
      );
    return {
      adminEntries: entries.filter((entry) =>
        String(entry.key).startsWith("admin.")
      ).length,
      systemEntries: entries.filter((entry) =>
        String(entry.key).startsWith("system.")
      ).length,
      serverStateEntries: entries,
    };
  },
};
