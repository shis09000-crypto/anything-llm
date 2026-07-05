import {
  markTaskPerformance,
  scopeMatches,
  taskScheduler,
} from "../tasks/taskScheduler.js";
import { recoveryCenter } from "../recovery/recoveryCenter.js";
import { deferredCleanupQueue } from "./deferredCleanupQueue.js";
import { navigationSnapshotStore } from "./navigationSnapshot.js";
import { navigationReasonForScopes, sameRouteScope } from "./routeScope.js";

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function defaultRelatedExitScopes(scope = {}) {
  const scopes = [];
  if (scope.route === "workspace-chat") {
    scopes.push({ route: "reader" });
    if (scope.workspaceSlug) {
      scopes.push({
        surface: "reader-open",
        workspaceSlug: scope.workspaceSlug,
      });
      scopes.push({
        surface: "reader-postprocess",
        workspaceSlug: scope.workspaceSlug,
      });
      scopes.push({
        surface: "reader-upload",
        workspaceSlug: scope.workspaceSlug,
      });
    }
    if (scope.threadSlug) scopes.push({ threadSlug: scope.threadSlug });
  }
  if (scope.route === "crypto-center") {
    scopes.push({ route: "crypto-center" });
  }
  return scopes;
}

const PAGE_HIDDEN_PRIORITIES = new Set(["P3", "P4"]);
const PAGE_LEAVE_PRIORITIES = new Set(["P2", "P3", "P4"]);
export const NAVIGATION_PAGE_LIFECYCLE_EVENT =
  "athena-navigation-page-lifecycle";

export class NavigationLifecycleCenter {
  constructor({
    scheduler = taskScheduler,
    snapshots = navigationSnapshotStore,
    cleanupQueue = deferredCleanupQueue,
    sensitive = null,
    recovery = recoveryCenter,
  } = {}) {
    this.scheduler = scheduler;
    this.snapshots = snapshots;
    this.cleanupQueue = cleanupQueue;
    this.sensitive = sensitive;
    this.recovery = recovery;
    this.activeScope = null;
    this.pageState = {
      visible: typeof document === "undefined" ? true : !document.hidden,
      focused:
        typeof document === "undefined"
          ? true
          : document.hasFocus?.() !== false,
      lastEvent: null,
      hiddenAt: null,
      visibleAt: null,
    };
    this.transitions = [];
    this.counters = {
      transitions: 0,
      leaves: 0,
      enters: 0,
      restores: 0,
      pageHidden: 0,
      pageVisible: 0,
      pageBlur: 0,
      pageFocus: 0,
      pageLeave: 0,
      cleanupDeferred: 0,
      oldTasksCancelled: 0,
      oldTasksStaled: 0,
      pageTasksCancelled: 0,
      pageTasksStaled: 0,
      sensitiveRevokes: 0,
      restoreFailures: 0,
    };
  }

  transition({
    from = null,
    to = null,
    reason = null,
    navigationType = "PUSH",
    fromScope = from,
    toScope = to,
    preferCache = true,
    immediateUi = true,
    saveSnapshot,
    restoreTarget,
    deferredCleanup,
    extraExitScopes = [],
  } = {}) {
    const startedAt = nowMs();
    const transitionReason = navigationReasonForScopes(fromScope, toScope, {
      navigationType,
      explicitReason: reason,
    });
    const transition = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      fromScope: clone(fromScope),
      toScope: clone(toScope),
      reason: transitionReason,
      navigationType,
      preferCache,
      startedAt,
      uiSwappedAt: null,
      restoredAt: null,
      finishedAt: null,
    };
    this.transitions.push(transition);
    if (this.transitions.length > 80)
      this.transitions.splice(0, this.transitions.length - 80);
    this.counters.transitions += 1;
    markTaskPerformance("navigation_transition_start", {
      reason: transitionReason,
      fromScope,
      toScope,
      navigationType,
    });

