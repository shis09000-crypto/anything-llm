const PRIORITY_ORDER = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

class RequestPriorityQueue {
  constructor({ concurrency = 3, maxPending = 48, staleMs = 45_000 } = {}) {
    this.concurrency = concurrency;
    this.maxPending = maxPending;
    this.staleMs = staleMs;
    this.active = 0;
    this.queue = [];
    this.pausedPriorities = new Set();
  }

  schedule(
    task,
    { priority = "P2", label = "request", signal = null, dedupeKey = null } = {}
  ) {
    if (typeof task !== "function") return Promise.resolve(null);
    if (dedupeKey) {
      const existing = this.queue.find(
        (entry) => entry.dedupeKey === dedupeKey
      );
      if (existing) return existing.promise;
    }

    this.prune();
    let entry = null;
    const promise = new Promise((resolve, reject) => {
      entry = {
        task,
        priority,
        label,
        signal,
        dedupeKey,
        resolve,
        reject,
        createdAt: performance.now(),
      };
    });
    entry.promise = promise;
    this.queue.push(entry);
    this.queue.sort((a, b) => {
      const rank = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      return rank !== 0 ? rank : a.createdAt - b.createdAt;
    });
    this.enforcePendingBudget();
    this.flush();
    return promise;
  }

  setPaused(priority, paused) {
    if (paused) this.pausedPriorities.add(priority);
    else this.pausedPriorities.delete(priority);
    this.flush();
  }

  clear(predicate = () => true) {
    const pending = [];
    for (const entry of this.queue) {
      if (predicate(entry)) {
        entry.resolve(null);
      } else {
        pending.push(entry);
      }
    }
    this.queue = pending;
  }

  prune() {
    const now = performance.now();
    this.clear(
      (entry) =>
        entry.signal?.aborted ||
        (entry.priority === "P3" && now - entry.createdAt > this.staleMs)
    );
  }

  enforcePendingBudget() {
    if (this.queue.length <= this.maxPending) return;
    const sorted = [...this.queue].sort((a, b) => {
      const rank = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
      return rank !== 0 ? rank : a.createdAt - b.createdAt;
    });
    const toDrop = new Set(
      sorted.slice(0, this.queue.length - this.maxPending)
    );
    this.queue = this.queue.filter((entry) => {
      if (!toDrop.has(entry)) return true;
      entry.resolve(null);
      return false;
    });
  }

  stats() {
    const byPriority = this.queue.reduce((acc, entry) => {
      acc[entry.priority] = (acc[entry.priority] || 0) + 1;
      return acc;
    }, {});
    return {
      active: this.active,
      pending: this.queue.length,
      byPriority,
      pausedPriorities: [...this.pausedPriorities],
      maxPending: this.maxPending,
      staleMs: this.staleMs,
    };
  }

  flush() {
    this.prune();
    while (this.active < this.concurrency) {
      const index = this.queue.findIndex(
        (entry) => !this.pausedPriorities.has(entry.priority)
      );
      if (index === -1) return;
      const [entry] = this.queue.splice(index, 1);
      if (entry.signal?.aborted) {
        entry.resolve(null);
        continue;
      }

      this.active += 1;
      Promise.resolve()
        .then(() => entry.task())
        .then(entry.resolve)
        .catch((error) => {
          if (entry.signal?.aborted || error?.name === "AbortError") {
            entry.resolve(null);
            return;
          }
          entry.reject(error);
        })
        .finally(() => {
          this.active -= 1;
          this.flush();
        });
    }
  }
}

export const requestPriorityQueue = new RequestPriorityQueue();
export { PRIORITY_ORDER, RequestPriorityQueue };
