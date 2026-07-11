const EventEmitter = require("events");
const { v4: uuidv4 } = require("uuid");
const {
  broadcastTransportSummary,
  ensureBroadcastTransportSupported,
} = require("./transportRegistry");
const { DataAccessCenter } = require("../dataAccess");
const { enqueueSyncPush } = require("../nativePush/apnsProvider");

const SyncEvent = DataAccessCenter.syncEvent;

const BROADCAST_EVENT = "athenaBroadcastEvent";
const DEFAULT_COALESCE_MS = 150;
const EVENT_STORE_LIMIT = 1_000;
const EVENT_STORE_TTL_MS = 30 * 60 * 1_000;
const PRIORITY_RANK = { critical: 0, normal: 1, background: 2 };
const CRITICAL_TYPES = new Set([
  "client.revoked",
  "signingSecret.rotated",
  "sensitiveSession.revoked",
]);
const BACKGROUND_TYPES = new Set([
  "reader.thumbnail.ready",
  "reader.classification.ready",
  "workspace.health.changed",
]);
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|credential|authorization|apikey|api_key|private|sensitiveSession|pdfContent|documentContent)/i;

const broadcastEvents = new EventEmitter();
broadcastEvents.setMaxListeners(1_000);
const eventStore = [];
const pendingCoalesced = new Map();
const connections = new Map();
const counters = {
  published: 0,
  coalesced: 0,
  fanout: 0,
  replayed: 0,
  syncRequired: 0,
  acked: 0,
  droppedSensitive: 0,
  transportErrors: 0,
  persistenceErrors: 0,
};
let lastTransportWarningAt = 0;
let durableCommitQueue = Promise.resolve();

function normalizeNumber(value = null) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeObject(value = {}) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function compactString(value, maxLength = 512) {
  if (value === null || value === undefined) return null;
  const next = String(value);
  return next.length > maxLength ? `${next.slice(0, maxLength)}…` : next;
}

function splitEventType(event = {}) {
  const namespace = String(event.namespace || "").trim();
  const type = String(event.type || "").trim();
  if (namespace && type) return { namespace, type };
  if (type && type.includes(".")) {
    const [namespace, ...rest] = String(event.type).split(".");
    return { namespace, type: rest.join(".") };
  }
  return { namespace, type };
}

function dottedType(event = {}) {
  const { namespace, type } = splitEventType(event);
  return namespace && type ? `${namespace}.${type}` : "";
}

function normalizePriority(event = {}) {
  const explicit = String(event.eventPriority || "").trim();
  if (Object.prototype.hasOwnProperty.call(PRIORITY_RANK, explicit)) {
    return explicit;
  }
  const type = dottedType(event);
  if (CRITICAL_TYPES.has(type)) return "critical";
  if (BACKGROUND_TYPES.has(type)) return "background";
  return "normal";
}

function inferVisibility(event = {}) {
  if (event.visibility) return String(event.visibility);
  if (event.scope?.clientId) return "client";
  if (event.scope?.readerDocumentId) return "reader";
  if (event.scope?.threadId || event.payload?.threadSlug) return "thread";
  if (event.scope?.workspaceId || event.payload?.workspaceSlug)
    return "workspace";
  if (event.namespace === "admin") return "admin";
  return "user";
}

function eventFamily(event = {}) {
  const type = dottedType(event);
  if (!type) return "unknown";
  if (type.startsWith("reader.postprocess")) return "reader.postprocess";
  if (type.startsWith("reader.thumbnail")) return "reader.thumbnail";
  if (type.startsWith("reader.classification")) return "reader.classification";
  return type;
}

