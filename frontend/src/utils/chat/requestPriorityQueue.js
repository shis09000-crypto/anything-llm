import {
  PRIORITY_ORDER,
  TaskScheduler,
  taskScheduler,
} from "@/utils/tasks/taskScheduler";

class RequestPriorityQueue {
  constructor(options = {}) {
    this.scheduler = options.scheduler || new TaskScheduler(options);
  }

  schedule(
    task,
    {
      priority = "P2",
      label = "request",
      signal = null,
      dedupeKey = null,
      kind = "request",
      scope = {},
      policy = null,
      emergency = false,
      protected: protectedTask = false,
      resumable = false,
      abortable = true,
      deadlineMs = null,
      intentRank = null,
      resource = null,
      onAbort = null,
      onResume = null,
    } = {}
  ) {
    const handle = emergency
      ? this.scheduler.scheduleEmergency(task, {
          priority,
          label,
          signal,
          dedupeKey,
          kind,
          scope,
          policy,
          protected: protectedTask,
          resumable,
          abortable,
          deadlineMs,
          intentRank,
          resource,
          onAbort,
          onResume,
        })
      : this.scheduler.schedule(task, {
          priority,
          label,
          signal,
          dedupeKey,
          kind,
          scope,
          policy,
          protected: protectedTask,
          resumable,
          abortable,
          deadlineMs,
          intentRank,
          resource,
          onAbort,
          onResume,
        });
    return handle.promise;
  }

  handle(task, options = {}) {
    return options?.emergency
      ? this.scheduler.scheduleEmergency(task, options)
      : this.scheduler.schedule(task, options);
  }

  setPaused(priority, paused) {
    this.scheduler.setPaused(priority, paused);
  }

  cancelScope(scope, reason = "request-priority-cancel-scope") {
    return this.scheduler.cancelScope(scope, reason);
  }

  demoteScope(
    scope,
    priority = "P2",
    reason = "request-priority-demote-scope"
  ) {
    return this.scheduler.demoteScope(scope, priority, reason);
  }

  markScopeStale(scope, reason = "request-priority-mark-scope-stale") {
    return this.scheduler.markScopeStale(scope, reason);
  }

  clear(predicate = () => true) {
    this.scheduler.cancelWhere((entry) => predicate(entry), {
      reason: "request-priority-clear",
      includeRunning: false,
    });
  }

  prune() {
    this.scheduler.prune();
  }

  enforcePendingBudget() {
    this.scheduler.flush();
  }

  stats() {
    return this.scheduler.stats();
  }

  snapshot() {
    return this.scheduler.snapshot();
  }
}

const requestPriorityQueue = new RequestPriorityQueue({
  scheduler: taskScheduler,
});

export { PRIORITY_ORDER, RequestPriorityQueue, requestPriorityQueue };
