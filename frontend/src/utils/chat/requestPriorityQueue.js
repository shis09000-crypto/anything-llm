const PRIORITY_ORDER = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

class RequestPriorityQueue {
  constructor({ concurrency = 3 } = {}) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.pausedPriorities = new Set();
  }

  schedule(task, { priority = "P2", label = "request", signal = null } = {}) {
    if (typeof task !== "function") return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const entry = {
        task,
        priority,
        label,
        signal,
        resolve,
        reject,
        createdAt: performance.now(),
      };
      this.queue.push(entry);
      this.queue.sort((a, b) => {
        const rank = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        return rank !== 0 ? rank : a.createdAt - b.createdAt;
      });
      this.flush();
    });
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

  flush() {
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