function normalizeScope(scope = {}) {
  const source = normalizeObject(scope);
  return {
    userId: normalizeNumber(source.userId),
    workspaceId: normalizeNumber(source.workspaceId),
    threadId: normalizeNumber(source.threadId),
    ...(source.workspaceSlug
      ? { workspaceSlug: String(source.workspaceSlug) }
      : {}),
    ...(source.threadSlug ? { threadSlug: String(source.threadSlug) } : {}),
    ...(source.readerDocumentId
      ? { readerDocumentId: String(source.readerDocumentId) }
      : {}),
    ...(source.clientId ? { clientId: String(source.clientId) } : {}),
    ...Object.fromEntries(
      Object.entries(source).filter(
        ([key]) =>
          ![
            "userId",
            "workspaceId",
            "threadId",
            "workspaceSlug",
            "threadSlug",
            "readerDocumentId",
            "clientId",
          ].includes(key)
      )
    ),
  };
}

function normalizeResource(resource = {}, namespace = "") {
  const source = normalizeObject(resource);
  return {
    kind: source.kind || namespace || "event",
    id: source.id ?? null,
    publicId: source.publicId ?? null,
    ...Object.fromEntries(
      Object.entries(source).filter(
        ([key]) => !["kind", "id", "publicId"].includes(key)
      )
    ),
  };
}

function redactPayload(value, depth = 0) {
  if (depth > 5) return null;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return compactString(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => redactPayload(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const blocked = SENSITIVE_KEY_PATTERN.test(key);
        if (blocked) counters.droppedSensitive += 1;
        return !blocked;
      })
      .map(([key, entryValue]) => [key, redactPayload(entryValue, depth + 1)])
  );
}

function scopeSummary(scope = {}) {
  return [
    scope.userId !== null && scope.userId !== undefined
      ? `u:${scope.userId}`
      : "u:null",
    scope.workspaceId ? `w:${scope.workspaceId}` : null,
    scope.workspaceSlug ? `ws:${scope.workspaceSlug}` : null,
    scope.threadId ? `t:${scope.threadId}` : null,
    scope.threadSlug ? `ts:${scope.threadSlug}` : null,
    scope.readerDocumentId ? `r:${scope.readerDocumentId}` : null,
    scope.clientId ? `c:${scope.clientId}` : null,
  ]
    .filter(Boolean)
    .join("|");
}

function coalesceKeyFor(event = {}) {
  if (event.coalesceKey) return String(event.coalesceKey);
  const resource = event.resource || {};
  return [
    event.visibility,
    scopeSummary(event.scope),
    resource.kind || "event",
    resource.id ?? resource.publicId ?? "none",
    eventFamily(event),
  ].join(":");
}

function normalizeBroadcastEvent(event = {}) {
  const { namespace, type } = splitEventType(event);
  if (!namespace || !type) return null;
  const scope = normalizeScope(event.scope);
  const resource = normalizeResource(event.resource, namespace);
  const eventPriority = normalizePriority({ ...event, namespace, type });
  const payload = redactPayload(normalizeObject(event.payload));
  const normalized = {
    eventId: event.eventId || uuidv4(),
    type: `${namespace}.${type}`,
    namespace,
    eventType: type,
    // Legacy consumers still expect event.type to be the short type.
    shortType: type,
    scope,
    visibility: inferVisibility({ ...event, namespace, type, scope, payload }),
    eventPriority,
    version: normalizeNumber(event.version ?? event.revision) || Date.now(),
    revision: normalizeNumber(event.revision ?? event.version) || null,
    createdAt: event.createdAt || new Date().toISOString(),
    sourceClientId:
      event.sourceClientId || event.origin?.clientId || event.clientId || null,
    sourceActionId: event.sourceActionId || event.origin?.actionId || null,
    sourceRequestId:
      event.sourceRequestId ||
      event.origin?.requestId ||
      event.requestId ||
      null,
    origin: {
      clientId:
        event.sourceClientId ||
        event.origin?.clientId ||
        event.clientId ||
        null,
      requestId:
        event.sourceRequestId ||
        event.origin?.requestId ||
        event.requestId ||
        null,
      actionId: event.sourceActionId || event.origin?.actionId || null,
    },
    resource,
    payload,
    sensitive: Boolean(event.sensitive),
    requiresAck: event.requiresAck !== false,
    coalesceKey: null,
    coalescedCount: Number(event.coalescedCount || 0) || 0,
  };
  normalized.coalesceKey = coalesceKeyFor(normalized);
  return normalized;
}

