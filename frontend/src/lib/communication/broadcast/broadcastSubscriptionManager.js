const listeners = new Set();

function normalizeScope(scope = {}) {
  if (typeof scope === "string") return { channel: scope };
  if (!scope || typeof scope !== "object") return null;
  return {
    channel: scope.channel || null,
    visibility: scope.visibility || null,
    scope: scope.scope && typeof scope.scope === "object" ? scope.scope : {},
  };
}

function keyFor(scope = {}) {
  return JSON.stringify(scope);
}

class BroadcastSubscriptionManager {
  constructor() {
    this.permanentScopes = new Map();
    this.visibleScopes = new Map();
    this.setPermanentScopes([
      { visibility: "user" },
      { visibility: "client" },
      { channel: "security" },
    ]);
  }

  setPermanentScopes(scopes = []) {
    this.permanentScopes.clear();
    for (const scope of scopes.map(normalizeScope).filter(Boolean)) {
      this.permanentScopes.set(keyFor(scope), scope);
    }
    this.#emit();
  }

  setVisibleScopes(scopes = []) {
    this.visibleScopes.clear();
    for (const scope of scopes.map(normalizeScope).filter(Boolean)) {
      this.visibleScopes.set(keyFor(scope), scope);
    }
    this.#emit();
    return this.scopes();
  }

  addVisibleScope(scope = {}) {
    const normalized = normalizeScope(scope);
    if (!normalized) return this.scopes();
    this.visibleScopes.set(keyFor(normalized), normalized);
    this.#emit();
    return this.scopes();
  }

  removeVisibleScope(scope = {}) {
    const normalized = normalizeScope(scope);
    if (!normalized) return this.scopes();
    this.visibleScopes.delete(keyFor(normalized));
    this.#emit();
    return this.scopes();
  }

  scopes() {
    return [...this.permanentScopes.values(), ...this.visibleScopes.values()];
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    listener(this.scopes());
    return () => listeners.delete(listener);
  }

  snapshot() {
    return {
      permanent: [...this.permanentScopes.values()],
      visible: [...this.visibleScopes.values()],
      total: this.scopes().length,
    };
  }

  #emit() {
    const scopes = this.scopes();
    listeners.forEach((listener) => {
      try {
        listener(scopes);
      } catch {}
    });
  }
}

export const broadcastSubscriptionManager = new BroadcastSubscriptionManager();

export function visibleBroadcastScopesForPath(pathname = "") {
  const path = String(pathname || "");
  const scopes = [];
  const workspaceMatch = path.match(/\/workspace\/([^/]+)/);
  const threadMatch = path.match(/\/t\/([^/?#]+)/);
  if (workspaceMatch?.[1]) {
    scopes.push({
      visibility: "workspace",
      scope: { workspaceSlug: decodeURIComponent(workspaceMatch[1]) },
    });
  }
  if (workspaceMatch?.[1] && threadMatch?.[1]) {
    scopes.push({
      visibility: "thread",
      scope: {
        workspaceSlug: decodeURIComponent(workspaceMatch[1]),
        threadSlug: decodeURIComponent(threadMatch[1]),
      },
    });
  }
  if (path.includes("/settings")) {
    scopes.push({ visibility: "user", scope: { route: "settings" } });
  }
  if (path.includes("/admin")) {
    scopes.push({ visibility: "admin", scope: { route: "admin" } });
  }
  if (path.includes("crypto-center")) {
    scopes.push({ channel: "crypto", scope: { route: "crypto-center" } });
  }
  return scopes;
}
