import { routeScopeKey } from "./routeScope.js";

export class NavigationSnapshotStore {
  constructor({ maxEntries = 50 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  save(scope = {}, value = null, meta = {}) {
    const key = routeScopeKey(scope);
    if (!key) return null;
    const entry = {
      key,
      scope: { ...(scope || {}) },
      value,
      meta: { ...(meta || {}) },
      updatedAt: Date.now(),
    };
    this.entries.set(key, entry);
    this.#trim();
    return entry;
  }

  get(scope = {}) {
    const entry = this.entries.get(routeScopeKey(scope));
    return entry ? clone(entry) : null;
  }

  delete(scope = {}) {
    return this.entries.delete(routeScopeKey(scope));
  }

  snapshot() {
    return [...this.entries.values()].map((entry) => ({
      key: entry.key,
      scope: { ...entry.scope },
      updatedAt: entry.updatedAt,
      ageMs: Math.max(0, Date.now() - entry.updatedAt),
      meta: { ...entry.meta },
    }));
  }

  clear() {
    this.entries.clear();
  }

  #trim() {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.entries()].sort(
      ([, a], [, b]) => a.updatedAt - b.updatedAt
    );
    sorted.slice(0, this.entries.size - this.maxEntries).forEach(([key]) => {
      this.entries.delete(key);
    });
  }
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export const navigationSnapshotStore = new NavigationSnapshotStore();
