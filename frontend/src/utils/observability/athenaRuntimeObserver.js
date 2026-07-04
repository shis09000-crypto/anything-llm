import { serverStateCache } from "@/utils/serverState/serverStateCache";
import { taskScheduler } from "@/utils/tasks/taskScheduler";

const OBSERVER_KEY = "athenaRuntimeObserver";
const PANEL_KEY = "athenaRuntimeObserverPanel";
const LEGACY_TASK_KEY = "athenaTaskSchedulerDebug";
const LEGACY_CACHE_KEY = "athenaServerStateDebug";
const MAX_MARKS = 240;

let installed = false;
let marks = [];

function canUseWindow() {
  return typeof window !== "undefined";
}

function readFlag(key) {
  if (!canUseWindow()) return false;
  try {
    const params = new URLSearchParams(window.location?.search || "");
    const value = params.get(key);
    if (value === "1" || value === "true") return true;
  } catch {}
  try {
    return window.localStorage?.getItem?.(key) === "true";
  } catch {
    return false;
  }
}

export function athenaRuntimeObserverEnabled() {
  if (!canUseWindow()) return false;
  return (
    import.meta.env?.DEV ||
    readFlag(OBSERVER_KEY) ||
    readFlag(LEGACY_TASK_KEY) ||
    readFlag(LEGACY_CACHE_KEY)
  );
}

export function athenaRuntimeObserverPanelEnabled() {
  return readFlag(PANEL_KEY);
}

function summarizeScheduler(snapshot) {
  return {
    active: snapshot.active,
    pendingCount: snapshot.pending.length,
    runningCount: snapshot.running.length,
    backgroundCount: snapshot.background.length,
    oldestPendingMs: snapshot.oldestPendingMs,
    exclusiveMode: snapshot.exclusiveMode,
    activeIntent: snapshot.activeIntent,
    lanes: snapshot.lanes,
    byKind: snapshot.byKind,
    byScope: snapshot.byScope,
    byResource: snapshot.byResource,
    counters: snapshot.counters,
    cacheLinkedTasks: snapshot.cacheLinkedTasks,
    recentPreemptions: snapshot.recentPreemptions,
  };
}

function summarizeCache(snapshot) {
  return {
    size: snapshot.size,
    inflightCount: snapshot.inflight.length,
    inflight: snapshot.inflight,
    inflightDetails: snapshot.inflightDetails,
    counters: snapshot.counters,
    byScope: snapshot.byScope,
    byKeyPrefix: snapshot.byKeyPrefix,
    entries: snapshot.entries,
  };
}

function optionalWindowSnapshot(name) {
  if (!canUseWindow()) return null;
  try {
    return window?.[name]?.snapshot?.() || null;
  } catch {
    return null;
  }
}

function summarizeSensitive(snapshot) {
  if (!snapshot) return null;
  return {
    loaded: snapshot.loaded !== false,
    size: snapshot.size || 0,
    counters: snapshot.counters || {},
    transport: snapshot.transport || null,
    activeHeartbeatTimers: snapshot.transport?.activeHeartbeatTimers || 0,
  };
}

function summarizeOptimistic(snapshot) {
  if (!snapshot) return null;
  return {
    loaded: snapshot.loaded !== false,
    pending: snapshot.pending || 0,
    confirmed: snapshot.confirmed || 0,
    failed: snapshot.failed || 0,
    rolledBack: snapshot.rolledBack || 0,
    tombstones: snapshot.tombstones || 0,
    retryAvailable: snapshot.retryAvailable || false,
  };
}

function summarizeRecovery(snapshot) {
  if (!snapshot) return null;
  return {
    loaded: snapshot.loaded !== false,
    byClassification: snapshot.byClassification || {},
    toastCount: snapshot.toastCount || 0,
    dedupedToastCount: snapshot.dedupedToastCount || 0,
    retryRecommendations: snapshot.retryRecommendations || 0,
    rollbackCount: snapshot.rollbackCount || 0,
  };
}

function buildTimelineEvents(schedulerSnapshot, limit = 120) {
  const normalizedLimit = Math.max(1, Number(limit) || 120);
  const schedulerTimeline = (schedulerSnapshot.timeline || [])
    .slice(-normalizedLimit)
    .map((entry) => ({
      source: "scheduler",
      type: entry.event || "scheduler",
      at: Number(entry.at || 0),
      ...entry,
    }));
  const perfMarks = marks.slice(-normalizedLimit).map((entry) => ({
    source: "performance",
    type: entry.name || entry.markName || "performance",
    at: Number(entry.at || 0),
    ...entry,
  }));

  return [...schedulerTimeline, ...perfMarks]
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    .slice(-normalizedLimit);
}

