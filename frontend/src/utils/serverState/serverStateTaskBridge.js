import { taskScheduler } from "../tasks/taskScheduler.js";
import { serverStateCache } from "./serverStateCache.js";

function normalizeEnsureOptions({
  key,
  scope = {},
  priority = "P2",
  intentRank,
  dedupeKey,
  policy,
  resource = "network",
  kind = "server-state",
  label,
  ...rest
} = {}) {
  return {
    ...rest,
    priority,
    intentRank,
    resource,
    kind,
    policy,
    scope,
    dedupeKey: dedupeKey || `server-state:${key}`,
    label: label || `server-state:${key}`,
  };
}

export const serverStateTaskBridge = {
  ensure({ key, fetcher, ...options } = {}) {
    if (!key) return Promise.resolve(null);
    return serverStateCache.ensure(
      key,
      fetcher,
      normalizeEnsureOptions({ key, ...options })
    );
  },

  refresh({ key, fetcher, ...options } = {}) {
    if (!key) return Promise.resolve(null);
    return serverStateCache.refresh(
      key,
      fetcher,
      normalizeEnsureOptions({
        key,
        ...options,
        force: true,
        staleWhileRevalidate: false,
      })
    );
  },

  prefetch({ key, fetcher, ...options } = {}) {
    if (!key) return Promise.resolve(null);
    return serverStateCache.ensure(
      key,
      fetcher,
      normalizeEnsureOptions({
        key,
        priority: "P3",
        policy: "prefetch",
        resource: "network",
        ...options,
        staleWhileRevalidate: true,
      })
    );
  },

  invalidateScope(
    scope = {},
    reason = "server-state-invalidate",
    options = {}
  ) {
    return {
      invalidated: serverStateCache.invalidateScope(scope, options),
      staleTasks: taskScheduler.markScopeStale(scope, reason),
    };
  },

  markScopeStale(scope = {}, reason = "server-state-stale") {
    return {
      cacheStale: serverStateCache.markScopeStale(scope, { reason }),
      staleTasks: taskScheduler.markScopeStale(scope, reason),
    };
  },
};

export default serverStateTaskBridge;
