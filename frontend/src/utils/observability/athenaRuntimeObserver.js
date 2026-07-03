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

function buildCombinedSnapshot() {
  const schedulerSnapshot = taskScheduler.snapshot();
  const cacheSnapshot = serverStateCache.snapshot();
  return {
    at: new Date().toISOString(),
    scheduler: summarizeScheduler(schedulerSnapshot),
    cache: summarizeCache(cacheSnapshot),
    marks: marks.slice(-80),
    raw: {
      scheduler: schedulerSnapshot,
      cache: cacheSnapshot,
    },
  };
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

function attachFullObserver() {
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
      const schedulerTimeline = taskScheduler
        .snapshot()
        .timeline.slice(-Math.max(1, Number(limit) || 120))
        .map((entry) => ({ source: "scheduler", ...entry }));
      const perfMarks = marks
        .slice(-Math.max(1, Number(limit) || 120))
        .map((entry) => ({ source: "performance", ...entry }));
      return [...schedulerTimeline, ...perfMarks].sort(
        (a, b) => Number(a.at || a.ts || 0) - Number(b.at || b.ts || 0)
      );
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