function buildMetrics({
  schedulerSnapshot,
  cacheSnapshot,
  events,
  sensitiveSnapshot,
  optimisticSnapshot,
  recoverySnapshot,
}) {
  const schedulerCounters = schedulerSnapshot.counters || {};
  const cacheCounters = cacheSnapshot.counters || {};
  const latency = schedulerSnapshot.latency || {};
  const sensitiveCounters = sensitiveSnapshot?.counters || {};
  const recoveryByClassification = recoverySnapshot?.byClassification || {};
  return {
    eventCount: events.length,
    markCount: marks.length,
    schedulerTimelineCount: (schedulerSnapshot.timeline || []).length,
    activeTaskCount: schedulerSnapshot.active || 0,
    pendingCount: schedulerSnapshot.pending?.length || 0,
    runningCount: schedulerSnapshot.running?.length || 0,
    backgroundCount: schedulerSnapshot.background?.length || 0,
    exclusiveActive: Boolean(schedulerSnapshot.exclusiveMode?.active),
    oldestPendingMs: schedulerSnapshot.oldestPendingMs || 0,
    schedulerAborted: schedulerCounters.aborted || 0,
    schedulerDemoted: schedulerCounters.demoted || 0,
    schedulerStale: schedulerCounters.stale || 0,
    schedulerPreempted: schedulerCounters.preempted || 0,
    oldP0StaleCount: schedulerSnapshot.oldP0StaleCount || 0,
    cacheSize: cacheSnapshot.size || 0,
    cacheInflightCount: cacheSnapshot.inflight?.length || 0,
    cacheHits: cacheCounters.hits || 0,
    cacheMisses: cacheCounters.misses || 0,
    cacheStaleHits: cacheCounters.staleHits || 0,
    cacheFastPathHits: cacheCounters.fastPathHits || 0,
    cacheRefreshStarted: cacheCounters.refreshes || 0,
    cacheRefreshCommitted: cacheCounters.refreshCommits || 0,
    cacheRefreshStaleDropped: cacheCounters.droppedStaleWrites || 0,
    sensitiveSessionSize: sensitiveSnapshot?.size || 0,
    sensitiveSessionStored: sensitiveCounters.stored || 0,
    sensitiveSessionRevoked: sensitiveCounters.revoked || 0,
    sensitiveSessionScopeRevoked: sensitiveCounters.scopeRevoked || 0,
    sensitiveSessionHeartbeats: sensitiveCounters.heartbeats || 0,
    sensitiveSessionHeartbeatTimers:
      sensitiveSnapshot?.transport?.activeHeartbeatTimers || 0,
    optimisticPending: optimisticSnapshot?.pending || 0,
    optimisticRolledBack: optimisticSnapshot?.rolledBack || 0,
    recoverySilent: recoveryByClassification.silent || 0,
    recoveryRetryable: recoveryByClassification.retryable || 0,
    recoveryPermission: recoveryByClassification.permission || 0,
    recoveryRollback: recoveryByClassification.rollback || 0,
    latency,
  };
}

function publishSnapshotDigest(snapshot) {
  if (!canUseWindow()) return;
  try {
    const root = window.document?.documentElement;
    if (!root) return;
    root.setAttribute(
      "data-athena-runtime-observer-event-count",
      String(snapshot.eventCount || 0)
    );
    root.setAttribute(
      "data-athena-runtime-observer-metrics",
      JSON.stringify(snapshot.metrics || {})
    );
  } catch {
    // DOM publication is diagnostic-only.
  }
}

function buildCombinedSnapshot() {
  const schedulerSnapshot = taskScheduler.snapshot();
  const cacheSnapshot = serverStateCache.snapshot();
  const sensitiveSnapshot = optionalWindowSnapshot(
    "__athenaSensitiveSessionCenter"
  );
  const optimisticSnapshot = optionalWindowSnapshot(
    "__athenaOptimisticActionCenter"
  );
  const recoverySnapshot = optionalWindowSnapshot("__athenaRecoveryCenter");
  const events = buildTimelineEvents(schedulerSnapshot, 160);
  const metrics = buildMetrics({
    schedulerSnapshot,
    cacheSnapshot,
    sensitiveSnapshot,
    optimisticSnapshot,
    recoverySnapshot,
    events,
  });
  const snapshot = {
    at: new Date().toISOString(),
    eventCount: events.length,
    events,
    metrics,
    scheduler: summarizeScheduler(schedulerSnapshot),
    cache: summarizeCache(cacheSnapshot),
    sensitive: summarizeSensitive(sensitiveSnapshot),
    optimistic: summarizeOptimistic(optimisticSnapshot),
    recovery: summarizeRecovery(recoverySnapshot),
    marks: marks.slice(-80),
    raw: {
      scheduler: schedulerSnapshot,
      cache: cacheSnapshot,
      sensitive: sensitiveSnapshot,
      optimistic: optimisticSnapshot,
      recovery: recoverySnapshot,
    },
  };
  publishSnapshotDigest(snapshot);
  return snapshot;
}