function legacyShape(event = {}) {
  return {
    ...event,
    type: event.shortType || event.eventType || event.type,
    broadcastType: event.type,
    namespace: event.namespace,
    eventPriority: event.eventPriority,
  };
}

function mergeEvents(previous, next) {
  const previousRank = PRIORITY_RANK[previous.eventPriority] ?? 1;
  const nextRank = PRIORITY_RANK[next.eventPriority] ?? 1;
  const highestPriority =
    nextRank < previousRank ? next.eventPriority : previous.eventPriority;
  const previousVersion = Number(previous.version || 0);
  const nextVersion = Number(next.version || 0);
  const winner = nextVersion >= previousVersion ? next : previous;
  return {
    ...previous,
    ...winner,
    eventPriority: highestPriority,
    payload: {
      ...(previous.payload || {}),
      ...(next.payload || {}),
    },
    version: Math.max(previousVersion, nextVersion),
    revision:
      Math.max(Number(previous.revision || 0), Number(next.revision || 0)) ||
      null,
    createdAt: next.createdAt || previous.createdAt,
    coalescedCount: (previous.coalescedCount || 0) + 1,
  };
}

function pruneEventStore() {
  const cutoff = Date.now() - EVENT_STORE_TTL_MS;
  while (eventStore.length > EVENT_STORE_LIMIT) eventStore.shift();
  while (eventStore.length) {
    const createdAt = Date.parse(eventStore[0].createdAt);
    if (!Number.isFinite(createdAt) || createdAt >= cutoff) break;
    eventStore.shift();
  }
}

function sendJson(socket, payload) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function eventScopeValue(event = {}, key = "") {
  return (
    event.scope?.[key] ??
    event.payload?.[key] ??
    event.resource?.[key] ??
    event.origin?.[key] ??
    null
  );
}

function subscriptionMatches(event = {}, subscription = {}) {
  const channel = subscription.channel || null;
  if (channel === "security") return CRITICAL_TYPES.has(event.type);
  if (channel && channel !== event.namespace && channel !== event.type)
    return false;
  if (subscription.visibility && subscription.visibility !== event.visibility)
    return false;

  const scope = normalizeObject(subscription.scope);
  return Object.entries(scope).every(([key, value]) => {
    if (value === undefined || value === null || value === "") return true;
    return String(eventScopeValue(event, key) ?? "") === String(value);
  });
}

function normalizeSubscription(subscription = {}) {
  if (typeof subscription === "string") return { channel: subscription };
  if (!subscription || typeof subscription !== "object") return null;
  return {
    channel: subscription.channel || null,
    visibility: subscription.visibility || null,
    scope: normalizeObject(subscription.scope),
  };
}

function defaultSubscriptions(connection = {}) {
  return [
    { visibility: "user" },
    { channel: "security" },
    { visibility: "client", scope: { clientId: connection.clientId } },
  ];
}

function userCanSeeEvent(event = {}, connection = {}) {
  if (event.visibility === "client") {
    const targetClientId = event.scope?.clientId || event.payload?.clientId;
    return (
      !!targetClientId && String(targetClientId) === String(connection.clientId)
    );
  }
  const eventUserId = normalizeNumber(event.scope?.userId);
  const connectionUserId = normalizeNumber(connection.userId);
  if (eventUserId === null) return connectionUserId === null;
  return eventUserId === connectionUserId;
}

function connectionSubscribedToEvent(event = {}, connection = {}) {
  if (!userCanSeeEvent(event, connection)) return false;
  const subscriptions = connection.subscriptions?.size
    ? [...connection.subscriptions.values()]
    : defaultSubscriptions(connection);
  return subscriptions.some((subscription) =>
    subscriptionMatches(event, subscription)
  );
}

