import showToast from "../toast.js";
import { classifyError } from "./errorClassifier.js";
import { retryPolicyFor } from "./retryPolicy.js";
import { userFacingError } from "./userFacingError.js";

const RECENT_LIMIT = 120;
const TOAST_DEDUPE_MS = 6_000;

function nowMs() {
  return Date.now();
}

function performanceMark(name, detail = {}) {
  try {
    globalThis.performance?.mark?.(name, { detail });
  } catch {}
}

function scopeKey(scope = {}) {
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

function recoveryKey(error = null, context = {}, classified = {}) {
  return (
    context.actionId ||
    context.requestId ||
    context.taskId ||
    `${context.source || "unknown"}:${scopeKey(context.scope)}:${classified.code || ""}:${error?.message || ""}`
  );
}

function toastKey(
  error = null,
  context = {},
  classified = {},
  userMessage = ""
) {
  return [
    classified.classification,
    context.source || "unknown",
    scopeKey(context.scope),
    classified.code || "",
    userMessage || error?.message || "",
  ].join(":");
}

function callToast(toast, message, result, context) {
  if (!message) return false;
  if (typeof toast === "function") {
    toast(message, result, context);
    return true;
  }
  if (typeof toast?.error === "function") {
    toast.error(message, result, context);
    return true;
  }
  if (toast === true) {
    showToast(message, "error", {
      toastId: result.toastKey,
    });
    return true;
  }
  return false;
}

class RecoveryCenter {
  constructor() {
    this.recent = [];
    this.rollbackKeys = new Set();
    this.retryKeys = new Set();
    this.toastHistory = new Map();
    this.counters = {
      handled: 0,
      rollbackCount: 0,
      retryRecommendations: 0,
      dedupedToastCount: 0,
      toastCount: 0,
    };
  }

  handle(error = null, context = {}) {
    const classified = classifyError(error, context);
    const retry = retryPolicyFor(error, context, classified);
    const userMessage = userFacingError(error, classified);
    const key = recoveryKey(error, context, classified);
    const shouldRollback = Boolean(
      classified.shouldRollback ||
        (classified.silent === true && context.rollbackOnSilent === true)
    );
    const shouldReauth = Boolean(classified.shouldReauth);
    let shouldRetry = Boolean(retry.shouldRetry);
    let shouldToast = Boolean(classified.shouldToast && userMessage);
    let rollbackExecuted = false;
    let retryExecuted = false;
    let toastDeduped = false;
    const dedupeToastKey = toastKey(error, context, classified, userMessage);

    if (shouldRollback && typeof context.rollback === "function") {
      if (!this.rollbackKeys.has(key)) {
        this.rollbackKeys.add(key);
        try {
          context.rollback(classified.reason || classified.classification);
          rollbackExecuted = true;
          this.counters.rollbackCount += 1;
          performanceMark("recovery_rollback", { key, source: context.source });
        } catch (rollbackError) {
          this.#record({
            key,
            source: context.source,
            classification: "fatal",
            error: rollbackError,
            reason: "rollback-failed",
          });
        }
      }
    }

    if (shouldRetry) {
      this.counters.retryRecommendations += 1;
      performanceMark("recovery_retry_recommended", {
        key,
        source: context.source,
        action: retry.recoveryAction,
      });
      if (context.autoRetry === true && typeof context.retry === "function") {
        const retryKey = `${key}:retry`;
        if (!this.retryKeys.has(retryKey)) {
          this.retryKeys.add(retryKey);
          try {
            context.retry(retry);
            retryExecuted = true;
          } catch {
            shouldRetry = false;
          }
        }
      }
    }

    const result = {
      classification: classified.classification,
      shouldRetry,
      shouldRollback,
      shouldToast,
      shouldReauth,
      silent: Boolean(classified.silent),
      userMessage,
      recoveryAction: retry.recoveryAction || classified.recoveryAction || null,
      reason: classified.reason,
      code: classified.code || null,
      status: classified.status || 0,
      retry,
      rollbackExecuted,
      retryExecuted,
      toastDeduped,
      key,
      toastKey: dedupeToastKey,
      retryAvailable: Boolean(
        shouldRetry && typeof context.retry === "function"
      ),
      coordinationContext: context.coordinationContext
        ? { ...context.coordinationContext }
        : null,
    };

    if (shouldToast) {
      const lastToastAt = this.toastHistory.get(dedupeToastKey) || 0;
      if (nowMs() - lastToastAt < TOAST_DEDUPE_MS) {
        result.shouldToast = false;
        result.toastDeduped = true;
        toastDeduped = true;
        this.counters.dedupedToastCount += 1;
        performanceMark("recovery_toast_deduped", {
          key,
          source: context.source,
        });
      } else {
        const toastShown = callToast(
          context.toast,
          userMessage,
          result,
          context
        );
        if (toastShown) {
          this.toastHistory.set(dedupeToastKey, nowMs());
          this.counters.toastCount += 1;
        }
      }
    }

    if (
      result.classification === "background" &&
      typeof context.activity?.fail === "function"
    ) {
      context.activity.fail(context.activityId, result);
    }
    if (
      result.classification === "background" &&
      typeof context.onActivityFailure === "function"
    ) {
      context.onActivityFailure(result);
    }
    if (typeof context.onRecovery === "function") {
      try {
        context.onRecovery(result);
      } catch {}
    }

    this.counters.handled += 1;
    this.#attach(error, result, context);
    this.#record({
      key,
      source: context.source || "unknown",
      actionId: context.actionId || null,
      taskId: context.taskId || null,
      requestId: context.requestId || null,
      coordinationContext: context.coordinationContext || null,
      scope: context.scope || null,
      classification: result.classification,
      reason: result.reason,
      code: result.code,
      status: result.status,
      silent: result.silent,
      shouldRetry: result.shouldRetry,
      shouldRollback: result.shouldRollback,
      shouldToast: result.shouldToast,
      recoveryAction: result.recoveryAction,
      userMessage: result.userMessage,
      rollbackExecuted,
      retryExecuted,
      toastDeduped,
    });
    performanceMark("recovery_classified", {
      key,
      source: context.source,
      classification: result.classification,
    });
    return result;
  }

  snapshot() {
    const byClassification = this.recent.reduce((acc, item) => {
      acc[item.classification] = (acc[item.classification] || 0) + 1;
      return acc;
    }, {});
    const bySource = this.recent.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {});
    return {
      recent: [...this.recent],
      byClassification,
      bySource,
      rollbackCount: this.counters.rollbackCount,
      retryRecommendations: this.counters.retryRecommendations,
      dedupedToastCount: this.counters.dedupedToastCount,
      toastCount: this.counters.toastCount,
      counters: { ...this.counters },
    };
  }

  resetForTests() {
    this.recent = [];
    this.rollbackKeys.clear();
    this.retryKeys.clear();
    this.toastHistory.clear();
    this.counters = {
      handled: 0,
      rollbackCount: 0,
      retryRecommendations: 0,
      dedupedToastCount: 0,
      toastCount: 0,
    };
  }

  #attach(error, result, context) {
    if (!error || typeof error !== "object" || context.attach === false) return;
    try {
      error.recovery = result;
    } catch {}
  }

  #record(entry) {
    this.recent.push({
      ...entry,
      createdAt: nowMs(),
    });
    if (this.recent.length > RECENT_LIMIT) {
      this.recent.splice(0, this.recent.length - RECENT_LIMIT);
    }
  }
}

export const recoveryCenter = new RecoveryCenter();

if (typeof window !== "undefined") {
  const expose = () => {
    const debug =
      import.meta.env?.DEV ||
      window.localStorage?.getItem?.("athenaRecoveryDebug") === "true";
    if (!debug) return;
    window.__athenaRecoveryCenter = {
      snapshot: () => recoveryCenter.snapshot(),
    };
  };
  expose();
}

export default recoveryCenter;