function enable({ panel = false, reload = false } = {}) {
  if (!canUseWindow()) return false;
  window.localStorage?.setItem?.(OBSERVER_KEY, "true");
  window.localStorage?.setItem?.(LEGACY_TASK_KEY, "true");
  window.localStorage?.setItem?.(LEGACY_CACHE_KEY, "true");
  if (panel) window.localStorage?.setItem?.(PANEL_KEY, "true");
  if (reload) window.location.reload();
  return true;
}

function disable({ reload = false } = {}) {
  if (!canUseWindow()) return false;
  window.localStorage?.removeItem?.(OBSERVER_KEY);
  window.localStorage?.removeItem?.(LEGACY_TASK_KEY);
  window.localStorage?.removeItem?.(LEGACY_CACHE_KEY);
  window.localStorage?.removeItem?.(PANEL_KEY);
  if (reload) window.location.reload();
  return true;
}

function ensureCenterPlaceholder(name, snapshotFactory) {
  if (!canUseWindow()) return;
  try {
    if (window?.[name]?.snapshot) return;
    window[name] = {
      placeholder: true,
      snapshot: snapshotFactory,
    };
  } catch {
    // Diagnostic placeholders must never affect app runtime.
  }
}

function ensureObserverCenterPlaceholders() {
  ensureCenterPlaceholder("__athenaSensitiveSessionCenter", () => ({
    loaded: false,
    size: 0,
    counters: {},
    transport: { activeHeartbeatTimers: 0 },
    sessions: [],
  }));
  ensureCenterPlaceholder("__athenaOptimisticActionCenter", () => ({
    loaded: false,
    pending: 0,
    confirmed: 0,
    failed: 0,
    rolledBack: 0,
    tombstones: 0,
    mutationVersionConflicts: 0,
    retryAvailable: false,
  }));
  ensureCenterPlaceholder("__athenaRecoveryCenter", () => ({
    loaded: false,
    recent: [],
    byClassification: {},
    toastCount: 0,
    dedupedToastCount: 0,
    retryRecommendations: 0,
    rollbackCount: 0,
  }));
}

function attachFullObserver() {
  ensureObserverCenterPlaceholders();
  window.document?.documentElement?.setAttribute?.(
    "data-athena-runtime-observer",
    "enabled"
  );
  const api = {
    enabled: true,
    snapshot: buildCombinedSnapshot,
    combined: buildCombinedSnapshot,
    scheduler: () => taskScheduler.snapshot(),
    schedulerStats: () => taskScheduler.stats(),
    cache: () => serverStateCache.snapshot(),
    marks: (limit = 80) => marks.slice(-Math.max(1, Number(limit) || 80)),
    timeline: (limit = 120) => {
      return buildTimelineEvents(taskScheduler.snapshot(), limit);
    },
    print() {
      const snapshot = buildCombinedSnapshot();
      console.log("[AthenaRuntimeObserver]", snapshot);
      console.table(
        snapshot.scheduler.runningCount ? snapshot.raw.scheduler.running : []
      );
      console.table(snapshot.cache.inflightDetails);
      return snapshot;
    },
    clearMarks() {
      marks = [];
    },
    enable,
    disable,
  };

  window.__athenaRuntimeObserverActive = true;
  window.__athenaRuntimeObserver = api;
  window.__athenaCacheScheduler = api;
  window.__athenaTaskScheduler = {
    snapshot: () => taskScheduler.snapshot(),
    stats: () => taskScheduler.stats(),
  };
  window.__athenaServerStateCache = {
    snapshot: () => serverStateCache.snapshot(),
  };
  publishSnapshotDigest(buildCombinedSnapshot());
}

function attachBootstrapObserver() {
  if (!canUseWindow()) return;
  window.document?.documentElement?.setAttribute?.(
    "data-athena-runtime-observer",
    "available"
  );
  window.__athenaRuntimeObserver = {
    enabled: false,
    enable,
    disable,
    help: "Run window.__athenaRuntimeObserver.enable({ panel: true, reload: true }) to enable Athena scheduler/cache diagnostics for this browser.",
  };
}

export function installAthenaRuntimeObserver() {
  if (!canUseWindow()) return false;
  if (!installed) {
    installed = true;
    window.addEventListener("athena-task-performance-mark", (event) => {
      const detail = event?.detail || {};
      marks.push({
        at: Date.now(),
        name: detail.name || "unknown",
        markName: detail.markName || null,
        detail,
      });
      if (marks.length > MAX_MARKS) marks = marks.slice(-MAX_MARKS);
    });
  }

  if (!athenaRuntimeObserverEnabled()) {
    attachBootstrapObserver();
    return false;
  }

  attachFullObserver();
  return true;
}

installAthenaRuntimeObserver();

export default {
  install: installAthenaRuntimeObserver,
  enabled: athenaRuntimeObserverEnabled,
  panelEnabled: athenaRuntimeObserverPanelEnabled,
};
