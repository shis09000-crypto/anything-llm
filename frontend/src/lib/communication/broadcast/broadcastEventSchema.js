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

export function broadcastDottedType(event = {}) {
  if (event.broadcastType) return String(event.broadcastType);
  if (event.type && String(event.type).includes(".")) return String(event.type);
  const namespace = event.namespace || "event";
  const type = event.shortType || event.eventType || event.type || "unknown";
  return `${namespace}.${type}`;
}

export function normalizeBroadcastPriority(event = {}) {
  const explicit = String(event.eventPriority || "").trim();
  if (Object.prototype.hasOwnProperty.call(PRIORITY_RANK, explicit)) {
    return explicit;
  }
  const type = broadcastDottedType(event);
  if (CRITICAL_TYPES.has(type)) return "critical";
  if (BACKGROUND_TYPES.has(type)) return "background";
  return "normal";
}

export function broadcastPriorityRank(priority = "normal") {
  return PRIORITY_RANK[priority] ?? PRIORITY_RANK.normal;
}

export function normalizeBroadcastEvent(event = {}) {
  if (!event || typeof event !== "object") return null;
  const dottedType = broadcastDottedType(event);
  const [namespace, ...rest] = dottedType.split(".");
  const shortType = rest.join(".") || event.type || "unknown";
  return {
    ...event,
    eventId: event.eventId || `${dottedType}:${event.createdAt || Date.now()}`,
    broadcastType: dottedType,
    namespace: event.namespace || namespace,
    type:
      event.type && !String(event.type).includes(".") ? event.type : shortType,
    eventType: event.eventType || shortType,
    eventPriority: normalizeBroadcastPriority(event),
    version:
      Number(event.version ?? event.revision ?? 0) ||
      Date.parse(event.createdAt || "") ||
      Date.now(),
    revision: Number(event.revision ?? event.version ?? 0) || null,
    scope: event.scope && typeof event.scope === "object" ? event.scope : {},
    resource:
      event.resource && typeof event.resource === "object"
        ? event.resource
        : {},
    payload:
      event.payload && typeof event.payload === "object" ? event.payload : {},
    sourceClientId:
      event.sourceClientId ||
      event.origin?.clientId ||
      event.senderClientId ||
      null,
    sourceActionId: event.sourceActionId || event.origin?.actionId || null,
    createdAt: event.createdAt || new Date().toISOString(),
    requiresAck: event.requiresAck !== false,
  };
}

export function broadcastScopeSummary(scope = {}) {
  if (!scope || typeof scope !== "object") return "global";
  return (
    [
      scope.userId !== undefined && scope.userId !== null
        ? `user:${scope.userId}`
        : null,
      scope.workspaceId ? `workspaceId:${scope.workspaceId}` : null,
      scope.workspaceSlug ? `workspace:${scope.workspaceSlug}` : null,
      scope.threadId ? `threadId:${scope.threadId}` : null,
      scope.threadSlug ? `thread:${scope.threadSlug}` : null,
      scope.readerDocumentId ? `reader:${scope.readerDocumentId}` : null,
      scope.clientId ? `client:${scope.clientId}` : null,
    ]
      .filter(Boolean)
      .join("|") || "global"
  );
}

export function broadcastResourceKey(event = {}) {
  const normalized = normalizeBroadcastEvent(event);
  if (!normalized) return "unknown";
  const resource = normalized.resource || {};
  return [
    normalized.broadcastType,
    resource.kind || normalized.namespace || "event",
    resource.id ?? resource.publicId ?? broadcastScopeSummary(normalized.scope),
  ].join(":");
}
