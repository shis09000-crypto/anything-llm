import { AUTH_SESSION_CLEARED_EVENT } from "@/utils/authTokenStorage";

export const SENSITIVE_SESSION_HEADER = "X-Athena-Sensitive-Session";
const NAVIGATION_PAGE_LIFECYCLE_EVENT = "athena-navigation-page-lifecycle";
const SENSITIVE_REVOKE_PAGE_EVENTS = new Set(["pagehide", "beforeunload"]);

function sensitiveSessionDebug(stage, detail = {}) {
  if (typeof window === "undefined") return;
  const payload = {
    stage,
    at: Math.round(window.performance?.now?.() || Date.now()),
    ...detail,
  };
  window.dispatchEvent(
    new CustomEvent("athena-sensitive-session-stage", { detail: payload })
  );
  const debugEnabled =
    window.__ATHENA_READER_DEBUG__ === true ||
    window.localStorage?.getItem?.("athenaReaderDebug") === "true" ||
    window.location?.search?.includes("athenaReaderDebug=1");
  if (debugEnabled) console.debug("[sensitive-session]", payload);
}

function nowMs() {
  return Date.now();
}

function parseExpiry(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

async function postJson(path, body, options) {
  const client = await import("@/lib/communication/apiClient");
  return client.postJson(path, body, options);
}

function sensitiveSessionTask({
  action,
  session = null,
  target = {},
  priority = "P1",
} = {}) {
  const resourceType =
    target.resourceType || session?.resourceType || "sensitive-session";
  const resourceIdentity = target.resourceId || session?.resourceId || "global";
  const ownerIdentity = target.ownerScope || session?.ownerScope || "global";
  const hasResourceId = Boolean(target.resourceId || session?.resourceId);
  const hasOwnerScope = Boolean(target.ownerScope || session?.ownerScope);
  return {
    kind: "sensitive-session",
    label: `sensitive-session:${action || "request"}`,
    scope: {
      domain: "sensitive-session",
      action: action || "request",
      resourceType,
      hasResourceId,
      hasOwnerScope,
    },
    priority,
    policy: priority === "P0" ? "foreground" : "visible",
    resource: "network",
    protected: true,
    abortable: false,
    dedupeKey: `sensitive-session:${action || "request"}:${resourceType}:${
      resourceIdentity || "global"
    }:${ownerIdentity || "global"}`,
  };
}

function sensitiveRequestOptions({
  action,
  session = null,
  target = {},
  priority = "P1",
  headers = {},
} = {}) {
  return {
    signing: "required",
    communicationScene: "sensitive-session",
    headers,
    task: sensitiveSessionTask({ action, session, target, priority }),
  };
}

function sessionKey({
  resourceType = "sensitive",
  resourceId = "global",
} = {}) {
  return `${resourceType}:${resourceId || "global"}`;
}

function uniqueAliasKeys(resourceType, resourceIds = [], primaryKey = null) {
  const seen = new Set();
  return (Array.isArray(resourceIds) ? resourceIds : [resourceIds])
    .map((resourceId) => sessionKey({ resourceType, resourceId }))
    .filter((key) => {
      if (!key || key === primaryKey || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

class SensitiveSessionCenter {
  constructor() {
    this.sessions = new Map();
    this.aliases = new Map();
    this.heartbeats = new Map();
    this.counters = {
      stored: 0,
      expired: 0,
      revoked: 0,
      heartbeats: 0,
      viewersOpened: 0,
      viewersClosed: 0,
      scopeRevoked: 0,
    };
    this.guardInstalled = false;
  }

  store(record = {}, options = {}) {
    const token = record.token || record.sessionId;
    if (!token) return null;
    const resourceType =
      options.resourceType || record.resourceType || "sensitive";
    const resourceId = options.resourceId || record.resourceId || "global";
    const key = sessionKey({ resourceType, resourceId });
    const aliasKeys = uniqueAliasKeys(
      resourceType,
      options.aliasResourceIds || record.aliasResourceIds || [],
      key
    );
    const expiresAt = parseExpiry(record.expiresAt);
    const session = {
      key,
      token,
      sessionId: record.sessionId || token,
      resourceType,
      resourceId,
      ownerScope: options.ownerScope || record.ownerScope || null,
      trustLevel: record.trustLevel || "verified",
      createdAt: record.createdAt || new Date().toISOString(),
      openedAt: options.viewer ? new Date().toISOString() : null,
      lastUsedAt: new Date().toISOString(),
      viewer: options.viewer === true,
      expiresAt,
      status: record.status || "active",
    };
    this.#clearKey(key);
    this.sessions.set(key, session);
    aliasKeys.forEach((aliasKey) => {
      this.aliases.set(aliasKey, key);
    });
    this.counters.stored += 1;
    sensitiveSessionDebug("store", {
      resourceType,
      resourceId,
      ownerScope: session.ownerScope,
      hasAliases: aliasKeys.length > 0,
      viewer: session.viewer,
      expiresInMs: expiresAt ? Math.max(0, expiresAt - nowMs()) : null,
    });
    this.#scheduleHeartbeat(session);
    this.#expose();
    return session;
  }

  beginViewer(record = {}, options = {}) {
    const resourceType =
      options.resourceType || record.resourceType || "sensitive";
    const resourceId = options.resourceId || record.resourceId || "global";
    const key = sessionKey({ resourceType, resourceId });

    if (options.exclusiveByResourceType) {
      [...this.sessions.values()]
        .filter(
          (session) =>
            session.resourceType === resourceType && session.key !== key
        )
        .forEach((session) => {
          void this.revoke(session, options.reason || "viewer-switch");
        });
    }

    const session = this.store(record, {
      ...options,
      resourceType,
      resourceId,
      viewer: true,
    });
    if (session) this.counters.viewersOpened += 1;
    return session;
  }

  endViewer(target = {}, reason = "viewer-close") {
    const session = this.get(target);
    if (session?.viewer) this.counters.viewersClosed += 1;
    return this.revoke(target, reason);
  }

  get({ resourceType = "sensitive", resourceId = "global" } = {}) {
    const key = this.#canonicalKey(sessionKey({ resourceType, resourceId }));
    const session = this.sessions.get(key);
    if (!session?.token) return null;
    if (session.expiresAt && session.expiresAt <= nowMs()) {
      this.counters.expired += 1;
      this.clear({ resourceType, resourceId });
      return null;
    }
    session.lastUsedAt = new Date().toISOString();
    return { ...session };
  }

  headers(target = {}) {
    const session = this.get(target);
    return session?.token ? { [SENSITIVE_SESSION_HEADER]: session.token } : {};
  }

  clear(target = null) {
    if (!target) {
      for (const key of this.sessions.keys()) this.#clearKey(key);
      this.aliases.clear();
      return;
    }
    this.#clearKey(sessionKey(target));
  }

  revoke(target = {}, reason = "manual") {
    const session = this.get(target);
    this.clear(target);
    if (!session?.token)
      return Promise.resolve({ success: true, revoked: false });
    this.counters.revoked += 1;
    return postJson(
      "/sensitive-sessions/revoke",
      {
        sessionId: session.token,
        reason,
      },
      sensitiveRequestOptions({
        action: "revoke",
        session,
        priority: "P0",
      })
    )
      .then(({ data }) => data || { success: true })
      .catch(() => ({ success: false }));
  }

  installGuards() {
    if (this.guardInstalled || typeof window === "undefined") return;
    this.guardInstalled = true;
    window.addEventListener(NAVIGATION_PAGE_LIFECYCLE_EVENT, (event) => {
      const lifecycleEvent = event?.detail?.event;
      if (!SENSITIVE_REVOKE_PAGE_EVENTS.has(lifecycleEvent)) {
        sensitiveSessionDebug("page-lifecycle-preserve", {
          event: lifecycleEvent,
          reason: event?.detail?.reason || null,
          size: this.sessions.size,
        });
        return;
      }
      sensitiveSessionDebug("page-lifecycle-revoke-all", {
        event: lifecycleEvent,
        reason: event?.detail?.reason || null,
        size: this.sessions.size,
      });
      this.#revokeAll(event?.detail?.reason || `navigation-${lifecycleEvent}`);
    });
    window.addEventListener(AUTH_SESSION_CLEARED_EVENT, () => {
      this.clear();
    });
  }

  revokeScope(target = {}, reason = "scope-close") {
    const resourceType = target.resourceType || null;
    const resourceId = target.resourceId || null;
    const ownerScope = target.ownerScope || null;
    const matchingSessions = [...this.sessions.values()].filter((session) => {
      if (resourceType && session.resourceType !== resourceType) return false;
      if (resourceId && session.resourceId !== resourceId) return false;
      if (ownerScope && session.ownerScope !== ownerScope) return false;
      return true;
    });
    matchingSessions.forEach((session) => this.clear(session));
    this.counters.scopeRevoked += 1;
    return postJson(
      "/sensitive-sessions/revoke-scope",
      {
        resourceType,
        resourceId,
        ownerScope,
        reason,
      },
      sensitiveRequestOptions({
        action: "revoke-scope",
        target: { resourceType, resourceId, ownerScope },
        priority: "P0",
      })
    )
      .then(({ data }) => data || { success: true })
      .catch(() => ({ success: false }));
  }

  heartbeat(target = {}) {
    const session = this.get(target);
    return session
      ? this.#heartbeat(session)
      : Promise.resolve({ success: true, skipped: true });
  }

  snapshot() {
    const now = nowMs();
    return {
      size: this.sessions.size,
      counters: { ...this.counters },
      sessions: [...this.sessions.values()].map((session) => ({
        sessionId: session.sessionId ? "[redacted-sensitive-session]" : null,
        resourceType: session.resourceType,
        ownerScope: session.ownerScope ? "[redacted-owner-scope]" : null,
        trustLevel: session.trustLevel,
        status: session.status,
        viewer: session.viewer === true,
        openedAgeMs: session.openedAt
          ? Math.max(0, now - parseExpiry(session.openedAt))
          : null,
        lastUsedAgeMs: session.lastUsedAt
          ? Math.max(0, now - parseExpiry(session.lastUsedAt))
          : null,
        expiresInMs: session.expiresAt
          ? Math.max(0, session.expiresAt - now)
          : null,
      })),
      transport: {
        schedulerOnly: true,
        communicationScene: "sensitive-session",
        activeHeartbeatTimers: this.heartbeats.size,
      },
    };
  }

  #clearKey(key) {
    const canonicalKey = this.#canonicalKey(key);
    const existing = this.sessions.get(canonicalKey);
    this.sessions.delete(canonicalKey);
    for (const [aliasKey, targetKey] of this.aliases.entries()) {
      if (aliasKey === key || targetKey === canonicalKey) {
        this.aliases.delete(aliasKey);
      }
    }
    const heartbeat = this.heartbeats.get(canonicalKey);
    if (heartbeat) clearTimeout(heartbeat);
    this.heartbeats.delete(canonicalKey);
    if (existing) {
      sensitiveSessionDebug("clear", {
        resourceType: existing.resourceType,
        resourceId: existing.resourceId,
        ownerScope: existing.ownerScope,
        viewer: existing.viewer,
      });
    }
  }

  #canonicalKey(key) {
    return this.aliases.get(key) || key;
  }

  #scheduleHeartbeat(session) {
    const key = session.key;
    const existing = this.heartbeats.get(key);
    if (existing) clearTimeout(existing);
    if (!session.expiresAt) return;
    const delayMs = Math.max(
      15_000,
      Math.min(60_000, (session.expiresAt - nowMs()) / 2)
    );
    const timer = setTimeout(() => {
      void this.#heartbeat(session);
    }, delayMs);
    this.heartbeats.set(key, timer);
  }

  async #heartbeat(session) {
    const current = this.get(session);
    if (!current) return;
    try {
      await postJson(
        "/sensitive-sessions/heartbeat",
        {
          resourceType: current.resourceType,
          resourceId: current.resourceId,
          ownerScope: current.ownerScope,
          sensitiveSession: current.token,
        },
        sensitiveRequestOptions({
          action: "heartbeat",
          session: current,
          priority: "P1",
          headers: { [SENSITIVE_SESSION_HEADER]: current.token },
        })
      );
      this.counters.heartbeats += 1;
      this.#scheduleHeartbeat(current);
      return { success: true };
    } catch {
      this.clear(current);
      return { success: false };
    }
  }

  #revokeAll(reason) {
    if (!this.sessions.size) return;
    this.clear();
    this.counters.scopeRevoked += 1;
    void postJson(
      "/sensitive-sessions/revoke-scope",
      { reason },
      sensitiveRequestOptions({
        action: "revoke-all",
        priority: "P0",
      })
    ).catch(() => null);
  }

  #expose() {
    if (typeof window === "undefined") return;
    if (
      !import.meta.env?.DEV &&
      window.localStorage?.getItem?.("athenaRuntimeObserver") !== "true"
    ) {
      return;
    }
    window.__athenaSensitiveSessionCenter = {
      snapshot: () => this.snapshot(),
    };
  }
}

export const sensitiveSessionCenter = new SensitiveSessionCenter();
sensitiveSessionCenter.installGuards();
