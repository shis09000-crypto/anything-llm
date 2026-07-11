const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
let lastPrunedAt = 0;

function retentionMs() {
  const configured = Number(process.env.ATHENA_SYNC_EVENT_RETENTION_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RETENTION_MS;
}

function json(value = {}) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function visibleWhere(userId = null, clientId = null) {
  const normalizedUserId = numericOrNull(userId);
  return {
    userId: normalizedUserId,
    OR: [
      { visibility: { not: "client" } },
      ...(clientId
        ? [{ visibility: "client", targetClientId: String(clientId) }]
        : []),
    ],
  };
}

function hydrate(row = null) {
  if (!row) return null;
  const namespace = row.namespace;
  const eventType = row.eventType;
  const type = `${namespace}.${eventType}`;
  return {
    eventId: row.eventId,
    type,
    namespace,
    eventType,
    shortType: eventType,
    scope: safeJsonParse(row.scopeJson, {}),
    visibility: row.visibility,
    eventPriority: row.priority,
    version: numericOrNull(row.version) || row.version || null,
    revision: numericOrNull(row.revision) || row.revision || null,
    createdAt: row.createdAt?.toISOString?.() || row.createdAt,
    sourceClientId: row.sourceClientId,
    origin: safeJsonParse(row.originJson, {}),
    resource: safeJsonParse(row.resourceJson, {}),
    payload: safeJsonParse(row.payloadJson, {}),
    requiresAck: row.requiresAck !== false,
  };
}

const SyncEvent = {
  persist: async function (event = {}) {
    const createdAt = new Date(event.createdAt || Date.now());
    const normalizedCreatedAt = Number.isNaN(createdAt.valueOf())
      ? new Date()
      : createdAt;
    const scope = event.scope || {};
    const data = {
      eventId: String(event.eventId),
      userId: numericOrNull(scope.userId),
      targetClientId:
        event.visibility === "client"
          ? String(scope.clientId || event.payload?.clientId || "") || null
          : null,
      namespace: String(event.namespace),
      eventType: String(event.eventType || event.shortType),
      visibility: String(event.visibility || "user"),
      priority: String(event.eventPriority || "normal"),
      version:
        event.version === null || event.version === undefined
          ? null
          : String(event.version),
      revision:
        event.revision === null || event.revision === undefined
          ? null
          : String(event.revision),
      scopeJson: json(scope),
      resourceJson: json(event.resource),
      payloadJson: json(event.payload),
      originJson: json(event.origin),
      sourceClientId: event.sourceClientId
        ? String(event.sourceClientId)
        : null,
      requiresAck: event.requiresAck !== false,
      createdAt: normalizedCreatedAt,
      expiresAt: new Date(Date.now() + retentionMs()),
    };
    try {
      const row = await prisma.athena_sync_events.create({ data });
      await this.pruneIfNeeded();
      return hydrate(row);
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      return hydrate(
        await prisma.athena_sync_events.findUnique({
          where: { eventId: data.eventId },
        })
      );
    }
  },

  replay: async function ({
    userId = null,
    clientId = null,
    afterEventId = null,
    limit = 100,
  } = {}) {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const visibility = visibleWhere(userId, clientId);
    const checkpoint = await prisma.athena_sync_events.findFirst({
      where: { ...visibility, expiresAt: { gt: new Date() } },
      orderBy: { id: "desc" },
    });
    if (!afterEventId) {
      return {
        events: [],
        nextEventId: null,
        checkpointEventId: checkpoint?.eventId || null,
        hasMore: false,
        requiresFullSync: true,
      };
    }

    const cursor = await prisma.athena_sync_events.findFirst({
      where: {
        ...visibility,
        eventId: String(afterEventId),
        expiresAt: { gt: new Date() },
      },
    });
    if (!cursor) {
      return {
        events: [],
        nextEventId: null,
        checkpointEventId: checkpoint?.eventId || null,
        hasMore: false,
        requiresFullSync: true,
      };
    }

    const rows = await prisma.athena_sync_events.findMany({
      where: {
        ...visibility,
        id: { gt: cursor.id },
        expiresAt: { gt: new Date() },
      },
      orderBy: { id: "asc" },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      events: page.map(hydrate),
      nextEventId: page.at(-1)?.eventId || cursor.eventId,
      checkpointEventId: checkpoint?.eventId || cursor.eventId,
      hasMore,
      requiresFullSync: false,
    };
  },

  pruneIfNeeded: async function () {
    const now = Date.now();
    if (now - lastPrunedAt < 60_000) return;
    lastPrunedAt = now;
    await prisma.athena_sync_events.deleteMany({
      where: { expiresAt: { lte: new Date(now) } },
    });
  },

  _hydrate: hydrate,
  _visibleWhere: visibleWhere,
};

module.exports = { SyncEvent };
