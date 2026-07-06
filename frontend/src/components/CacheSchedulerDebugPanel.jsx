import React, { useEffect, useMemo, useState } from "react";
import {
  athenaRuntimeObserverPanelEnabled,
  installAthenaRuntimeObserver,
} from "@/utils/observability/athenaRuntimeObserver";

function readPanelEnabled() {
  try {
    return athenaRuntimeObserverPanelEnabled();
  } catch {
    return false;
  }
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function Stat({ label, value, tone = "text-white" }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/5 p-2">
      <div className="text-[10px] uppercase tracking-wide text-white/50">
        {label}
      </div>
      <div className={`mt-1 text-sm font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

export default function CacheSchedulerDebugPanel() {
  const [visible] = useState(readPanelEnabled);
  const [snapshot, setSnapshot] = useState(null);

  useEffect(() => {
    installAthenaRuntimeObserver();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const update = () => {
      setSnapshot(window.__athenaRuntimeObserver?.snapshot?.() || null);
    };
    update();
    const interval = setInterval(update, 1_000);
    return () => clearInterval(interval);
  }, [visible]);

  const runningTasks = useMemo(
    () => snapshot?.raw?.scheduler?.running?.slice(0, 6) || [],
    [snapshot]
  );
  const cacheInflight = snapshot?.cache?.inflightDetails || [];
  const counters = snapshot?.cache?.counters || {};
  const scheduler = snapshot?.scheduler || {};
  const navigation = snapshot?.navigation || {};
  const lastNavigation = navigation?.lastTransition || null;

  if (!visible || !snapshot) return null;

  return (
    <aside className="fixed bottom-3 left-3 z-[9999] max-h-[48vh] w-[420px] overflow-auto rounded-lg border border-cyan-300/20 bg-slate-950/90 p-3 text-xs text-white shadow-2xl backdrop-blur">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <strong>Cache / Scheduler</strong>
          <div className="text-[11px] text-white/50">{snapshot.at}</div>
        </div>
        <button
          type="button"
          className="rounded border border-white/10 px-2 py-1 text-white/70 hover:bg-white/10"
          onClick={() => window.__athenaRuntimeObserver?.print?.()}
        >
          print
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Stat label="running" value={formatCount(scheduler.runningCount)} />
        <Stat label="pending" value={formatCount(scheduler.pendingCount)} />
        <Stat label="cache" value={formatCount(snapshot.cache?.size)} />
        <Stat
          label="inflight"
          value={formatCount(snapshot.cache?.inflightCount)}
          tone={snapshot.cache?.inflightCount ? "text-cyan-200" : "text-white"}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stat
          label="fast hits"
          value={formatCount(counters.fastPathHits)}
          tone="text-emerald-200"
        />
        <Stat
          label="stale drops"
          value={formatCount(counters.droppedStaleWrites)}
          tone={counters.droppedStaleWrites ? "text-amber-200" : "text-white"}
        />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Stat
          label="nav ui"
          value={
            lastNavigation?.uiSwapMs === null ||
            lastNavigation?.uiSwapMs === undefined
              ? "-"
              : `${lastNavigation.uiSwapMs}ms`
          }
          tone="text-emerald-200"
        />
        <Stat
          label="nav restore"
          value={
            lastNavigation?.restoredMs === null ||
            lastNavigation?.restoredMs === undefined
              ? "-"
              : `${lastNavigation.restoredMs}ms`
          }
          tone="text-cyan-200"
        />
        <Stat
          label="old released"
          value={`${formatCount(
            navigation?.counters?.oldTasksCancelled
          )}/${formatCount(navigation?.counters?.oldTasksStaled)}`}
          tone="text-amber-100"
        />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Stat
          label="nav done"
          value={
            lastNavigation?.finishedMs === null ||
            lastNavigation?.finishedMs === undefined
              ? "-"
              : `${lastNavigation.finishedMs}ms`
          }
          tone="text-cyan-100"
        />
        <Stat
          label="restore"
          value={
            lastNavigation?.restoreCacheHit
              ? "cache"
              : lastNavigation?.restoreSource || "-"
          }
          tone={
            lastNavigation?.restoreCacheHit ? "text-emerald-200" : "text-white"
          }
        />
        <Stat
          label="nav fail"
          value={lastNavigation?.restoreFailed ? "yes" : "no"}
          tone={lastNavigation?.restoreFailed ? "text-red-200" : "text-white"}
        />
      </div>

      <div className="mt-3 rounded-md border border-white/10 bg-white/5 p-2">
        <div className="mb-1 font-semibold text-white/80">Active Intent</div>
        <pre className="max-h-20 overflow-auto whitespace-pre-wrap text-[11px] text-white/60">
          {JSON.stringify(scheduler.activeIntent || null, null, 2)}
        </pre>
      </div>

      <div className="mt-3">
        <div className="mb-1 font-semibold text-white/80">Running</div>
        <div className="space-y-1">
          {runningTasks.length === 0 && (
            <div className="text-white/45">No running tasks</div>
          )}
          {runningTasks.map((task) => (
            <div
              key={task.id}
              className="grid grid-cols-[auto_auto_1fr] gap-2 rounded border border-white/10 bg-white/5 px-2 py-1"
            >
              <span className="text-cyan-200">{task.priority}</span>
              <span className="text-white/50">r{task.intentRank}</span>
              <span className="truncate" title={task.label}>
                {task.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1 font-semibold text-white/80">Cache Refresh</div>
        <div className="space-y-1">
          {cacheInflight.length === 0 && (
            <div className="text-white/45">No inflight cache refresh</div>
          )}
          {cacheInflight.slice(0, 6).map((entry) => (
            <div
              key={entry.requestKey}
              className="grid grid-cols-[auto_1fr_auto] gap-2 rounded border border-white/10 bg-white/5 px-2 py-1"
            >
              <span className="text-emerald-200">{entry.priority}</span>
              <span className="truncate" title={entry.key}>
                {entry.key}
              </span>
              <span className="text-white/50">{entry.ageMs}ms</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
