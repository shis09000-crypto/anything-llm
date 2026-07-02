const PRIORITY_ORDER = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "stale"]);

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function abortError() {
  try {
    return new DOMException("Aborted", "AbortError");
  } catch {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
  }
}

function isAbort(error) {
  return error?.name === "AbortError";
}

function normalizePriority(priority = "P2") {
  return Object.prototype.hasOwnProperty.call(PRIORITY_ORDER, priority)
    ? priority
    : "P2";
}

function priorityRank(priority) {
  return PRIORITY_ORDER[normalizePriority(priority)];
}

function normalizeScope(scope = {}) {
  if (!scope || typeof scope !== "object") return {};
  return { ...scope };
}

function scopeMatches(taskScope = {}, queryScope = {}) {
  const queryEntries = Object.entries(queryScope || {}).filter(
    ([, value]) => value !== undefined && value !== null
  );
  if (!queryEntries.length) return true;
  return queryEntries.every(([key, value]) => taskScope?.[key] === value);
}

function taskLane(priority) {
  const normalized = normalizePriority(priority);
  if (normalized === "P0" || normalized === "P1") return "main";
  if (normalized === "P3") return "prefetch";
  return "background";
}

function createTaskId(kind = "task") {
  const random =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:${random}`;
}

class ScheduledTaskHandle {
  constructor(task) {
    this.task = task;
    this.id = task.id;
    this.promise = task.promise;
    this.signal = task.abortController.signal;
  }

  isCurrent() {
    return !this.task.stale && !this.signal.aborted;
  }

  markStale(reason = "manual") {
    this.task.scheduler.markTaskStale(this.task, reason);
  }

  completeExclusive(reason = "manual") {
    this.task.scheduler.completeExclusive(this.task.id, reason);
  }
}

class TaskScheduler {
  constructor({
    maxConcurrent = 4,
    backgroundMaxConcurrent = 2,
    prefetchMaxConcurrent = 1,
    maxPending = 96,
    staleMs = 45_000,
    exclusiveMaxMs = 3_500,
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.backgroundMaxConcurrent = backgroundMaxConcurrent;
    this.prefetchMaxConcurrent = prefetchMaxConcurrent;
    this.maxPending = maxPending;
    this.staleMs = staleMs;
    this.exclusiveMaxMs = exclusiveMaxMs;
    this.pending = [];
    this.running = new Map();
    this.completed = [];
    this.pausedPriorities = new Set();
    this.exclusive = null;
    this.recentPreemptions = [];
    this.counters = {
      scheduled: 0,
      completed: 0,
      failed: 0,
      aborted: 0,
      demoted: 0,
      stale: 0,
      preempted: 0,
    };
  }

  schedule(taskFn, options = {}) {
    return this.#enqueue(taskFn, options);
  }

  scheduleEmergency(taskFn, options = {}) {
    return this.#enqueue(taskFn, {
      ...options,
      priority: "P0",
      policy: options.policy || "foreground",
      emergency: true,
    });
  }

  #enqueue(taskFn, options = {}) {
    if (typeof taskFn !== "function") {
      const promise = Promise.resolve(null);
      return {
        id: null,
        promise,
        signal: AbortSignal.abort?.() || new AbortController().signal,
        isCurrent: () => false,
        markStale: () => {},
        completeExclusive: () => {},
      };
    }

    const priority = normalizePriority(options.priority);
    const dedupeKey = options.dedupeKey || null;
    if (dedupeKey) {
      const existing = this.#findByDedupeKey(dedupeKey);
      if (existing) return existing.handle;
    }

    this.prune();

    const abortController = new AbortController();
    const externalSignal = options.signal || null;
    const externalAbort = () => abortController.abort(externalSignal.reason);
    if (externalSignal?.aborted) abortController.abort(externalSignal.reason);
    else
      externalSignal?.addEventListener?.("abort", externalAbort, {
        once: true,
      });

    let resolvePromise = () => {};
    let rejectPromise = () => {};
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const task = {
      id: options.id || createTaskId(options.kind || "task"),
      kind: options.kind || "request",
      scope: normalizeScope(options.scope),
      priority,
      originalPriority: priority,
      policy: options.policy || policyForPriority(priority),
      dedupeKey,
      abortController,
      externalSignal,
      externalAbort,
      abortable: options.abortable !== false,
      protected: Boolean(options.protected),
      emergency: Boolean(options.emergency),
      status: "pending",
      stale: false,
      resumable: Boolean(options.resumable),
      createdAt: nowMs(),
      deadlineMs: Number(options.deadlineMs || 0) || null,
      label: options.label || options.kind || "task",
      taskFn,
      onAbort: options.onAbort || null,
      onResume: options.onResume || null,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
      handle: null,
      scheduler: this,
    };
    task.handle = new ScheduledTaskHandle(task);

    this.pending.push(task);
    this.counters.scheduled += 1;
    if (task.emergency) this.#enterExclusive(task);
    this.#sortPending();
    this.#enforcePendingBudget();
    this.flush();
    return task.handle;
  }

  cancelScope(scope = {}, reason = "cancel-scope") {
    return this.cancelWhere((task) => scopeMatches(task.scope, scope), {
      reason,
      includeRunning: true,
    });
  }

  demoteScope(scope = {}, priority = "P2", reason = "demote-scope") {
    let count = 0;
    const nextPriority = normalizePriority(priority);
    for (const task of this.#allNonTerminalTasks()) {
      if (!scopeMatches(task.scope, scope)) continue;
      this.#demoteTask(task, nextPriority, reason);
      count += 1;
    }
    this.flush();
    return count;
  }

  markScopeStale(scope = {}, reason = "mark-scope-stale") {
    return this.markWhereStale(
      (task) => scopeMatches(task.scope, scope),
      reason
    );
  }

  markWhereStale(predicate = () => true, reason = "mark-stale") {
    let count = 0;
    for (const task of this.#allNonTerminalTasks()) {
      if (!predicate(task)) continue;
      this.markTaskStale(task, reason);
      count += 1;
    }
    return count;
  }

  preemptScope(
    scope = {},
    { priorities = ["P2", "P3", "P4"], mode = "abort", reason = "scope" } = {}
  ) {
    const prioritySet = new Set(priorities.map(normalizePriority));
    const predicate = (task) =>
      scopeMatches(task.scope, scope) &&
      prioritySet.has(task.priority) &&
      !task.protected;

    if (mode === "stale") return this.markWhereStale(predicate, reason);
    if (mode === "demote") {
      let count = 0;
      for (const task of this.#allNonTerminalTasks()) {
        if (!predicate(task)) continue;
        this.#demoteTask(task, "P2", reason);
        count += 1;
      }
      this.flush();
      return count;
    }
    return this.cancelWhere(predicate, {
      reason,
      includeRunning: true,
    });
  }

  cancelWhere(predicate = () => true, options = {}) {
    const reason = options.reason || "cancel";
    const includeRunning = options.includeRunning !== false;
    let count = 0;

    const remaining = [];
    for (const task of this.pending) {
      if (!predicate(task)) {
        remaining.push(task);
        continue;
      }
      this.#abortTask(task, reason, { fromPending: true });
      count += 1;
    }
    this.pending = remaining;

    if (includeRunning) {
      for (const task of [...this.running.values()]) {
        if (!predicate(task)) continue;
        this.#abortTask(task, reason);
        count += 1;
      }
    }
    this.flush();
    return count;
  }

  setPaused(priority, paused) {
    const normalized = normalizePriority(priority);
    if (paused) this.pausedPriorities.add(normalized);
    else this.pausedPriorities.delete(normalized);
    this.flush();
  }

  prune() {
    const current = nowMs();
    const remaining = [];
    for (const task of this.pending) {
      const shouldPrune =
        task.abortController.signal.aborted ||
        (["P3", "P4"].includes(task.priority) &&
          current - task.createdAt > this.staleMs);
      if (!shouldPrune) {
        remaining.push(task);
        continue;
      }
      this.#abortTask(task, "prune", { fromPending: true });
    }
    this.pending = remaining;
  }

  flush() {
    this.prune();
    this.#sortPending();

    let started = true;
    while (started) {
      started = false;
      const index = this.pending.findIndex((task) => this.#canStart(task));
      if (index === -1) break;
      const [task] = this.pending.splice(index, 1);
      this.#startTask(task);
      started = true;
    }
  }

  stats() {
    const snapshot = this.snapshot();
    return {
      active: snapshot.running.length,
      pending: snapshot.pending.length,
      byPriority: snapshot.pending.reduce((acc, task) => {
        acc[task.priority] = (acc[task.priority] || 0) + 1;
        return acc;
      }, {}),
      pausedPriorities: [...this.pausedPriorities],
      maxPending: this.maxPending,
      staleMs: this.staleMs,
    };
  }

  snapshot() {
    const serialize = (task) => ({
      id: task.id,
      kind: task.kind,
      label: task.label,
      priority: task.priority,
      policy: task.policy,
      status: task.status,
      stale: task.stale,
      resumable: task.resumable,
      protected: task.protected,
      emergency: task.emergency,
      dedupeKey: task.dedupeKey,
      scope: task.scope,
      ageMs: Math.round(nowMs() - task.createdAt),
    });
    const pending = this.pending.map(serialize);
    const running = [...this.running.values()].map(serialize);
    const activeTasks = [...pending, ...running];
    const background = [...pending, ...running].filter((task) =>
      ["P2", "P3", "P4"].includes(task.priority)
    );
    const recent = this.completed.slice(-80).map(serialize);
    const byKind = activeTasks.reduce((acc, task) => {
      const key = task.kind || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const byScope = activeTasks.reduce((acc, task) => {
      const key = scopeSummaryKey(task.scope);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      active: running.length,
      pending,
      running,
      background,
      byKind,
      byScope,
      oldestPendingMs: pending.length
        ? Math.max(...pending.map((task) => task.ageMs || 0))
        : 0,
      exclusiveReason: this.exclusive?.reason || null,
      recentPreemptions: [...this.recentPreemptions],
      aborted: recent.filter((task) => task.status === "aborted"),
      demoted: recent.filter((task) => task.status === "demoted"),
      stale: [
        ...pending.filter((task) => task.stale),
        ...running.filter((task) => task.stale),
        ...recent.filter((task) => task.status === "stale" || task.stale),
      ],
      exclusiveMode: this.exclusive
        ? {
            active: true,
            taskId: this.exclusive.taskId,
            reason: this.exclusive.reason,
            startedAt: this.exclusive.startedAt,
          }
        : { active: false },
      counters: { ...this.counters },
      lanes: {
        main: this.#activeCountForLane("main"),
        background: this.#activeCountForLane("background"),
        prefetch: this.#activeCountForLane("prefetch"),
      },
    };
  }

  markTaskStale(task, reason = "stale") {
    if (!task || TERMINAL_STATUSES.has(task.status)) return;
    task.stale = true;
    task.status = "stale";
    task.staleReason = reason;
    this.counters.stale += 1;
    this.#recordPreemption(task, "stale", reason);
    if (!this.running.has(task.id)) {
      this.pending = this.pending.filter((pendingTask) => pendingTask !== task);
      this.#finishTask(task, null);
    } else {
      this.#finishTask(task, null);
    }
  }

  completeExclusive(taskId = null, reason = "complete") {
    if (!this.exclusive) return;
    if (taskId && this.exclusive.taskId !== taskId) return;
    if (this.exclusive.timer) clearTimeout(this.exclusive.timer);
    const resumable = this.exclusive.resumable.splice(0);
    this.exclusive = null;
    for (const task of this.pending) {
      if (task.status === "paused")
        task.status = ["P2", "P3", "P4"].includes(task.priority)
          ? "background"
          : "pending";
    }
    for (const task of resumable) {
      if (
        TERMINAL_STATUSES.has(task.status) &&
        !(task.status === "aborted" && task.resumable)
      )
        continue;
      try {
        const resumed = task.onResume?.({ task, reason });
        if (typeof resumed === "function") {
          this.schedule(resumed, {
            ...task,
            priority: "P2",
            policy: "background",
            emergency: false,
            protected: false,
            dedupeKey: task.dedupeKey ? `${task.dedupeKey}:resume` : null,
          });
        }
      } catch {
        // Resuming is best-effort. The original task was already demoted.
      }
    }
    this.flush();
  }

  #findByDedupeKey(dedupeKey) {
    return (
      this.pending.find(
        (task) =>
          task.dedupeKey === dedupeKey &&
          !task.stale &&
          !TERMINAL_STATUSES.has(task.status)
      ) ||
      [...this.running.values()].find(
        (task) =>
          task.dedupeKey === dedupeKey &&
          !task.stale &&
          !TERMINAL_STATUSES.has(task.status)
      )
    );
  }

  #allNonTerminalTasks() {
    return [
      ...this.pending,
      ...[...this.running.values()].filter(
        (task) => !TERMINAL_STATUSES.has(task.status)
      ),
    ];
  }

  #enterExclusive(emergencyTask) {
    const exclusiveMaxMs =
      Number(emergencyTask.deadlineMs || this.exclusiveMaxMs) || 0;
    this.exclusive = {
      active: true,
      taskId: emergencyTask.id,
      reason: emergencyTask.label,
      startedAt: Date.now(),
      resumable: [],
      timer:
        exclusiveMaxMs > 0
          ? setTimeout(() => {
              this.completeExclusive(emergencyTask.id, "exclusive-deadline");
            }, exclusiveMaxMs)
          : null,
    };

    for (const task of this.pending) {
      if (task.id === emergencyTask.id || task.priority === "P0") continue;
      if (["P2", "P3", "P4"].includes(task.priority)) {
        task.status = "paused";
        this.#recordPreemption(task, "pause", "exclusive-pending");
      }
    }

    for (const task of [...this.running.values()]) {
      if (
        task.id === emergencyTask.id ||
        task.protected ||
        task.priority === "P0"
      )
        continue;
      if (task.resumable) {
        this.#demoteTask(task, "P2", "exclusive-preempt");
        this.exclusive.resumable.push(task);
        if (task.abortable) this.#abortTask(task, "exclusive-demote");
        continue;
      }
      if (task.abortable) this.#abortTask(task, "exclusive-preempt");
      else this.markTaskStale(task, "exclusive-stale");
    }
  }

  #demoteTask(task, priority = "P2", reason = "demote") {
    task.priority = normalizePriority(priority);
    task.policy = "background";
    task.status = "demoted";
    task.demoteReason = reason;
    this.counters.demoted += 1;
    this.#recordPreemption(task, "demote", reason);
    if (!this.running.has(task.id)) task.status = "background";
  }

  #abortTask(task, reason = "abort", { fromPending = false } = {}) {
    if (!task || TERMINAL_STATUSES.has(task.status)) return;
    task.abortReason = reason;
    task.status = "aborted";
    task.stale = true;
    this.counters.aborted += 1;
    this.#recordPreemption(task, "abort", reason);
    task.onAbort?.({ task, reason });
    task.abortController.abort(abortError());
    if (fromPending || this.running.has(task.id)) this.#finishTask(task, null);
  }

  #canStart(task) {
    if (task.abortController.signal.aborted || task.stale) return true;
    if (this.pausedPriorities.has(task.priority)) return false;
    if (this.exclusive?.active && !task.emergency && !task.protected)
      return false;
    if (task.policy === "realtime") return true;

    const lane = taskLane(task.priority);
    if (lane === "main")
      return (
        this.#activeCountForLane("main") < this.maxConcurrent ||
        this.#preemptLowerPriorityForLane(task, "main")
      );
    if (lane === "prefetch")
      return (
        !this.exclusive &&
        (this.#activeCountForLane("prefetch") < this.prefetchMaxConcurrent ||
          this.#preemptLowerPriorityForLane(task, "prefetch"))
      );
    return (
      !this.exclusive &&
      (this.#activeCountForLane("background") < this.backgroundMaxConcurrent ||
        this.#preemptLowerPriorityForLane(task, "background"))
    );
  }

  #preemptLowerPriorityForLane(nextTask, lane) {
    const candidate = [...this.running.values()]
      .filter((task) => {
        if (taskLane(task.priority) !== lane) return false;
        if (task.policy === "realtime") return false;
        if (task.protected || !task.abortable) return false;
        return priorityRank(task.priority) > priorityRank(nextTask.priority);
      })
      .sort((a, b) => {
        const rank = priorityRank(b.priority) - priorityRank(a.priority);
        return rank !== 0 ? rank : a.createdAt - b.createdAt;
      })[0];

    if (!candidate) return false;
    this.#abortTask(candidate, "priority-lane-preempt");
    return true;
  }

  #startTask(task) {
    if (task.abortController.signal.aborted || task.stale) {
      this.#finishTask(task, null);
      return;
    }
    task.status = "running";
    task.startedAt = nowMs();
    this.running.set(task.id, task);
    Promise.resolve()
      .then(() =>
        task.taskFn({
          signal: task.abortController.signal,
          task,
          handle: task.handle,
        })
      )
      .then((result) => {
        if (task.stale || task.abortController.signal.aborted) {
          this.#finishTask(task, null);
          return;
        }
        task.status = "completed";
        this.counters.completed += 1;
        this.#finishTask(task, result);
      })
      .catch((error) => {
        if (
          task.stale ||
          task.abortController.signal.aborted ||
          isAbort(error)
        ) {
          task.status = task.status === "stale" ? "stale" : "aborted";
          this.#finishTask(task, null);
          return;
        }
        task.status = "failed";
        task.error = error;
        this.counters.failed += 1;
        this.#finishTask(task, undefined, error);
      })
      .finally(() => {
        if (task.emergency)
          this.completeExclusive(task.id, "emergency-settled");
        this.flush();
      });
  }

  #finishTask(task, value, error = null) {
    if (task.finished) return;
    task.finished = true;
    this.running.delete(task.id);
    task.externalSignal?.removeEventListener?.("abort", task.externalAbort);
    if (task.emergency) this.completeExclusive(task.id, "emergency-settled");
    if (TERMINAL_STATUSES.has(task.status) || task.status === "demoted") {
      this.completed.push({
        ...task,
        taskFn: null,
        resolve: null,
        reject: null,
      });
      if (this.completed.length > 200)
        this.completed.splice(0, this.completed.length - 200);
    }
    if (error) task.reject(error);
    else task.resolve(value);
  }

  #sortPending() {
    this.pending.sort((a, b) => {
      if (a.emergency !== b.emergency) return a.emergency ? -1 : 1;
      const rank = priorityRank(a.priority) - priorityRank(b.priority);
      return rank !== 0 ? rank : a.createdAt - b.createdAt;
    });
  }

  #enforcePendingBudget() {
    if (this.pending.length <= this.maxPending) return;
    const sorted = [...this.pending].sort((a, b) => {
      const rank = priorityRank(b.priority) - priorityRank(a.priority);
      return rank !== 0 ? rank : a.createdAt - b.createdAt;
    });
    const toDrop = new Set(
      sorted.slice(0, this.pending.length - this.maxPending)
    );
    this.pending = this.pending.filter((task) => {
      if (!toDrop.has(task)) return true;
      this.#abortTask(task, "pending-budget", { fromPending: true });
      return false;
    });
  }

  #activeCountForLane(lane) {
    return [...this.running.values()].filter(
      (task) =>
        task.policy !== "realtime" &&
        taskLane(task.priority) === lane &&
        !task.stale &&
        !task.abortController.signal.aborted &&
        !TERMINAL_STATUSES.has(task.status)
    ).length;
  }

  #recordPreemption(task, action, reason) {
    if (!reason || reason === "prune" || reason === "pending-budget") return;
    if (
      !/(preempt|exclusive|route|scope|workspace|thread|stale|demote)/i.test(
        reason
      )
    )
      return;
    this.counters.preempted += 1;
    this.recentPreemptions.push({
      id: task.id,
      kind: task.kind,
      label: task.label,
      priority: task.priority,
      action,
      reason,
      scope: task.scope,
      at: Date.now(),
    });
    if (this.recentPreemptions.length > 60)
      this.recentPreemptions.splice(0, this.recentPreemptions.length - 60);
  }
}

function policyForPriority(priority) {
  switch (normalizePriority(priority)) {
    case "P0":
      return "foreground";
    case "P1":
      return "visible";
    case "P2":
      return "background";
    case "P3":
      return "prefetch";
    default:
      return "maintenance";
  }
}

function scopeSummaryKey(scope = {}) {
  if (!scope || typeof scope !== "object") return "global";
  const keys = [
    "route",
    "surface",
    "workspaceSlug",
    "threadSlug",
    "readerDocumentId",
    "communicationScene",
    "transport",
  ];
  const parts = keys
    .map((key) => (scope[key] ? `${key}:${scope[key]}` : null))
    .filter(Boolean);
  return parts.length ? parts.join("|") : "global";
}

const taskScheduler = new TaskScheduler();

function exposeDevSnapshot() {
  if (typeof window === "undefined") return;
  const dev =
    import.meta.env?.DEV ||
    window.localStorage?.getItem?.("athenaTaskSchedulerDebug") === "true";
  if (!dev) return;
  window.__athenaTaskScheduler = {
    snapshot: () => taskScheduler.snapshot(),
    stats: () => taskScheduler.stats(),
  };
}

exposeDevSnapshot();

export {
  PRIORITY_ORDER,
  TaskScheduler,
  ScheduledTaskHandle,
  normalizePriority,
  scopeMatches,
  taskScheduler,
};
