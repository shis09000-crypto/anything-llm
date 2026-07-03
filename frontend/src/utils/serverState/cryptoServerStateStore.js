import { getAppEnvironment } from "../appEnvironment.js";
import { getStoredAuthUser } from "../authUserStorage.js";
import { serverStateCache } from "./serverStateCache.js";
import { serverStateTaskBridge } from "./serverStateTaskBridge.js";

export const CRYPTO_SNAPSHOT_TTL_MS = 1000 * 30;
export const CRYPTO_HUB_PROGRESS_TTL_MS = 1000 * 60;

export const CRYPTO_SERVER_STATE_KEYS = {
  snapshot: (range = "24H") => `crypto.snapshot:${range}`,
  hubProgress: "crypto.hub.progress",
};

function currentUserScope() {
  if (typeof window === "undefined") return "server";
  const user = getStoredAuthUser();
  return [
    getAppEnvironment(),
    user?.authUserId || user?.id || user?.username || "anonymous",
  ].join(":");
}

function cryptoScope(extra = {}) {
  return {
    domain: "crypto-server-state",
    route: "crypto-center",
    ...extra,
  };
}

export const cryptoServerStateStore = {
  ownerScope: currentUserScope,
  keys: CRYPTO_SERVER_STATE_KEYS,

  getSnapshot(range = "24H", options = {}) {
    return serverStateCache.get(CRYPTO_SERVER_STATE_KEYS.snapshot(range), {
      allowStale: options.allowStale !== false,
      ttlMs: CRYPTO_SNAPSHOT_TTL_MS,
      ownerScope: currentUserScope(),
    });
  },

  setSnapshot(range = "24H", snapshot = null) {
    if (!snapshot) return null;
    return serverStateCache.set(
      CRYPTO_SERVER_STATE_KEYS.snapshot(range),
      snapshot,
      {
        ttlMs: CRYPTO_SNAPSHOT_TTL_MS,
        ownerScope: currentUserScope(),
        scope: cryptoScope({ surface: "snapshot", range }),
        meta: {
          asOf: snapshot.asOf || Date.now(),
          assetCount: Array.isArray(snapshot.assets)
            ? snapshot.assets.length
            : 0,
        },
      }
    );
  },

  ensureSnapshot(range = "24H", fetcher, options = {}) {
    return serverStateTaskBridge.ensure({
      key: CRYPTO_SERVER_STATE_KEYS.snapshot(range),
      fetcher,
      ttlMs: CRYPTO_SNAPSHOT_TTL_MS,
      ownerScope: currentUserScope(),
      scope: cryptoScope({ surface: "snapshot", range }),
      priority: options.priority || "P1",
      intentRank: options.intentRank ?? 3,
      policy: options.policy || "visible",
      staleWhileRevalidate: options.staleWhileRevalidate !== false,
      dedupeKey:
        options.dedupeKey ||
        `server-state:${CRYPTO_SERVER_STATE_KEYS.snapshot(range)}`,
      signal: options.signal,
      label: options.label || `crypto:snapshot:${range}`,
      meta: options.meta,
    });
  },

  invalidateSnapshot(range = null) {
    if (range) {
      return serverStateCache.invalidate(
        CRYPTO_SERVER_STATE_KEYS.snapshot(range),
        {
          ownerScope: currentUserScope(),
        }
      );
    }
    return serverStateCache.invalidateScope(
      { domain: "crypto-server-state", surface: "snapshot" },
      { ownerScope: currentUserScope() }
    );
  },

  getHubProgress(options = {}) {
    return serverStateCache.get(CRYPTO_SERVER_STATE_KEYS.hubProgress, {
      allowStale: options.allowStale !== false,
      ttlMs: CRYPTO_HUB_PROGRESS_TTL_MS,
      ownerScope: currentUserScope(),
    });
  },

  setHubProgress(progress = null) {
    if (!progress) return null;
    return serverStateCache.set(
      CRYPTO_SERVER_STATE_KEYS.hubProgress,
      progress,
      {
        ttlMs: CRYPTO_HUB_PROGRESS_TTL_MS,
        ownerScope: currentUserScope(),
        scope: cryptoScope({ surface: "hub-progress" }),
        meta: {
          phase: progress.phase || null,
          overallPct: progress.overallPct ?? null,
        },
      }
    );
  },

  ensureHubProgress(fetcher, options = {}) {
    return serverStateTaskBridge.ensure({
      key: CRYPTO_SERVER_STATE_KEYS.hubProgress,
      fetcher,
      ttlMs: CRYPTO_HUB_PROGRESS_TTL_MS,
      ownerScope: currentUserScope(),
      scope: cryptoScope({ surface: "hub-progress" }),
      priority: options.priority || "P1",
      intentRank: options.intentRank ?? 3,
      policy: options.policy || "visible",
      staleWhileRevalidate: options.staleWhileRevalidate !== false,
      dedupeKey:
        options.dedupeKey ||
        `server-state:${CRYPTO_SERVER_STATE_KEYS.hubProgress}`,
      signal: options.signal,
      label: options.label || "crypto:hub-progress",
      meta: options.meta,
    });
  },

  invalidateHubProgress() {
    return serverStateCache.invalidate(CRYPTO_SERVER_STATE_KEYS.hubProgress, {
      ownerScope: currentUserScope(),
    });
  },

  stats() {
    const ownerScope = currentUserScope();
    const entries = serverStateCache
      .snapshot()
      .entries.filter(
        (entry) =>
          entry.ownerScope === ownerScope &&
          entry.scope?.domain === "crypto-server-state"
      );
    return {
      snapshotCount: entries.filter(
        (entry) => entry.scope?.surface === "snapshot"
      ).length,
      hasHubProgress: entries.some(
        (entry) => entry.scope?.surface === "hub-progress"
      ),
      serverStateEntries: entries,
    };
  },
};
