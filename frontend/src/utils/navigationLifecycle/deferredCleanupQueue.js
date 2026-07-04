import { markTaskPerformance } from "../tasks/taskScheduler.js";
import { routeScopeKey } from "./routeScope.js";

function scheduleIdle(callback) {
  if (typeof window !== "undefined" && window.requestIdleCallback) {
    return window.requestIdleCallback(callback, { timeout: 1_500 });
  }
  return setTimeout(
    () => callback({ didTimeout: true, timeRemaining: () => 0 }),
    0
  );
}

function cancelIdle(handle) {
  if (typeof window !== "undefined" && window.cancelIdleCallback) {
    window.cancelIdleCallback(handle);
    return;
  }
  clearTimeout(handle);
}

export class DeferredCleanupQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.handle = null;
    this.completed = [];
  }

  enqueue(scope = {}, cleanupFn = null, options = {}) {
    if (typeof cleanupFn !== "function") return null;
    const item = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      scope: { ...(scope || {}) },
      scopeKey: routeScopeKey(scope),
      cleanupFn,
      reason: options.reason || "deferred-cleanup",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.queue.push(item);
    this.#schedule();
    return item.id;
  }

  snapshot() {
    return {
      pending: this.queue.map((item) => this.#serialize(item)),
      running: this.running,
      completed: this.completed.slice(-20).map((item) => this.#serialize(item)),
    };
  }

  clear() {
    if (this.handle) cancelIdle(this.handle);
    this.handle = null;
    this.running = false;
    this.queue = [];
  }

  #schedule() {
    if (this.handle || this.running || !this.queue.length) return;
    this.handle = scheduleIdle(() => {
      this.handle = null;
      void this.#runNext();
    });
  }

  async #runNext() {
    const item = this.queue.shift();
    if (!item) return;
    this.running = true;
    item.startedAt = Date.now();
    markTaskPerformance("navigation_deferred_cleanup_started", {
      scope: item.scope,
      reason: item.reason,
    });
    try {
      await item.cleanupFn();
    } catch {
      // Deferred cleanup is best-effort; recovery is handled by callers.
    } finally {
      item.finishedAt = Date.now();
      this.completed.push(item);
      if (this.completed.length > 50)
        this.completed.splice(0, this.completed.length - 50);
      markTaskPerformance("navigation_deferred_cleanup_done", {
        scope: item.scope,
        reason: item.reason,
        durationMs: item.finishedAt - item.startedAt,
      });
      this.running = false;
      this.#schedule();
    }
  }

  #serialize(item) {
    return {
      id: item.id,
      scope: item.scope,
      scopeKey: item.scopeKey,
      reason: item.reason,
      ageMs: Math.max(0, Date.now() - item.createdAt),
      durationMs:
        item.finishedAt && item.startedAt
          ? item.finishedAt - item.startedAt
          : null,
    };
  }
}

export const deferredCleanupQueue = new DeferredCleanupQueue();
