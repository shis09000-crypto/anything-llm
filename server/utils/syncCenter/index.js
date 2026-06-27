const EventEmitter = require("events");
const { v4: uuidv4 } = require("uuid");

const SYNC_CENTER_EVENT = "informationSyncEvent";
const syncCenterEvents = new EventEmitter();
syncCenterEvents.setMaxListeners(1_000);

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

function normalizeSyncEvent(event = {}) {
  const namespace = String(event.namespace || "").trim();
  const type = String(event.type || "").trim();
  if (!namespace || !type) return null;

  const scope = normalizeObject(event.scope);
  const resource = normalizeObject(event.resource);
  const origin = normalizeObject(event.origin);
  const payload = normalizeObject(event.payload);

  return {
    eventId: event.eventId || uuidv4(),
    namespace,
    type,
    scope: {
      userId: normalizeNumber(scope.userId),
      workspaceId: normalizeNumber(scope.workspaceId),
      threadId: normalizeNumber(scope.threadId),
      ...Object.fromEntries(
        Object.entries(scope).filter(
          ([key]) => !["userId", "workspaceId", "threadId"].includes(key)
        )
      ),
    },
    resource: {
      kind: resource.kind || namespace,
      id: resource.id ?? null,
      publicId: resource.publicId ?? null,
      ...Object.fromEntries(
        Object.entries(resource).filter(
          ([key]) => !["kind", "id", "publicId"].includes(key)
        )
      ),
    },
    origin: {
      clientId: origin.clientId || null,
      requestId: origin.requestId || null,
      ...Object.fromEntries(
        Object.entries(origin).filter(
          ([key]) => !["clientId", "requestId"].includes(key)
        )
      ),
    },
    payload,
    createdAt: event.createdAt || new Date().toISOString(),
  };
}

function publishSyncEvent(event = {}) {
  const payload = normalizeSyncEvent(event);
  if (!payload) return null;
  syncCenterEvents.emit(SYNC_CENTER_EVENT, payload);
  return payload;
}

function subscribeToSyncEvents(handler) {
  syncCenterEvents.on(SYNC_CENTER_EVENT, handler);
  return () => syncCenterEvents.off(SYNC_CENTER_EVENT, handler);
}

function syncEventVisibleToUser(event = {}, userId = null) {
  const scopedUserId = normalizeNumber(event?.scope?.userId);
  const normalizedUserId = normalizeNumber(userId);
  if (scopedUserId === null) return normalizedUserId === null;
  return scopedUserId === normalizedUserId;
}

module.exports = {
  publishSyncEvent,
  subscribeToSyncEvents,
  syncEventVisibleToUser,
  _internals: {
    SYNC_CENTER_EVENT,
    normalizeSyncEvent,
    syncCenterEvents,
  },
};
