import { serverStateCache } from "../serverState/serverStateCache.js";
import { markTaskPerformance, taskScheduler } from "../tasks/taskScheduler.js";
import { recoveryCenter } from "../recovery/recoveryCenter.js";

const activeActions = new Map();
const recentActions = [];
let actionSequence = 0;

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

function createActionId(type = "optimistic-action") {
  actionSequence += 1;
  return `${type}:${nowMs().toString(36)}:${actionSequence}`;
}

function normalizeTargetKeys(targetKeys = []) {
  if (!targetKeys) return [];
  return Array.isArray(targetKeys) ? targetKeys.filter(Boolean) : [targetKeys];
}

function normalizePatchMap(patch, targetKeys = []) {
  if (!patch || typeof patch === "function") return null;
  if (targetKeys.length === 1 && typeof patch !== "object") {
    return { [targetKeys[0]]: patch };
  }
  return patch;
}

function summarizeScope(scope = {}) {
  if (!scope || typeof scope !== "object") return "global";
  return (
    [
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

function applyCachePatch({
  targetKeys,
  patch,
  options,
  snapshots,
  optimisticMeta = {},
}) {
  const patchMap = normalizePatchMap(patch, targetKeys);
  if (!patchMap) return;

  for (const key of targetKeys) {
    const patcher = patchMap[key] ?? patchMap["*"];
    if (patcher === undefined) continue;
    if (!snapshots.has(key)) {
      snapshots.set(key, serverStateCache.get(key, { allowStale: true }));
    }
    serverStateCache.mutate(
      key,
      (current) =>
        typeof patcher === "function" ? patcher(current) : clone(patcher),
      {
        ...options,
        meta: {
          ...(options?.meta || {}),
          optimistic: true,
          optimisticStatus: "pending",
          ...optimisticMeta,
        },
      }
    );
  }
}

function restoreCacheSnapshots({ snapshots, options }) {
  for (const [key, value] of snapshots.entries()) {
    if (value === null || value === undefined) {
      serverStateCache.invalidate(key, options);
    } else {
      serverStateCache.set(key, value, {
        ...options,
        meta: {
          ...(options?.meta || {}),
          optimisticRollback: true,
        },
      });
    }
  }
}

function markCacheOptimisticStatus({
  targetKeys,
  status,
  options,
  optimisticMeta = {},
}) {
  for (const key of targetKeys) {
    const current = serverStateCache.get(key, { allowStale: true, ...options });
    if (current === null || current === undefined) continue;
    serverStateCache.set(key, current, {
      ...options,
      meta: {
        ...(options?.meta || {}),
        optimistic: true,
        optimisticStatus: status,
        ...optimisticMeta,
      },
    });
  }
}

class OptimisticActionCenter {
  run(options = {}) {
    const {
      actionId = createActionId(options.type),
      type = "optimistic-action",
      scope = {},
      targetKeys: rawTargetKeys = [],
      cacheOptions = {},
      optimisticPatch = null,
      rollbackPatch = null,
      confirmPatch = null,
      serverCall,
      priority = "P1",
      policy,
      signal = null,
      intentRank,
      resource = "network",
      protected: protectedTask = true,
      abortable = false,
      emergency = priority === "P0",
      dedupeKey = null,
      invalidateOnSuccess = [],
      toast = null,
      retryable = false,
      tombstone = false,
      activity = null,
      activityId = null,
      onActivityFailure = null,
      autoRetry = false,
      maxRetryAttempts,
      meta = {},
      retryAttempt = Number(meta?.retryAttempt || 0) || 0,
      coordinationContext = null,
    } = options;

    if (typeof serverCall !== "function") {
      const promise = Promise.resolve({
        ok: false,
        actionId,
        error: new Error("Missing optimistic action serverCall"),
      });
      return {
        actionId,
        promise,
        rollback: () => {},
        confirm: () => {},
        snapshot: () => null,
      };
    }

    const existing = dedupeKey
      ? [...activeActions.values()].find(
          (action) =>
            action.dedupeKey === dedupeKey && action.status === "pending"
        )
      : null;
    if (existing) return existing.handle;

    const targetKeys = normalizeTargetKeys(rawTargetKeys);
    const snapshots = new Map();
    const action = {
      id: actionId,
      type,
      scope: { ...scope },
      targetKeys,
      status: "pending",
      dedupeKey,
      retryable: Boolean(retryable),
      tombstone: Boolean(tombstone),
      activityId,
      retryAttempt,
      createdAt: nowMs(),
      updatedAt: nowMs(),
      meta: { ...meta },
      coordinationContext,
      error: null,
      result: null,
      recovery: null,
      retryAvailable: false,
      retryActionId: null,
      handle: null,
    };

    const context = {
      actionId,
      action,
      serverStateCache,
      isLatest: () => activeActions.get(actionId) === action,
      mark: (name, detail = {}) =>
        markTaskPerformance(`optimistic:${name}`, {
          actionId,
          type,
          scope,
          ...detail,
        }),
      coordinationContext,
    };

    const optimisticMeta = {
      optimisticActionId: actionId,
      optimisticActionType: type,
      tombstone: Boolean(tombstone),
    };

    const updateRecent = () => {
      const index = recentActions.findIndex((item) => item.id === action.id);
      if (index >= 0) {
        recentActions[index] = {
          ...recentActions[index],
          ...action,
          finishedAt: recentActions[index].finishedAt || nowMs(),
        };
      }
    };

    const buildRetry = () => {
      if (!retryable) return null;
      return () => {
        const retryActionId = createActionId(`${type}:retry`);
        action.retryActionId = retryActionId;
        action.retryAvailable = false;
        action.updatedAt = nowMs();
        updateRecent();
        return this.run({
          ...options,
          actionId: retryActionId,
          retryAttempt: retryAttempt + 1,
          meta: {
            ...meta,
            retryOf: actionId,
            retryAttempt: retryAttempt + 1,
          },
        });
      };
    };

    const rollback = (reason = "manual") => {
      if (action.status === "rolled-back" || action.status === "confirmed")
        return;
      action.status = "rolled-back";
      action.updatedAt = nowMs();
      action.rollbackReason = reason;
      if (typeof rollbackPatch === "function") {
        rollbackPatch({ ...context, reason });
      } else if (rollbackPatch) {
        applyCachePatch({
          targetKeys,
          patch: rollbackPatch,
          options: cacheOptions,
          snapshots: new Map(),
          optimisticMeta: {
            ...optimisticMeta,
            optimisticStatus: "rollback-patch",
          },
        });
      } else {
        restoreCacheSnapshots({ snapshots, options: cacheOptions });
      }
      context.mark("rollback", { reason });
      this.#settle(action);
    };

    const confirm = (result = null) => {
      if (action.status === "rolled-back") return;
      action.status = "confirmed";
      action.result = result;
      action.updatedAt = nowMs();
      if (typeof confirmPatch === "function")
        confirmPatch({ ...context, result });
      markCacheOptimisticStatus({
        targetKeys,
        status: "confirmed",
        options: cacheOptions,
        optimisticMeta,
      });
      this.#invalidateOnSuccess(invalidateOnSuccess, cacheOptions);
      context.mark("confirm");
      this.#settle(action);
    };

    try {
      if (typeof optimisticPatch === "function") {
        optimisticPatch(context);
      } else if (optimisticPatch) {
        applyCachePatch({
          targetKeys,
          patch: optimisticPatch,
          options: cacheOptions,
          snapshots,
          optimisticMeta,
        });
      }
      context.mark("applied", { targetKeys });
    } catch (error) {
      action.status = "failed";
      action.error = error;
      this.#settle(action);
      const promise = Promise.resolve({ ok: false, actionId, error });
      action.handle = {
        actionId,
        promise,
        rollback,
        confirm,
        snapshot: () => ({ ...action }),
      };
      return action.handle;
    }

    activeActions.set(actionId, action);
    const schedule = emergency
      ? taskScheduler.scheduleEmergency.bind(taskScheduler)
      : taskScheduler.schedule.bind(taskScheduler);
    const taskHandle = schedule(
      async ({ signal, handle }) =>
        serverCall({
          ...context,
          signal,
          handle,
        }),
      {
        label: options.label || `optimistic:${type}`,
        kind: "optimistic-action",
        priority,
        policy,
        signal,
        intentRank,
        resource,
        protected: protectedTask,
        abortable,
        emergency,
        dedupeKey,
        scope,
        coordinationContext,
      }
    );

    const promise = taskHandle.promise
      .then((result) => {
        if (!context.isLatest()) {
          return { ok: false, actionId, stale: true, result };
        }
        if (taskHandle.isCurrent?.() === false) {
          action.status = "stale";
          action.stale = true;
          action.result = result;
          action.updatedAt = nowMs();
          const recovery = recoveryCenter.handle(new Error("Task stale"), {
            source: "optimistic-action",
            actionId,
            scope,
            stale: true,
            rollback,
            rollbackOnSilent: Boolean(optimisticPatch),
            toast: false,
            action,
            coordinationContext,
            onRecovery: (recoveryResult) => {
              action.recovery = recoveryResult;
              action.updatedAt = nowMs();
            },
          });
          action.recovery = recovery;
          context.mark("stale", {
            reason: "task-not-current",
          });
          if (recovery.rollbackExecuted) updateRecent();
          else this.#settle(action);
          return {
            ok: false,
            actionId,
            stale: true,
            result,
            recovery,
            rolledBack: recovery.rollbackExecuted || recovery.shouldRollback,
          };
        }
        confirm(result);
        return { ok: true, actionId, result };
      })
      .catch((error) => {
        action.error = error;
        const retry = buildRetry();
        const recovery = recoveryCenter.handle(error, {
          source: "optimistic-action",
          actionId,
          scope,
          rollback,
          rollbackOnSilent: Boolean(optimisticPatch),
          retry,
          toast,
          action,
          retryable,
          autoRetry,
          maxRetryAttempts,
          retryAttempt,
          activity,
          activityId,
          onActivityFailure,
          onRecovery: (recoveryResult) => {
            action.recovery = recoveryResult;
            action.retryAvailable = Boolean(
              recoveryResult.shouldRetry && retry
            );
            action.updatedAt = nowMs();
          },
        });
        action.recovery = recovery;
        action.retryAvailable = Boolean(recovery.shouldRetry && retry);
        if (action.retryAvailable) action.retry = retry;
        updateRecent();
        return {
          ok: false,
          actionId,
          error,
          recovery,
          rolledBack: recovery.rollbackExecuted || recovery.shouldRollback,
        };
      });

    action.handle = {
      actionId,
      promise,
      signal: taskHandle.signal,
      rollback,
      confirm,
      retry: () => {
        if (typeof action.retry !== "function") return null;
        return action.retry();
      },
      snapshot: () => ({ ...action }),
    };
    return action.handle;
  }

  confirmFromBroadcast({ actionId, event, result = null } = {}) {
    if (!actionId) return { confirmed: false, reason: "missing-action-id" };
    const action = activeActions.get(actionId);
    if (!action?.handle?.confirm) {
      return { confirmed: false, reason: "action-not-active" };
    }
    action.handle.confirm(result || { broadcastEvent: event || null });
    return { confirmed: true, actionId };
  }

  snapshot() {
    const active = [...activeActions.values()].map((action) =>
      this.#serialize(action)
    );
    const byType = active.reduce((acc, action) => {
      acc[action.type] = (acc[action.type] || 0) + 1;
      return acc;
    }, {});
    const byScope = active.reduce((acc, action) => {
      const key = summarizeScope(action.scope);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      active,
      recent: recentActions.map((action) => this.#serialize(action)),
      byType,
      byScope,
    };
  }

  #invalidateOnSuccess(invalidateOnSuccess = [], cacheOptions = {}) {
    const targets = Array.isArray(invalidateOnSuccess)
      ? invalidateOnSuccess
      : [invalidateOnSuccess];
    for (const target of targets.filter(Boolean)) {
      if (typeof target === "function") {
        target({ serverStateCache });
        continue;
      }
      if (typeof target === "string") {
        serverStateCache.invalidate(target, cacheOptions);
        continue;
      }
      if (target.prefix) {
        serverStateCache.invalidatePrefix(target.prefix, cacheOptions);
        continue;
      }
      if (target.key) serverStateCache.invalidate(target.key, cacheOptions);
    }
  }

  #settle(action) {
    activeActions.delete(action.id);
    recentActions.push({
      ...action,
      finishedAt: nowMs(),
    });
    if (recentActions.length > 80)
      recentActions.splice(0, recentActions.length - 80);
  }

  #serialize(action) {
    return {
      id: action.id,
      type: action.type,
      status: action.status,
      scope: action.scope,
      targetKeys: action.targetKeys,
      dedupeKey: action.dedupeKey,
      retryable: action.retryable,
      tombstone: action.tombstone,
      activityId: action.activityId,
      retryAttempt: action.retryAttempt,
      retryAvailable: action.retryAvailable,
      retryActionId: action.retryActionId,
      recovery: action.recovery
        ? {
            classification: action.recovery.classification,
            shouldRetry: action.recovery.shouldRetry,
            shouldRollback: action.recovery.shouldRollback,
            silent: action.recovery.silent,
            recoveryAction: action.recovery.recoveryAction,
            reason: action.recovery.reason,
            rollbackExecuted: action.recovery.rollbackExecuted,
            retryAvailable: action.recovery.retryAvailable,
          }
        : null,
      ageMs: Math.max(0, nowMs() - action.createdAt),
      updatedAgoMs: Math.max(0, nowMs() - action.updatedAt),
      error: action.error?.message || action.error || null,
      meta: action.meta,
    };
  }
}

export const optimisticActionCenter = new OptimisticActionCenter();

if (typeof window !== "undefined") {
  const expose = () => {
    const dev =
      import.meta.env?.DEV ||
      window.localStorage?.getItem?.("athenaOptimisticActionDebug") === "true";
    if (!dev) return;
    window.__athenaOptimisticActionCenter = {
      snapshot: () => optimisticActionCenter.snapshot(),
    };
  };
  expose();
}

export default optimisticActionCenter;
