import { markTaskPerformance, taskScheduler } from "../tasks/taskScheduler.js";
import {
  assertNonSensitiveCacheKey,
  redactSensitiveSnapshotEntry,
} from "../sensitive/sensitiveDataGuards.js";

function nowMs() {
  return Date.now();
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function normalizeScope(scope = {}) {
  if (!scope || typeof scope !== "object") return {};
  return { ...scope };
}

function scopeMatches(entryScope = {}, queryScope = {}) {
  const queryEntries = Object.entries(queryScope || {}).filter(
    ([, value]) => value !== undefined && value !== null
  );
  if (!queryEntries.length) return true;
  return queryEntries.every(([key, value]) => entryScope?.[key] === value);
}

function entryStatus(entry, { ttlMs, now = nowMs() } = {}) {
  if (!entry) return "miss";
  const ttl = Number.isFinite(ttlMs) ? ttlMs : entry.ttlMs;
  if (!Number.isFinite(ttl) || ttl < 0) return "fresh";
  return now - entry.updatedAt < ttl ? "fresh" : "stale";
}

function keyMatchesPrefix(key, prefix) {
  return key === prefix || key.startsWith(prefix);
}

export class ServerStateCache {
  constructor({ scheduler = taskScheduler, now = nowMs } = {}) {
    this.scheduler = scheduler;
    this.now = now;
    this.entries = new Map();
    this.inflight = new Map();
    this.inflightDetails = new Map();
    this.listeners = new Map();
    this.revisions = new Map();
    this.counters = {
      hits: 0,
      misses: 0,
      staleHits: 0,
      fastPathHits: 0,
      refreshes: 0,
      refreshCommits: 0,
      droppedStaleWrites: 0,
    };
  }

  get(key, { allowStale = true, ttlMs, ownerScope } = {}) {
    const entry = this.#entry(key, { ownerScope });
    if (!entry) {
      this.counters.misses += 1;
      return null;
    }
    const status = entryStatus(entry, { ttlMs, now: this.now() });
    if (!allowStale && status !== "fresh") {
      this.counters.misses += 1;
      return null;
    }
    if (status === "fresh") this.counters.hits += 1;
    else this.counters.staleHits += 1;
    return clone(entry.value);
  }

  meta(key, { ttlMs, ownerScope } = {}) {
    const entry = this.#entry(key, { ownerScope });
    if (!entry) {
      return {
        status: "miss",
        ageMs: null,
        updatedAt: 0,
        hasValue: false,
      };
    }
    return {
      status: entryStatus(entry, { ttlMs, now: this.now() }),
      ageMs: Math.max(0, this.now() - entry.updatedAt),
      updatedAt: entry.updatedAt,
      hasValue: true,
      scope: { ...entry.scope },
      ownerScope: entry.ownerScope || null,
      meta: { ...(entry.meta || {}) },
    };
  }

  set(key, value, options = {}) {
    assertNonSensitiveCacheKey(key, options.meta || {});
    const entry = {
      value: clone(value),
      updatedAt: Number(options.updatedAt || 0) || this.now(),
      ttlMs: Number.isFinite(options.ttlMs) ? options.ttlMs : Infinity,
      scope: normalizeScope(options.scope),
      ownerScope: options.ownerScope || null,
      meta: { ...(options.meta || {}) },
    };
    this.entries.set(key, entry);
    this.#bumpRevision(key);
    this.#notify(key, "set", entry);
    return clone(value);
  }

  async refresh(key, fetcher, options = {}) {
    assertNonSensitiveCacheKey(key, options.meta || {});
    if (typeof fetcher !== "function") return this.get(key, options);

    const {
      force = true,
      ttlMs,
      ownerScope,
      dedupeKey = `server-state:${key}`,
      signal,
      priority = "P2",
      scope = {},
      intentRank,
      emergency = false,
      protected: protectedTask = false,
      policy,
      resource = "network",
      kind = "server-state",
      staleWhileRevalidate = false,
      onCommit,
      respectOptimistic = true,
    } = options;

    if (!force) {
      const cached = this.get(key, { allowStale: false, ttlMs, ownerScope });
      if (cached !== null) return cached;
    }

    if (staleWhileRevalidate) {
      const stale = this.get(key, { allowStale: true, ttlMs, ownerScope });
      if (stale !== null) {
        this.counters.fastPathHits += 1;
        this.#mark("cache_stale_hit", {
          key,
          priority,
          scope,
        });
        void this.refresh(key, fetcher, {
          ...options,
          force: true,
          staleWhileRevalidate: false,
        }).catch(() => null);
        return stale;
      }
    }

    const requestKey = dedupeKey || key;
    if (this.inflight.has(requestKey)) return this.inflight.get(requestKey);

    const startRevision = this.#revision(key);
    const schedule = emergency
      ? this.scheduler.scheduleEmergency.bind(this.scheduler)
      : this.scheduler.schedule.bind(this.scheduler);
    this.counters.refreshes += 1;
    this.#mark("cache_refresh_started", {
      key,
      requestKey,
      priority,
      scope,
    });
    const handle = schedule(
      async ({ signal: taskSignal, handle: taskHandle }) =>
        fetcher({ signal: taskSignal, handle: taskHandle }),
      {
        priority,
        signal,
        label: options.label || `server-state:${key}`,
        kind,
        scope,
        policy,
        resource,
        emergency,
        protected: protectedTask,
        intentRank,
        dedupeKey: requestKey,
      }
    );
    this.inflightDetails.set(requestKey, {
      key,
      requestKey,
      linkedTaskId: handle.id,
      priority,
      scope: { ...scope },
      startedAt: this.now(),
      label: options.label || `server-state:${key}`,
    });

    const promise = handle.promise
      .then((value) => {
        if (!handle.isCurrent()) {
          this.counters.droppedStaleWrites += 1;
          this.#mark("cache_refresh_stale_dropped", {
            key,
            requestKey,
            reason: "task-stale",
          });
          return null;
        }
        if (value === undefined) return value;
        const currentEntry = this.#entry(key, { ownerScope });
        if (
          respectOptimistic &&
          currentEntry?.meta?.optimistic === true &&
          currentEntry?.meta?.optimisticStatus !== "confirmed"
        ) {
          this.counters.droppedStaleWrites += 1;
          this.#mark("cache_refresh_stale_dropped", {
            key,
            requestKey,
            reason: "pending-optimistic",
            optimisticActionId: currentEntry.meta.optimisticActionId || null,
          });
          return value;
        }
        if (this.#revision(key) !== startRevision) {
          this.counters.droppedStaleWrites += 1;
          this.#mark("cache_refresh_stale_dropped", {
            key,
            requestKey,
            reason: "revision-changed",
          });
          return value;
        }
        this.set(key, value, {
          ttlMs,
          ownerScope,
          scope,
          meta: options.meta,
        });
        if (typeof onCommit === "function") {
          try {
            const commitResult = onCommit(clone(value), {
              key,
              requestKey,
              handle,
              scope,
              ownerScope,
            });
            if (commitResult && typeof commitResult.catch === "function") {
              void commitResult.catch(() => null);
            }
          } catch {
            // Secondary cache mirrors are best-effort and must not fail refresh.
          }
        }
        this.counters.refreshCommits += 1;
        this.#mark("cache_refresh_committed", {
          key,
          requestKey,
          linkedTaskId: handle.id,
        });
        return clone(value);
      })
      .finally(() => {
        if (this.inflight.get(requestKey) === promise) {
          this.inflight.delete(requestKey);
          this.inflightDetails.delete(requestKey);
        }
      });

    this.inflight.set(requestKey, promise);
    return promise;
  }

  async ensure(key, fetcher, options = {}) {
    const {
      ttlMs,
      ownerScope,
      staleWhileRevalidate = true,
      allowStale = true,
    } = options;
    const meta = this.meta(key, { ttlMs, ownerScope });
    if (meta.status === "fresh") {
      const cached = this.get(key, {
        allowStale: false,
        ttlMs,
        ownerScope,
      });
      if (cached !== null) {
        this.counters.fastPathHits += 1;
        this.#mark("cache_fast_hit", {
          key,
          status: "fresh",
          scope: meta.scope,
        });
        return cached;
      }
    }

    if (allowStale && staleWhileRevalidate && meta.hasValue) {
      const cached = this.get(key, {
        allowStale: true,
        ttlMs,
        ownerScope,
      });
      if (cached !== null) {
        this.counters.fastPathHits += 1;
        this.#mark("cache_stale_hit", {
          key,
          status: meta.status,
          scope: meta.scope,
        });
        void this.refresh(key, fetcher, {
          ...options,
          force: true,
          staleWhileRevalidate: false,
        }).catch(() => null);
        return cached;
      }
    }

    return this.refresh(key, fetcher, {
      ...options,
      force: true,
      staleWhileRevalidate: false,
    });
  }

  invalidate(keyOrPrefix, options = {}) {
    const { prefix = false, ownerScope } = options;
    const keys = [...this.entries.keys()].filter((key) =>
      prefix ? keyMatchesPrefix(key, keyOrPrefix) : key === keyOrPrefix
    );
    let deleted = 0;
    keys.forEach((key) => {
      const entry = this.#entry(key, { ownerScope });
      if (!entry) return;
      this.entries.delete(key);
      deleted += 1;
      this.#bumpRevision(key);
      this.#notify(key, "invalidate", entry);
    });
    return deleted;
  }

  invalidatePrefix(prefix, options = {}) {
    return this.invalidate(prefix, { ...options, prefix: true });
  }

  invalidateScope(scope = {}, options = {}) {
    const keys = [...this.entries.entries()]
      .filter(([, entry]) => {
        if (options.ownerScope && entry.ownerScope !== options.ownerScope)
          return false;
        return scopeMatches(entry.scope, scope);
      })
      .map(([key]) => key);
    keys.forEach((key) => {
      const entry = this.entries.get(key);
      this.entries.delete(key);
      this.#bumpRevision(key);
      this.#notify(key, "invalidate", entry);
    });
    return keys.length;
  }

  mutate(key, patcher, options = {}) {
    const current = this.get(key, { allowStale: true, ...options });
    const next =
      typeof patcher === "function" ? patcher(clone(current)) : patcher;
    return this.set(key, next, options);
  }

  subscribe(key, listener) {
    if (typeof listener !== "function") return () => {};
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
    return () => this.listeners.get(key)?.delete(listener);
  }

  snapshot() {
    const now = this.now();
    const entries = [...this.entries.entries()].map(([key, entry]) =>
      redactSensitiveSnapshotEntry({
        key,
        status: entryStatus(entry, { now }),
        ageMs: Math.max(0, now - entry.updatedAt),
        updatedAt: entry.updatedAt,
        ttlMs: entry.ttlMs,
        scope: { ...entry.scope },
        ownerScope: entry.ownerScope || null,
        meta: { ...(entry.meta || {}) },
      })
    );
    const byScope = entries.reduce((acc, entry) => {
      const scopeKey = this.#scopeSummary(entry.scope);
      acc[scopeKey] = (acc[scopeKey] || 0) + 1;
      return acc;
    }, {});
    const byKeyPrefix = entries.reduce((acc, entry) => {
      const prefix = this.#keyPrefix(entry.key);
      acc[prefix] = (acc[prefix] || 0) + 1;
      return acc;
    }, {});
    return {
      size: this.entries.size,
      inflight: [...this.inflight.keys()].map(
        (key) => redactSensitiveSnapshotEntry({ key }).key
      ),
      inflightDetails: [...this.inflightDetails.values()].map((entry) =>
        redactSensitiveSnapshotEntry({
          ...entry,
          ageMs: Math.max(0, now - entry.startedAt),
        })
      ),
      counters: { ...this.counters },
      byScope,
      byKeyPrefix,
      entries,
    };
  }

  clear() {
    const keys = [...this.entries.keys()];
    this.entries.clear();
    this.inflight.clear();
    keys.forEach((key) => {
      this.#bumpRevision(key);
      this.#notify(key, "clear", null);
    });
  }

  #entry(key, { ownerScope } = {}) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (ownerScope && entry.ownerScope !== ownerScope) return null;
    return entry;
  }

  #revision(key) {
    return this.revisions.get(key) || 0;
  }

  #bumpRevision(key) {
    this.revisions.set(key, this.#revision(key) + 1);
  }

  #notify(key, action, entry) {
    const listeners = this.listeners.get(key);
    if (!listeners?.size) return;
    const event = {
      key,
      action,
      entry: entry ? { ...entry, value: clone(entry.value) } : null,
    };
    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        // Cache subscriptions are best-effort observers.
      }
    });
  }

  #mark(name, detail = {}) {
    markTaskPerformance(name, {
      cache: "server-state",
      ...detail,
    });
  }

  #keyPrefix(key = "") {
    const value = String(key || "unknown");
    const delimiterIndex = value.search(/[:.]/);
    return delimiterIndex > 0 ? value.slice(0, delimiterIndex) : value;
  }

  #scopeSummary(scope = {}) {
    if (!scope || typeof scope !== "object") return "global";
    return (
      [
        scope.domain ? `domain:${scope.domain}` : null,
        scope.route ? `route:${scope.route}` : null,
        scope.surface ? `surface:${scope.surface}` : null,
        scope.workspaceSlug ? `workspace:${scope.workspaceSlug}` : null,
        scope.threadSlug ? `thread:${scope.threadSlug}` : null,
        scope.readerDocumentId ? `reader:${scope.readerDocumentId}` : null,
      ]
        .filter(Boolean)
        .join("|") || "global"
    );
  }
}

export const serverStateCache = new ServerStateCache();

function exposeServerStateCacheSnapshot() {
  if (typeof window === "undefined") return;
  const enabled =
    import.meta.env?.DEV ||
    window.localStorage?.getItem?.("athenaServerStateDebug") === "true" ||
    window.localStorage?.getItem?.("athenaRuntimeObserver") === "true";
  if (!enabled) return;
  window.__athenaServerStateCache = {
    snapshot: () => serverStateCache.snapshot(),
  };
}

exposeServerStateCacheSnapshot();