function fanout(event) {
  for (const connection of connections.values()) {
    if (!connectionSubscribedToEvent(event, connection)) continue;
    if (connection.send(event)) counters.fanout += 1;
  }
}

function commitLiveEvent(event) {
  pruneEventStore();
  eventStore.push(event);
  counters.published += 1;
  broadcastEvents.emit(BROADCAST_EVENT, legacyShape(event));
  fanout(event);
  enqueueSyncPush(event);
  return event;
}

function commitEvent(event) {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.ATHENA_SYNC_EVENT_TEST_PERSIST !== "true"
  ) {
    return commitLiveEvent(event);
  }
  durableCommitQueue = durableCommitQueue
    .then(async () => {
      const persisted = await SyncEvent.persist(event);
      commitLiveEvent(persisted || event);
    })
    .catch((error) => {
      counters.persistenceErrors += 1;
      console.error("[BroadcastCenter] durable event persistence failed", {
        eventId: event.eventId,
        type: event.type,
        code: error?.code || "persistence_failed",
      });
    });
  return event;
}

async function flushDurableCommits() {
  await durableCommitQueue;
}

function flushCoalesced(key) {
  const pending = pendingCoalesced.get(key);
  if (!pending) return null;
  clearTimeout(pending.timer);
  pendingCoalesced.delete(key);
  return commitEvent(pending.event);
}

function publishBroadcastEvent(event = {}, options = {}) {
  const transport = ensureBroadcastTransportSupported();
  if (!transport.ok) {
    counters.transportErrors += 1;
    const now = Date.now();
    if (now - lastTransportWarningAt > 30_000) {
      lastTransportWarningAt = now;
      console.warn(`[BroadcastCenter] ${transport.code}: ${transport.warning}`);
    }
    return null;
  }

  const normalized = normalizeBroadcastEvent(event);
  if (!normalized) return null;
  const coalesceMs = Number(options.coalesceMs ?? DEFAULT_COALESCE_MS);
  const shouldCoalesce =
    normalized.eventPriority !== "critical" &&
    options.coalesce !== false &&
    coalesceMs > 0;

  if (!shouldCoalesce) return commitEvent(normalized);

  const existing = pendingCoalesced.get(normalized.coalesceKey);
  if (existing) {
    existing.event = mergeEvents(existing.event, normalized);
    counters.coalesced += 1;
    return normalized;
  }

  const timer = setTimeout(
    () => flushCoalesced(normalized.coalesceKey),
    coalesceMs
  );
  pendingCoalesced.set(normalized.coalesceKey, {
    event: normalized,
    timer,
  });
  return normalized;
}

function subscribeToBroadcastEvents(handler) {
  broadcastEvents.on(BROADCAST_EVENT, handler);
  return () => broadcastEvents.off(BROADCAST_EVENT, handler);
}

function syncRequiredEvent({
  userId = null,
  reason = "replay-window-missed",
} = {}) {
  counters.syncRequired += 1;
  return normalizeBroadcastEvent({
    namespace: "sync",
    type: "required",
    eventPriority: "critical",
    visibility: "user",
    scope: { userId },
    payload: { reason },
    requiresAck: true,
    coalesceKey: `sync.required:${userId || "single"}`,
  });
}

function replayBroadcastEvents({
  userId = null,
  clientId = null,
  lastEventId = null,
  subscriptions = [],
} = {}) {
  if (!lastEventId) return [];
  pruneEventStore();
  const index = eventStore.findIndex((event) => event.eventId === lastEventId);
  if (index === -1) return [syncRequiredEvent({ userId })];

  const connection = {
    userId,
    clientId,
    subscriptions: new Map(
      subscriptions
        .map(normalizeSubscription)
        .filter(Boolean)
        .map((subscription, index) => [String(index), subscription])
    ),
  };
  const events = eventStore
    .slice(index + 1)
    .filter((event) => connectionSubscribedToEvent(event, connection));
  counters.replayed += events.length;
  return events;
}