    if (fromScope && !sameRouteScope(fromScope, toScope)) {
      this.leave(fromScope, {
        reason: transitionReason,
        saveSnapshot,
        deferredCleanup,
        extraScopes: extraExitScopes,
      });
    } else if (typeof saveSnapshot === "function") {
      this.#saveSnapshot(fromScope, saveSnapshot, transitionReason);
    }

    if (immediateUi) {
      transition.uiSwappedAt = nowMs();
      markTaskPerformance("navigation_ui_swapped", {
        reason: transitionReason,
        durationMs: Math.round(transition.uiSwappedAt - startedAt),
        toScope,
      });
    }

    this.enter(toScope, { reason: transitionReason });
    const restorePromise = this.restore(toScope, {
      reason: transitionReason,
      preferCache,
      restoreTarget,
      transition,
    });
    transition.finishedAt = nowMs();
    return {
      transition,
      restorePromise,
      snapshot: () => this.snapshot(),
    };
  }

  leave(scope = {}, options = {}) {
    if (!scope) return { cancelled: 0, staled: 0 };
    const reason = options.reason || "navigation-leave";
    this.counters.leaves += 1;

    if (typeof options.saveSnapshot === "function") {
      this.#saveSnapshot(scope, options.saveSnapshot, reason);
    }

    const exitScopes = [
      scope,
      ...defaultRelatedExitScopes(scope),
      ...(Array.isArray(options.extraScopes) ? options.extraScopes : []),
    ].filter(Boolean);

    let cancelled = 0;
    let staled = 0;
    exitScopes.forEach((exitScope) => {
      cancelled += this.scheduler.cancelWhere(
        (task) => scopeMatches(task.scope, exitScope) && !task.protected,
        { reason, includeRunning: true }
      );
      staled += this.scheduler.markWhereStale(
        (task) =>
          scopeMatches(task.scope, exitScope) &&
          !task.protected &&
          task.status !== "aborted",
        reason
      );
    });
    this.counters.oldTasksCancelled += cancelled;
    this.counters.oldTasksStaled += staled;
    markTaskPerformance("navigation_old_scope_released", {
      reason,
      scope,
      cancelled,
      staled,
    });

    if (scope.kind === "sensitive" || scope.sensitive === true) {
      this.#revokeSensitiveScope(scope, reason);
    }

    if (typeof options.deferredCleanup === "function") {
      this.deferCleanup(scope, options.deferredCleanup, { reason });
    }

    return { cancelled, staled };
  }

  enter(scope = {}, options = {}) {
    if (!scope) return;
    if (options.active !== false) this.activeScope = { ...(scope || {}) };
    this.counters.enters += 1;
    markTaskPerformance("navigation_enter", {
      reason: options.reason || "navigation-enter",
      scope,
      active: options.active !== false,
    });
  }

  restore(scope = {}, options = {}) {
    if (!scope || typeof options.restoreTarget !== "function") {
      return Promise.resolve(this.snapshots.get(scope));
    }
    const startedAt = nowMs();
    this.counters.restores += 1;
    return Promise.resolve()
      .then(() =>
        options.restoreTarget({
          scope,
          snapshot: this.snapshots.get(scope),
          preferCache: options.preferCache !== false,
        })
      )
      .then((result) => {
        options.transition && (options.transition.restoredAt = nowMs());
        if (result?.source === "cache" || result?.cacheHit) {
          markTaskPerformance("navigation_restore_from_cache", {
            scope,
            reason: options.reason,
            durationMs: Math.round(nowMs() - startedAt),
          });
        }
        return result;
      })
      .catch((error) => {
        this.counters.restoreFailures += 1;
        this.recovery.handle(error, {
          source: "navigation",
          scope,
          toast: false,
        });
        return null;
      });
  }

  pageEvent(eventName = "unknown", options = {}) {
    const event = String(eventName || "unknown");
    const reason = options.reason || `page-${event}`;
    this.pageState.lastEvent = event;
    markTaskPerformance(`navigation_page_${event}`, {
      reason,
      activeScope: this.activeScope,
    });
    const pageEventPublished = this.#publishPageEvent(event, reason);

    if (event === "blur") {
      this.pageState.focused = false;
      this.counters.pageBlur += 1;
      this.scheduler.setPaused?.("P4", true);
      return this.#tightenPageTasks({
        reason,
        priorities: new Set(["P4"]),
        markStale: false,
      });
    }

    if (event === "focus") {
      this.pageState.focused = true;
      this.counters.pageFocus += 1;
      if (this.pageState.visible !== false)
        this.scheduler.setPaused?.("P4", false);
      this.scheduler.flush?.();
      return { cancelled: 0, staled: 0 };
    }

    if (event === "hidden") {
      this.pageState.visible = false;
      this.pageState.hiddenAt = Date.now();
      this.counters.pageHidden += 1;
      this.scheduler.setPaused?.("P3", true);
      this.scheduler.setPaused?.("P4", true);
      return this.#tightenPageTasks({
        reason,
        priorities: PAGE_HIDDEN_PRIORITIES,
        markStale: false,
      });
    }

    if (event === "visible" || event === "pageshow") {
      this.pageState.visible = true;
      this.pageState.visibleAt = Date.now();
      this.counters.pageVisible += 1;
      this.scheduler.setPaused?.("P2", false);
      this.scheduler.setPaused?.("P3", false);
      this.scheduler.setPaused?.("P4", false);
      this.scheduler.flush?.();
      markTaskPerformance("navigation_page_resumed", {
        reason,
        activeScope: this.activeScope,
      });
      return { cancelled: 0, staled: 0 };
    }

    if (event === "pagehide" || event === "beforeunload") {
      this.pageState.visible = false;
      this.pageState.hiddenAt = Date.now();
      this.counters.pageLeave += 1;
      this.scheduler.setPaused?.("P2", true);
      this.scheduler.setPaused?.("P3", true);
      this.scheduler.setPaused?.("P4", true);
      if (
        !pageEventPublished &&
        (this.activeScope?.kind === "sensitive" ||
          this.activeScope?.sensitive === true)
      ) {
        this.#revokeSensitiveScope(this.activeScope, reason);
      }
      return this.#tightenPageTasks({
        reason,
        priorities: PAGE_LEAVE_PRIORITIES,
        markStale: true,
      });
    }

    return { cancelled: 0, staled: 0 };
  }

  deferCleanup(scope = {}, cleanupFn = null, options = {}) {
    const id = this.cleanupQueue.enqueue(scope, cleanupFn, options);
    if (id) this.counters.cleanupDeferred += 1;
    return id;
  }

  cancelScope(scope = {}, reason = "navigation-cancel") {
    return this.scheduler.cancelWhere(
      (task) => scopeMatches(task.scope, scope) && !task.protected,
      { reason, includeRunning: true }
    );
  }

  markScopeStale(scope = {}, reason = "navigation-stale") {
    const count = this.scheduler.markWhereStale(
      (task) => scopeMatches(task.scope, scope) && !task.protected,
      reason
    );
    if (count > 0) {
      markTaskPerformance("navigation_stale_write_dropped", { scope, reason });
    }
    return count;
  }

  currentScope() {
    return this.activeScope ? { ...this.activeScope } : null;
  }

  snapshot() {
    return {
      activeScope: this.currentScope(),
      pageState: { ...this.pageState },
      counters: { ...this.counters },
      transitions: this.transitions.slice(-30).map((transition) => ({
        id: transition.id,
        reason: transition.reason,
        navigationType: transition.navigationType,
        fromScope: transition.fromScope,
        toScope: transition.toScope,
        ageMs: Math.round(nowMs() - transition.startedAt),
        uiSwapMs: transition.uiSwappedAt
          ? Math.round(transition.uiSwappedAt - transition.startedAt)
          : null,
        restoredMs:
          transition.restoredAt && transition.startedAt
            ? Math.round(transition.restoredAt - transition.startedAt)
            : null,
      })),
      snapshots: this.snapshots.snapshot(),
      deferredCleanup: this.cleanupQueue.snapshot(),
    };
  }

  #saveSnapshot(scope = {}, saveSnapshot, reason) {
    try {
      const value = saveSnapshot({ scope, reason });
      this.snapshots.save(scope, value, { reason });
    } catch (error) {
      this.recovery.handle(error, {
        source: "navigation",
        scope,
        toast: false,
      });
    }
  }

  #publishPageEvent(event, reason) {
    if (typeof window === "undefined" || !window.dispatchEvent) return false;
    const detail = {
      event,
      reason,
      activeScope: this.currentScope(),
      at: Date.now(),
    };
    try {
      const lifecycleEvent =
        typeof CustomEvent === "function"
          ? new CustomEvent(NAVIGATION_PAGE_LIFECYCLE_EVENT, { detail })
          : { type: NAVIGATION_PAGE_LIFECYCLE_EVENT, detail };
      window.dispatchEvent(lifecycleEvent);
      return true;
    } catch {
      // Page lifecycle notifications are best-effort; scheduling still happens.
      return false;
    }
  }

  #tightenPageTasks({ reason, priorities, markStale = false } = {}) {
    let cancelled = 0;
    let staled = 0;
    const prioritySet = priorities || PAGE_HIDDEN_PRIORITIES;

    cancelled += this.scheduler.cancelWhere(
      (task) =>
        prioritySet.has(task.priority) && !task.protected && !task.emergency,
      { reason, includeRunning: true }
    );

    if (markStale) {
      staled += this.scheduler.markWhereStale(
        (task) =>
          prioritySet.has(task.priority) &&
          !task.protected &&
          !task.emergency &&
          task.status !== "aborted",
        reason
      );
    }

    this.counters.pageTasksCancelled += cancelled;
    this.counters.pageTasksStaled += staled;
    if (cancelled || staled) {
      markTaskPerformance("navigation_page_tasks_tightened", {
        reason,
        cancelled,
        staled,
      });
    }
    return { cancelled, staled };
  }

  #revokeSensitiveScope(scope = {}, reason) {
    this.counters.sensitiveRevokes += 1;
    try {
      const target = {
        resourceType: scope.resourceType,
        resourceId: scope.resourceId,
        ownerScope: scope.ownerScope,
      };
      if (this.sensitive?.revokeScope) {
        void this.sensitive.revokeScope(target, reason);
        return;
      }
      void import("../sensitive/sensitiveSessionCenter.js")
        .then(({ sensitiveSessionCenter }) =>
          sensitiveSessionCenter.revokeScope(target, reason)
        )
        .catch((error) => {
          this.recovery.handle(error, {
            source: "navigation",
            scope,
            toast: false,
          });
        });
    } catch (error) {
      this.recovery.handle(error, {
        source: "navigation",
        scope,
        toast: false,
      });
    }
  }
}

export const navigationLifecycle = new NavigationLifecycleCenter();

function exposeNavigationLifecycleSnapshot() {
  if (typeof window === "undefined") return;
  let runtimeObserverFromUrl = false;
  try {
    const params = new URLSearchParams(window.location?.search || "");
    runtimeObserverFromUrl =
      params.get("athenaRuntimeObserver") === "1" ||
      params.get("athenaRuntimeObserver") === "true";
  } catch {}
  const enabled =
    import.meta.env?.DEV ||
    runtimeObserverFromUrl ||
    window.localStorage?.getItem?.("athenaNavigationLifecycleDebug") ===
      "true" ||
    window.localStorage?.getItem?.("athenaRuntimeObserver") === "true";
  if (!enabled) return;
  window.__athenaNavigationLifecycle = {
    snapshot: () => navigationLifecycle.snapshot(),
  };
}

exposeNavigationLifecycleSnapshot();
