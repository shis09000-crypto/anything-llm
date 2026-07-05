const {
  publishBroadcastEvent,
  subscribeToBroadcastEvents,
  _internals: broadcastInternals,
} = require("../broadcast");

const SYNC_CENTER_EVENT = broadcastInternals.BROADCAST_EVENT;

function normalizeNumber(value = null) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publishSyncEvent(event = {}) {
  const payload = publishBroadcastEvent(event);
  return payload
    ? {
        ...payload,
        type: payload.shortType || payload.eventType || payload.type,
        broadcastType: payload.type,
      }
    : null;
}

function subscribeToSyncEvents(handler) {
  return subscribeToBroadcastEvents(handler);
}

function syncEventVisibleToUser(event = {}, userId = null, clientId = null) {
  const visibility = event?.visibility || null;
  const scopedUserId = normalizeNumber(event?.scope?.userId);
  const normalizedUserId = normalizeNumber(userId);
  if (visibility === "client") {
    const scopedClientId = event?.scope?.clientId || event?.payload?.clientId;
    return !!scopedClientId && String(scopedClientId) === String(clientId);
  }
  if (scopedUserId === null) return normalizedUserId === null;
  return scopedUserId === normalizedUserId;
}

module.exports = {
  publishSyncEvent,
  subscribeToSyncEvents,
  syncEventVisibleToUser,
  _internals: {
    SYNC_CENTER_EVENT,
    normalizeSyncEvent: broadcastInternals.normalizeBroadcastEvent,
    syncCenterEvents: broadcastInternals.broadcastEvents,
    flushCoalesced: broadcastInternals.flushCoalesced,
    pendingCoalesced: broadcastInternals.pendingCoalesced,
  },
};