async function replayDurableBroadcastEvents({
  userId = null,
  clientId = null,
  lastEventId = null,
  subscriptions = [],
  limit = 200,
} = {}) {
  const result = await SyncEvent.replay({
    userId,
    clientId,
    afterEventId: lastEventId,
    limit,
  });
  if (result.requiresFullSync) {
    const required = syncRequiredEvent({ userId });
    required.payload.checkpointEventId = result.checkpointEventId;
    return [required];
  }
  const connection = {
    userId,
    clientId,
    subscriptions: new Map(
      subscriptions
        .map(normalizeSubscription)
        .filter(Boolean)
        .map((subscription, index) => [String(index), subscription])
    ),
  };
  const events = result.events.filter((event) =>
    connectionSubscribedToEvent(event, connection)
  );
  counters.replayed += events.length;
  return events;
}

function connectionId() {
  return `broadcast:${uuidv4()}`;
}

function subscriptionKey(subscription = {}) {
  return JSON.stringify(subscription);
}

function registerConnection({ socket, userId = null, clientId = null } = {}) {
  const id = connectionId();
  const connection = {
    id,
    socket,
    userId,
    clientId,
    subscriptions: new Map(
      defaultSubscriptions({ clientId }).map((subscription) => [
        subscriptionKey(subscription),
        subscription,
      ])
    ),
    acked: new Set(),
    lastAckedEventId: null,
    send(event) {
      return sendJson(socket, {
        type: "broadcast.event",
        event: legacyShape(event),
      });
    },
  };
  connections.set(id, connection);
  return connection;
}

function removeConnection(connection) {
  if (!connection?.id) return;
  connections.delete(connection.id);
}

const broadcastCenter = {
  subscribe(connection, scopes = []) {
    if (!connection) return [];
    const normalized = (Array.isArray(scopes) ? scopes : [scopes])
      .map(normalizeSubscription)
      .filter(Boolean);
    normalized.forEach((subscription) =>
      connection.subscriptions.set(subscriptionKey(subscription), subscription)
    );
    return [...connection.subscriptions.values()];
  },

  unsubscribe(connection, scopes = []) {
    if (!connection) return [];
    const normalized = (Array.isArray(scopes) ? scopes : [scopes])
      .map(normalizeSubscription)
      .filter(Boolean);
    normalized.forEach((subscription) =>
      connection.subscriptions.delete(subscriptionKey(subscription))
    );
    return [...connection.subscriptions.values()];
  },

  ack(connection, eventId) {
    if (!connection || !eventId) return false;
    connection.acked.add(eventId);
    connection.lastAckedEventId = eventId;
    counters.acked += 1;
    return true;
  },

  replay(options = {}) {
    return replayBroadcastEvents(options);
  },

  replayDurable(options = {}) {
    return replayDurableBroadcastEvents(options);
  },

  registerConnection,
  removeConnection,

  snapshot() {
    return {
      transport: broadcastTransportSummary(),
      connections: connections.size,
      eventStoreSize: eventStore.length,
      pendingCoalesced: pendingCoalesced.size,
      counters: { ...counters },
      byPriority: eventStore.reduce((acc, event) => {
        acc[event.eventPriority] = (acc[event.eventPriority] || 0) + 1;
        return acc;
      }, {}),
      byScope: eventStore.reduce((acc, event) => {
        const key = scopeSummary(event.scope);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    };
  },
};

module.exports = {
  publishBroadcastEvent,
  subscribeToBroadcastEvents,
  replayBroadcastEvents,
  replayDurableBroadcastEvents,
  broadcastCenter,
  _internals: {
    BROADCAST_EVENT,
    DEFAULT_COALESCE_MS,
    normalizeBroadcastEvent,
    mergeEvents,
    flushCoalesced,
    flushDurableCommits,
    commitLiveEvent,
    broadcastEvents,
    pendingCoalesced,
    eventStore,
    connections,
    connectionSubscribedToEvent,
    broadcastTransportSummary,
  },
};
