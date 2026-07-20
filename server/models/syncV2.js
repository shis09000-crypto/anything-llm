const { v4: uuidv4 } = require("uuid");
const prisma = require("../utils/prisma");
const authPrisma = require("../utils/authPrisma");
const { safeJsonParse } = require("../utils/http");
const { contentHash } = require("../utils/syncV2/canonicalJson");
const { currentCorrelation } = require("../utils/observability/context");
const { metrics } = require("../utils/observability/metrics");
const {
  decodeUserStateValue,
} = require("../utils/security/userStateValueProtection");
const {
  classifyNodeKey,
  nodeKeys,
  parentKeyFor,
} = require("../utils/syncV2/nodeRegistry");
const {
  syncV2Enabled,
  syncV2DomainEnabled,
  syncV2HashSamplePercent,
  syncV2RetentionMs,
} = require("../utils/syncV2/config");
const {
  authSessionsProjection,
  clientDevicesProjection,
  passkeysProjection,
} = require("../utils/syncV2/securityProjection");
const {
  authUserIdForShadowUser,
  memoryCandidatesProjection,
  personaMemoryProjection,
  structuredMemoryProjection,
} = require("../utils/syncV2/memoryProjection");
const {
  agentActivityProjection,
  cognitionActivityProjection,
  meetingActivityProjection,
} = require("../utils/syncV2/workspaceActivityProjection");
const {
  userEntitlementProjection,
  userNotificationProjection,
  userProfileProjection,
  userSecurityPolicyProjection,
} = require("../utils/syncV2/userProjection");
const {
  workspaceDocumentsProjection,
} = require("../utils/syncV2/documentProjection");

const SCHEMA_READY_TTL_MS = 30_000;
let schemaReadyCache = { checkedAt: 0, ready: false };
const runtimeMetrics = {
  manifests: 0,
  batchGets: 0,
  batchGetRequestedNodes: 0,
  batchGetDeduplicatedNodes: 0,
  batchGetDescriptorFastPathNodes: 0,
  batchGetHashSampledNodes: 0,
  batchGetFastPathNodes: 0,
  batchGetReconciles: 0,
  batchGetProjectionBatchQueries: 0,
  batchGetProjectionRows: 0,
  nodesReturned: 0,
  unchangedNodes: 0,
  eventReplays: 0,
  fullReconciles: 0,
  hashRepairs: 0,
  versionConflicts: 0,
  prunedEvents: 0,
};

const WORKSPACE_METADATA_SELECT = {
  id: true,
  name: true,
  slug: true,
  pfpFilename: true,
  chatProvider: true,
  chatModel: true,
  chatMode: true,
  agentProvider: true,
  agentModel: true,
  openAiHistory: true,
  similarityThreshold: true,
  topN: true,
  vectorSearchMode: true,
};
const THREAD_INDEX_SELECT = {
  id: true,
  workspace_id: true,
  slug: true,
  name: true,
  title: true,
  thread_type: true,
  chatModel: true,
  archivedAt: true,
};

function json(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function normalizeChangedPaths(paths = []) {
  return [
    ...new Set(
      (Array.isArray(paths) ? paths : [paths])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .slice(0, 100)
    ),
  ].sort();
}

function pathsOverlap(left = [], right = []) {
  if (left.includes("$") || right.includes("$")) return true;
  return left.some((leftPath) =>
    right.some(
      (rightPath) =>
        leftPath === rightPath ||
        leftPath.startsWith(`${rightPath}.`) ||
        rightPath.startsWith(`${leftPath}.`)
    )
  );
}

function nodeUsesContentHash(parsed = null) {
  return !["event-cursor", "version-only"].includes(parsed?.consistency);
}

function startupMaterializationKeys(nodeKeys = []) {
  return [...new Set(nodeKeys)].filter(
    (nodeKey) => classifyNodeKey(nodeKey)?.materializeOnManifest === true
  );
}

function shouldSampleNodeHash(nodeKey, now = new Date()) {
  const percent = syncV2HashSamplePercent();
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const bucket = `${now.toISOString().slice(0, 10)}:${nodeKey}`;
  const sample = parseInt(contentHash(bucket).slice(-8), 16) % 10_000;
  return sample < Math.round(percent * 100);
}

function createProjectionCache() {
  const values = new Map();
  return {
    set(key, value) {
      values.set(key, Promise.resolve(value));
    },
    async once(key, loader) {
      if (!values.has(key)) values.set(key, Promise.resolve().then(loader));
      return await values.get(key);
    },
  };
}

function requestHydrationState(request, parsed, existing, now) {
  const usesContentHash = nodeUsesContentHash(parsed);
  const versionMatches =
    existing &&
    Number(request.knownVersion || 0) === Number(existing.stateVersion);
  const hashMatches =
    !usesContentHash ||
    (Boolean(existing?.contentHash) &&
      (!request.knownHash || request.knownHash === existing.contentHash));
  const descriptorMatches = Boolean(versionMatches && hashMatches);
  return {
    usesContentHash,
    descriptorMatches,
    sampleHash:
      descriptorMatches &&
      usesContentHash &&
      shouldSampleNodeHash(parsed.nodeKey, now),
  };
}

async function primeProjectionCache(client, cache, preparedRequests, userId) {
  const kinds = (names) =>
    preparedRequests.filter(({ parsed }) => names.includes(parsed.kind));
  const idsFor = (requests) => [
    ...new Set(requests.map(({ parsed }) => Number(parsed.ownerId))),
  ];

  const workspaceMetadataIds = idsFor(kinds(["workspace-metadata"]));
  if (workspaceMetadataIds.length > 1) {
    const rows = await client.workspaces.findMany({
      where: { id: { in: workspaceMetadataIds } },
      select: WORKSPACE_METADATA_SELECT,
    });
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    for (const id of workspaceMetadataIds)
      cache.set(`workspace:${id}`, byId.get(id) || null);
    runtimeMetrics.batchGetProjectionBatchQueries += 1;
    runtimeMetrics.batchGetProjectionRows += rows.length;
  }

  const memberWorkspaceIds = idsFor(
    kinds(["workspace-members", "workspace-permissions"])
  );
  if (memberWorkspaceIds.length > 1) {
    const rows = await client.workspace_users.findMany({
      where: { workspace_id: { in: memberWorkspaceIds } },
      select: {
        workspace_id: true,
        user_id: true,
        users: { select: { role: true, status: true, suspended: true } },
      },
    });
    const byWorkspace = new Map();
    for (const row of rows) {
      const workspaceId = Number(row.workspace_id);
      const members = byWorkspace.get(workspaceId) || [];
      members.push({ user_id: row.user_id, users: row.users });
      byWorkspace.set(workspaceId, members);
    }
    for (const id of memberWorkspaceIds) {
      const members = byWorkspace.get(id) || [];
      members.sort(
        (left, right) => Number(left.user_id) - Number(right.user_id)
      );
      cache.set(`workspace-members:${id}`, members);
    }
    runtimeMetrics.batchGetProjectionBatchQueries += 1;
    runtimeMetrics.batchGetProjectionRows += rows.length;
  }

  const threadIds = idsFor(kinds(["thread-metadata", "thread-messages"]));
  if (threadIds.length > 1) {
    const rows = await client.workspace_threads.findMany({
      where: { id: { in: threadIds } },
    });
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    for (const id of threadIds) cache.set(`thread:${id}`, byId.get(id) || null);
    runtimeMetrics.batchGetProjectionBatchQueries += 1;
    runtimeMetrics.batchGetProjectionRows += rows.length;
  }

  const threadIndexWorkspaceIds = idsFor(kinds(["workspace-threads-index"]));
  if (threadIndexWorkspaceIds.length > 1) {
    const rows = await client.workspace_threads.findMany({
      where: {
        workspace_id: { in: threadIndexWorkspaceIds },
        OR: [{ user_id: Number(userId) }, { user_id: null }],
      },
      select: THREAD_INDEX_SELECT,
    });
    const byWorkspace = new Map();
    for (const row of rows) {
      const workspaceId = Number(row.workspace_id);
      const threads = byWorkspace.get(workspaceId) || [];
      const { workspace_id: _workspaceId, ...projection } = row;
      threads.push(projection);
      byWorkspace.set(workspaceId, threads);
    }
    for (const id of threadIndexWorkspaceIds) {
      const threads = byWorkspace.get(id) || [];
      threads.sort((left, right) => Number(left.id) - Number(right.id));
      cache.set(`workspace-threads-index:${id}`, threads);
    }
    runtimeMetrics.batchGetProjectionBatchQueries += 1;
    runtimeMetrics.batchGetProjectionRows += rows.length;
  }
}

async function cachedProjection(cache, key, loader) {
  return cache ? await cache.once(key, loader) : await loader();
}

function descriptor(
  row = null,
  checkpointSeq = null,
  { compact = false } = {}
) {
  if (!row) return null;
  const parsed = classifyNodeKey(row.nodeKey);
  const includesHash = nodeUsesContentHash(parsed);
  return {
    nodeKey: row.nodeKey,
    ...(compact
      ? {}
      : {
          parentKey: row.parentKey || null,
          ownerType: row.ownerType,
          ownerId: row.ownerId ?? null,
          visibility: row.visibility,
        }),
    schemaVersion: Number(row.schemaVersion || 1),
    stateVersion: Number(row.stateVersion || 0),
    hydration: parsed?.hydration || "eager",
    ...(includesHash
      ? {
          hash: row.contentHash || null,
          ...(compact ? {} : { hashAlgorithm: row.hashAlgorithm || "sha256" }),
        }
      : {}),
    updatedAt: row.updatedAt?.toISOString?.() || row.updatedAt,
    deletedAt: row.deletedAt?.toISOString?.() || row.deletedAt || null,
    ...(checkpointSeq === null ? {} : { eventCursor: Number(checkpointSeq) }),
  };
}

function outboxEvent(row = null) {
  if (!row) return null;
  return {
    seq: Number(row.seq),
    eventId: row.eventId,
    nodeKey: row.nodeKey,
    ownerType: row.ownerType,
    ownerId: row.ownerId ?? null,
    visibility: row.visibility,
    stateVersion: Number(row.stateVersion),
    eventType: row.eventType,
    changedPaths: safeJsonParse(row.changedPathsJson, []),
    payloadHint: safeJsonParse(row.payloadHintJson, {}),
    audience: safeJsonParse(row.audienceJson, []),
    originClientId: row.originClientId || null,
    mutationId: row.mutationId || null,
    requestId: row.requestId || null,
    traceId: row.traceId || null,
    traceparent: row.traceparent || null,
    createdAt: row.createdAt?.toISOString?.() || row.createdAt,
    expiresAt: row.expiresAt?.toISOString?.() || row.expiresAt,
  };
}

async function workspaceIdsForUser(client, userId, allowAllWorkspaces = false) {
  if (allowAllWorkspaces) {
    return (await client.workspaces.findMany({ select: { id: true } })).map(
      (row) => Number(row.id)
    );
  }
  return (
    await client.workspace_users.findMany({
      where: { user_id: Number(userId) },
      select: { workspace_id: true },
    })
  ).map((row) => Number(row.workspace_id));
}

async function visibilityContextForUser(
  client,
  userId,
  allowAllWorkspaces = false,
  { includeUserRole = true } = {}
) {
  const normalizedUserId = Number(userId);
  const user = includeUserRole
    ? await client.users.findUnique({
        where: { id: normalizedUserId },
        select: { role: true },
      })
    : null;
  const workspaceIds = await workspaceIdsForUser(
    client,
    normalizedUserId,
    allowAllWorkspaces
  );
  const threads = workspaceIds.length
    ? await client.workspace_threads.findMany({
        where: {
          workspace_id: { in: workspaceIds },
          OR: [{ user_id: normalizedUserId }, { user_id: null }],
        },
        select: { id: true, workspace_id: true },
      })
    : [];
  const threadIdsByWorkspace = new Map();
  for (const thread of threads) {
    const workspaceId = Number(thread.workspace_id);
    const ids = threadIdsByWorkspace.get(workspaceId) || [];
    ids.push(Number(thread.id));
    threadIdsByWorkspace.set(workspaceId, ids);
  }
  return {
    userId: normalizedUserId,
    userRole: String(user?.role || "").toLowerCase(),
    allowAllWorkspaces: Boolean(allowAllWorkspaces),
    workspaceIds,
    workspaceIdSet: new Set(workspaceIds),
    threadIds: threads.map((thread) => Number(thread.id)),
    threadIdSet: new Set(threads.map((thread) => Number(thread.id))),
    threadIdsByWorkspace,
  };
}

async function canAccessNode(
  client,
  nodeKey,
  { userId, allowAllWorkspaces = false, visibilityContext = null } = {}
) {
  const parsed = classifyNodeKey(nodeKey);
  if (!parsed || !Number.isInteger(Number(userId))) return false;
  if (parsed.ownerType === "user") return parsed.ownerId === Number(userId);

  // The existing workspace member and permission APIs are administrator-only.
  // A workspace membership alone must not turn Sync V2 into a lower-privilege
  // read path for account roles, status, or suspension state.
  if (["workspace-members", "workspace-permissions"].includes(parsed.kind)) {
    if (!allowAllWorkspaces) {
      const role =
        visibilityContext?.userRole ||
        String(
          (
            await client.users.findUnique({
              where: { id: Number(userId) },
              select: { role: true },
            })
          )?.role || ""
        ).toLowerCase();
      if (!["admin", "owner"].includes(role)) return false;
    }
  }

  if (visibilityContext) {
    if (parsed.ownerType === "workspace")
      return visibilityContext.workspaceIdSet.has(Number(parsed.ownerId));
    if (parsed.ownerType === "thread")
      return visibilityContext.threadIdSet.has(Number(parsed.ownerId));
    return false;
  }

  let workspaceId = null;
  if (parsed.ownerType === "workspace") workspaceId = parsed.ownerId;
  if (parsed.ownerType === "thread") {
    const thread = await client.workspace_threads.findUnique({
      where: { id: parsed.ownerId },
      select: { workspace_id: true, user_id: true },
    });
    if (!thread) return false;
    if (thread.user_id !== null && Number(thread.user_id) !== Number(userId))
      return false;
    workspaceId = Number(thread.workspace_id);
  }
  if (!workspaceId) return false;
  if (allowAllWorkspaces) return true;
  return Boolean(
    await client.workspace_users.findFirst({
      where: { workspace_id: workspaceId, user_id: Number(userId) },
      select: { id: true },
    })
  );
}

async function loadNodePayload(
  client,
  parsed,
  {
    userId,
    allowAllWorkspaces = false,
    visibilityContext = null,
    accessChecked = false,
    projectionCache = null,
  } = {}
) {
  if (
    !accessChecked &&
    !(await canAccessNode(client, parsed.nodeKey, {
      userId,
      allowAllWorkspaces,
      visibilityContext,
    }))
  )
    return null;
  switch (parsed.kind) {
    case "user-profile":
      return userProfileProjection(
        await cachedProjection(
          projectionCache,
          `user:${parsed.ownerId}`,
          async () =>
            await client.users.findUnique({ where: { id: parsed.ownerId } })
        )
      );
    case "user-security-policies":
      return userSecurityPolicyProjection(
        await cachedProjection(
          projectionCache,
          `user:${parsed.ownerId}`,
          async () =>
            await client.users.findUnique({ where: { id: parsed.ownerId } })
        )
      );
    case "user-entitlements":
      return userEntitlementProjection(
        await cachedProjection(
          projectionCache,
          `user:${parsed.ownerId}`,
          async () =>
            await client.users.findUnique({ where: { id: parsed.ownerId } })
        )
      );
    case "user-notifications":
      return userNotificationProjection(
        await cachedProjection(
          projectionCache,
          `user:${parsed.ownerId}`,
          async () =>
            await client.users.findUnique({ where: { id: parsed.ownerId } })
        )
      );
    case "user-preferences": {
      const row = await client.user_state_preferences.findUnique({
        where: {
          userId_namespace_scope: {
            userId: parsed.ownerId,
            namespace: parsed.namespace,
            scope: parsed.scope,
          },
        },
      });
      if (!row) return null;
      return {
        namespace: row.namespace,
        scope: row.scope,
        schemaVersion: row.version,
        value: decodeUserStateValue({
          userId: row.userId,
          namespace: row.namespace,
          scope: row.scope,
          storedValue: row.value,
        }),
      };
    }
    case "user-workspaces-index": {
      const ids =
        visibilityContext?.userId === Number(parsed.ownerId)
          ? visibilityContext.workspaceIds
          : await workspaceIdsForUser(
              client,
              parsed.ownerId,
              allowAllWorkspaces
            );
      return await client.workspaces.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          slug: true,
          pfpFilename: true,
          chatModel: true,
        },
        orderBy: { id: "asc" },
      });
    }
    case "user-security-clients":
      return await clientDevicesProjection(client, parsed.ownerId);
    case "user-security-passkeys": {
      const authUserId = await authUserIdForShadowUser(client, parsed.ownerId);
      if (!authUserId) return null;
      return await passkeysProjection(authPrisma, authUserId);
    }
    case "user-security-sessions": {
      const authUserId = await authUserIdForShadowUser(client, parsed.ownerId);
      if (!authUserId) return null;
      return await authSessionsProjection(authPrisma, authUserId);
    }
    case "user-memory-candidates":
    case "user-memory-structured":
    case "user-memory-persona": {
      const authUserId = await authUserIdForShadowUser(client, parsed.ownerId);
      if (!authUserId) return null;
      if (parsed.kind === "user-memory-candidates")
        return await memoryCandidatesProjection(client, authUserId);
      if (parsed.kind === "user-memory-structured")
        return await structuredMemoryProjection(client, authUserId);
      return await personaMemoryProjection(client, authUserId);
    }
    case "workspace-metadata":
      return await cachedProjection(
        projectionCache,
        `workspace:${parsed.ownerId}`,
        async () =>
          await client.workspaces.findUnique({
            where: { id: parsed.ownerId },
            select: WORKSPACE_METADATA_SELECT,
          })
      );
    case "workspace-documents":
      return await workspaceDocumentsProjection(client, parsed.ownerId);
    case "workspace-document-status":
      // This node is an event cursor, not a replicated status table. The
      // domain endpoint remains authoritative; a tiny projection merely lets
      // replay/SSE clients durably apply an invalidation without full scans.
      return { workspaceId: parsed.ownerId };
    case "workspace-members":
    case "workspace-permissions":
      return await cachedProjection(
        projectionCache,
        `workspace-members:${parsed.ownerId}`,
        async () =>
          await client.workspace_users.findMany({
            where: { workspace_id: parsed.ownerId },
            select: {
              user_id: true,
              users: { select: { role: true, status: true, suspended: true } },
            },
            orderBy: { user_id: "asc" },
          })
      );
    case "workspace-cognition":
      return await cognitionActivityProjection(client, parsed.ownerId);
    case "workspace-agents":
      return await agentActivityProjection(client, parsed.ownerId);
    case "workspace-meetings":
      return await meetingActivityProjection(client, parsed.ownerId);
    case "workspace-threads-index":
      return await cachedProjection(
        projectionCache,
        `workspace-threads-index:${parsed.ownerId}`,
        async () =>
          await client.workspace_threads
            .findMany({
              where: {
                workspace_id: parsed.ownerId,
                OR: [{ user_id: Number(userId) }, { user_id: null }],
              },
              select: THREAD_INDEX_SELECT,
              orderBy: { id: "asc" },
            })
            .then((rows) =>
              rows.map(({ workspace_id: _workspaceId, ...row }) => row)
            )
      );
    case "thread-metadata": {
      const thread = await cachedProjection(
        projectionCache,
        `thread:${parsed.ownerId}`,
        async () =>
          await client.workspace_threads.findUnique({
            where: { id: parsed.ownerId },
          })
      );
      if (!thread) return null;
      return {
        id: thread.id,
        workspace_id: thread.workspace_id,
        user_id: thread.user_id,
        slug: thread.slug,
        name: thread.name,
        title: thread.title,
        titleVersion: thread.titleVersion,
        thread_type: thread.thread_type,
        chatModel: thread.chatModel,
        archivedAt: thread.archivedAt,
      };
    }
    case "thread-messages": {
      const thread = await cachedProjection(
        projectionCache,
        `thread:${parsed.ownerId}`,
        async () =>
          await client.workspace_threads.findUnique({
            where: { id: parsed.ownerId },
          })
      );
      if (!thread) return null;
      const latest = await client.workspace_chats.findFirst({
        where: {
          workspaceId: thread.workspace_id,
          thread_id: thread.id,
          user_id: Number(userId),
          api_session_id: null,
          include: true,
        },
        select: { id: true, public_id: true, lastUpdatedAt: true },
        orderBy: { id: "desc" },
      });
      return {
        threadId: thread.id,
        historyRevision: thread.historyRevision,
        latestChatId: latest?.id || null,
        latestPublicChatId: latest?.public_id || null,
        latestChatAt: latest?.lastUpdatedAt || null,
      };
    }
    default:
      return null;
  }
}

const SyncV2 = {
  async schemaReady({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - schemaReadyCache.checkedAt < SCHEMA_READY_TTL_MS)
      return schemaReadyCache.ready;
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sync_nodes', 'sync_outbox', 'sync_client_cursors')`
      );
      schemaReadyCache = { checkedAt: now, ready: rows.length === 3 };
    } catch {
      schemaReadyCache = { checkedAt: now, ready: false };
    }
    return schemaReadyCache.ready;
  },

  enabled(domain = "core") {
    return syncV2DomainEnabled(domain);
  },

  async canAccessNode(options = {}) {
    return await canAccessNode(prisma, options.nodeKey, options);
  },

  async recordNodeChange(tx, options = {}) {
    const parsed = classifyNodeKey(options.nodeKey);
    if (!parsed) throw new Error("sync_node_unregistered");
    const changedPaths = normalizeChangedPaths(options.changedPaths);
    const correlation = currentCorrelation();
    const now = options.updatedAt || new Date();
    const usesContentHash = nodeUsesContentHash(parsed);
    const hash = !usesContentHash
      ? null
      : options.contentHash ||
        (options.content === undefined ? null : contentHash(options.content));
    const node = await tx.sync_nodes.upsert({
      where: { nodeKey: parsed.nodeKey },
      create: {
        nodeKey: parsed.nodeKey,
        parentKey: options.parentKey || parentKeyFor(parsed.nodeKey),
        ownerType: options.ownerType || parsed.ownerType,
        ownerId: options.ownerId ?? parsed.ownerId,
        visibility: options.visibility || parsed.visibility,
        schemaVersion: Number(options.schemaVersion || 1),
        stateVersion: 1,
        contentHash: hash,
        updatedAt: now,
        deletedAt: options.deletedAt || null,
      },
      update: {
        parentKey: options.parentKey || parentKeyFor(parsed.nodeKey),
        ownerType: options.ownerType || parsed.ownerType,
        ownerId: options.ownerId ?? parsed.ownerId,
        visibility: options.visibility || parsed.visibility,
        schemaVersion: Number(options.schemaVersion || 1),
        stateVersion: { increment: 1 },
        ...(!usesContentHash
          ? { contentHash: null }
          : hash
            ? { contentHash: hash }
            : {}),
        updatedAt: now,
        deletedAt: options.deletedAt || null,
      },
    });
    const event = await tx.sync_outbox.create({
      data: {
        eventId: options.eventId || uuidv4(),
        nodeKey: parsed.nodeKey,
        ownerType: options.ownerType || parsed.ownerType,
        ownerId: options.ownerId ?? parsed.ownerId,
        visibility: options.visibility || parsed.visibility,
        stateVersion: node.stateVersion,
        eventType: options.eventType || "node.changed",
        changedPathsJson: json(changedPaths, []),
        payloadHintJson: json(options.payloadHint, {}),
        audienceJson: json(options.audience, []),
        originClientId: options.originClientId || null,
        mutationId: options.mutationId || null,
        requestId: options.requestId || correlation?.requestId || null,
        traceId: options.traceId || correlation?.traceId || null,
        traceparent:
          options.traceparent ||
          (correlation?.traceId && correlation?.spanId
            ? `00-${correlation.traceId}-${correlation.spanId}-01`
            : null),
        createdAt: now,
        expiresAt: new Date(now.getTime() + syncV2RetentionMs()),
      },
    });
    metrics.syncOutboxEvents.inc({ action: "created" });
    return { node: descriptor(node, event.seq), event: outboxEvent(event) };
  },

  async recordAuthSessionChange({
    authUserId,
    eventType = "session.changed",
    changedPaths = ["sessions"],
    payloadHint = {},
    originClientId = null,
    sourceRevision = null,
  } = {}) {
    if (!Number(authUserId) || !this.enabled("security")) return null;
    if (!(await this.schemaReady())) return null;
    const shadowUser = await prisma.users.findUnique({
      where: { authUserId: Number(authUserId) },
      select: { id: true },
    });
    if (!shadowUser) return null;
    return await prisma.$transaction(async (tx) => {
      if (sourceRevision) {
        const latest = await tx.sync_outbox.findFirst({
          where: { nodeKey: nodeKeys.userSecuritySessions(shadowUser.id) },
          select: { payloadHintJson: true },
          orderBy: { seq: "desc" },
        });
        const latestHint = safeJsonParse(latest?.payloadHintJson, {});
        if (latestHint.sourceRevision === sourceRevision) {
          const existing = await tx.sync_nodes.findUnique({
            where: { nodeKey: nodeKeys.userSecuritySessions(shadowUser.id) },
          });
          return existing ? { node: descriptor(existing), event: null } : null;
        }
      }
      return await this.recordNodeChange(tx, {
        nodeKey: nodeKeys.userSecuritySessions(shadowUser.id),
        eventType,
        changedPaths,
        payloadHint: { ...payloadHint, sourceRevision },
        originClientId,
        audience: [Number(shadowUser.id)],
      });
    });
  },

  async assertMutationVersion(
    tx,
    { nodeKey, baseVersion = null, changedPaths = [] } = {}
  ) {
    if (baseVersion === null || baseVersion === undefined) return null;
    const node = await tx.sync_nodes.findUnique({ where: { nodeKey } });
    const expected = Number(baseVersion);
    const current = Number(node?.stateVersion || 0);
    if (expected === current) return node;
    const laterEvents = await tx.sync_outbox.findMany({
      where: { nodeKey, stateVersion: { gt: expected } },
      select: { stateVersion: true, changedPathsJson: true },
      orderBy: { stateVersion: "asc" },
    });
    const retainedVersions = new Set(
      laterEvents.map((event) => Number(event.stateVersion))
    );
    const hasCompleteHistory =
      expected < current &&
      Array.from(
        { length: current - expected },
        (_, index) => expected + index + 1
      ).every((version) => retainedVersions.has(version));
    if (!hasCompleteHistory) {
      const error = new Error("state_version_conflict");
      runtimeMetrics.versionConflicts += 1;
      error.code = "state_version_conflict";
      error.syncNode = descriptor(node);
      error.expectedVersion = expected;
      error.requiresFullSync = true;
      error.conflictReason = "version_history_unavailable";
      throw error;
    }
    const remotePaths = laterEvents.flatMap((event) =>
      safeJsonParse(event.changedPathsJson, [])
    );
    if (!pathsOverlap(normalizeChangedPaths(changedPaths), remotePaths))
      return node;
    const error = new Error("state_version_conflict");
    runtimeMetrics.versionConflicts += 1;
    error.code = "state_version_conflict";
    error.syncNode = descriptor(node);
    error.expectedVersion = expected;
    error.requiresFullSync = false;
    error.conflictReason = "changed_paths_overlap";
    throw error;
  },

  async reconcileNode({ nodeKey, content, emitOnCreate = false, ...options }) {
    return await prisma.$transaction(async (tx) => {
      const parsed = classifyNodeKey(nodeKey);
      if (!parsed) throw new Error("sync_node_unregistered");
      const usesContentHash = nodeUsesContentHash(parsed);
      const hash = usesContentHash ? contentHash(content) : null;
      const existing = await tx.sync_nodes.findUnique({ where: { nodeKey } });
      if (!existing) {
        if (emitOnCreate) {
          return await this.recordNodeChange(tx, {
            nodeKey,
            content,
            eventType: "node.snapshot.created",
            changedPaths: ["$"],
            ...options,
          });
        }
        const node = await tx.sync_nodes.create({
          data: {
            nodeKey,
            parentKey: options.parentKey || parentKeyFor(nodeKey),
            ownerType: options.ownerType || parsed.ownerType,
            ownerId: options.ownerId ?? parsed.ownerId,
            visibility: options.visibility || parsed.visibility,
            schemaVersion: Number(options.schemaVersion || 1),
            stateVersion: 1,
            contentHash: hash,
            updatedAt: new Date(),
          },
        });
        return { node: descriptor(node), event: null };
      }
      if (!usesContentHash) {
        const node = existing.contentHash
          ? await tx.sync_nodes.update({
              where: { nodeKey },
              data: { contentHash: null },
            })
          : existing;
        return { node: descriptor(node), event: null };
      }
      if (existing.contentHash === hash)
        return { node: descriptor(existing), event: null };
      return await this.recordNodeChange(tx, {
        nodeKey,
        content,
        eventType: "node.reconciled",
        changedPaths: ["$"],
        ...options,
      });
    });
  },

  async materializeCoreForUser({
    userId,
    allowAllWorkspaces = false,
    visibilityContext = null,
  } = {}) {
    if (!(await this.schemaReady())) return [];
    const normalizedUserId = Number(userId);
    const keys = [
      nodeKeys.userProfile(normalizedUserId),
      nodeKeys.userWorkspacesIndex(normalizedUserId),
      nodeKeys.userSecurityClients(normalizedUserId),
    ];
    if (this.enabled("security")) {
      keys.push(
        nodeKeys.userSecuritySessions(normalizedUserId),
        nodeKeys.userSecurityPasskeys(normalizedUserId),
        nodeKeys.userSecurityPolicies(normalizedUserId)
      );
    }
    if (this.enabled("entitlements"))
      keys.push(nodeKeys.userEntitlements(normalizedUserId));
    if (this.enabled("notifications"))
      keys.push(nodeKeys.userNotifications(normalizedUserId));
    if (this.enabled("memory")) {
      keys.push(
        nodeKeys.userMemory(normalizedUserId, "candidates"),
        nodeKeys.userMemory(normalizedUserId, "structured"),
        nodeKeys.userMemory(normalizedUserId, "persona")
      );
    }
    const preferences = await prisma.user_state_preferences.findMany({
      where: { userId: normalizedUserId },
      select: { namespace: true, scope: true },
    });
    keys.push(
      ...preferences.map((state) =>
        nodeKeys.userPreferences(normalizedUserId, state.namespace, state.scope)
      )
    );
    const visibility =
      visibilityContext ||
      (await visibilityContextForUser(
        prisma,
        normalizedUserId,
        allowAllWorkspaces
      ));
    const workspaceIds = visibility.workspaceIds;
    const canReadMembership =
      allowAllWorkspaces || ["admin", "owner"].includes(visibility.userRole);
    for (const workspaceId of workspaceIds) {
      keys.push(
        nodeKeys.workspaceMetadata(workspaceId),
        nodeKeys.workspaceThreadsIndex(workspaceId)
      );
      if (canReadMembership) {
        keys.push(
          nodeKeys.workspaceMembers(workspaceId),
          nodeKeys.workspacePermissions(workspaceId)
        );
      }
      if (this.enabled("cognition"))
        keys.push(nodeKeys.workspaceDomain(workspaceId, "cognition"));
      if (this.enabled("agents"))
        keys.push(nodeKeys.workspaceDomain(workspaceId, "agents"));
      if (this.enabled("meetings"))
        keys.push(nodeKeys.workspaceDomain(workspaceId, "meetings"));
      if (this.enabled("documents"))
        keys.push(nodeKeys.workspaceDomain(workspaceId, "documents"));
      for (const threadId of visibility.threadIdsByWorkspace.get(workspaceId) ||
        []) {
        keys.push(
          nodeKeys.threadMetadata(threadId),
          nodeKeys.threadMessages(threadId)
        );
      }
    }
    // Manifest requests are latency-sensitive. Lazy nodes are registered and
    // remain visible once domain writes materialize them, but their first
    // projection must be produced by the owning domain, a shadow materializer,
    // or an explicit route-level batchGet rather than by startup.
    const startupKeys = startupMaterializationKeys(keys);
    const existingKeys = new Set(
      (
        await prisma.sync_nodes.findMany({
          where: { nodeKey: { in: startupKeys } },
          select: { nodeKey: true },
        })
      ).map((node) => node.nodeKey)
    );
    const missingRequests = startupKeys
      .filter((nodeKey) => !existingKeys.has(nodeKey))
      .map((nodeKey) => ({
        request: { nodeKey },
        parsed: classifyNodeKey(nodeKey),
      }));
    const projectionCache = createProjectionCache();
    await primeProjectionCache(
      prisma,
      projectionCache,
      missingRequests,
      normalizedUserId
    );
    const missingPayloads = [];
    for (const { parsed } of missingRequests) {
      // Domain writes maintain existing nodes transactionally. Startup only
      // materializes missing nodes; sampled batchGet performs drift repair.
      const payload = await loadNodePayload(prisma, parsed, {
        userId: normalizedUserId,
        allowAllWorkspaces,
        visibilityContext: visibility,
        accessChecked: true,
        projectionCache,
      });
      if (payload === null) continue;
      missingPayloads.push({ parsed, payload });
    }
    if (!missingPayloads.length) return [];
    // First-login/cold materialization used to open one transaction per node.
    // A single transaction keeps the work O(missing nodes) while avoiding
    // repeated SQLite fsync/lock acquisition. Concurrent manifests converge
    // through upsert without emitting synthetic domain events.
    return await prisma.$transaction(async (tx) => {
      const results = [];
      for (const { parsed, payload } of missingPayloads) {
        const node = await tx.sync_nodes.upsert({
          where: { nodeKey: parsed.nodeKey },
          create: {
            nodeKey: parsed.nodeKey,
            parentKey: parentKeyFor(parsed.nodeKey),
            ownerType: parsed.ownerType,
            ownerId: parsed.ownerId,
            visibility: parsed.visibility,
            schemaVersion: 1,
            stateVersion: 1,
            contentHash: nodeUsesContentHash(parsed)
              ? contentHash(payload)
              : null,
            updatedAt: new Date(),
          },
          update: {},
        });
        results.push({ node: descriptor(node), event: null });
      }
      return results;
    });
  },

  async manifestForUser({
    userId,
    allowAllWorkspaces = false,
    materialize = true,
    knownManifestHash = null,
  } = {}) {
    runtimeMetrics.manifests += 1;
    const visibility = await visibilityContextForUser(
      prisma,
      userId,
      allowAllWorkspaces
    );
    if (materialize)
      await this.materializeCoreForUser({
        userId,
        allowAllWorkspaces,
        visibilityContext: visibility,
      });
    const workspaceIds = visibility.workspaceIds;
    const visibleThreadIds = visibility.threadIds;
    const nodes = await prisma.sync_nodes.findMany({
      where: {
        OR: [
          { ownerType: "user", ownerId: Number(userId) },
          { ownerType: "workspace", ownerId: { in: workspaceIds } },
          {
            ownerType: "thread",
            ownerId: { in: visibleThreadIds },
          },
        ],
      },
      orderBy: { nodeKey: "asc" },
    });
    const authorizedNodes = [];
    for (const node of nodes) {
      if (
        await canAccessNode(prisma, node.nodeKey, {
          userId,
          allowAllWorkspaces,
          visibilityContext: visibility,
        })
      ) {
        authorizedNodes.push(node);
      }
    }
    const checkpoint = await prisma.sync_outbox.findFirst({
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const descriptors = authorizedNodes.map((node) =>
      descriptor(node, null, { compact: true })
    );
    const manifestHash = contentHash(descriptors);
    const unchanged =
      typeof knownManifestHash === "string" &&
      knownManifestHash.length > 0 &&
      knownManifestHash === manifestHash;
    return {
      checkpointSeq: Number(checkpoint?.seq || 0),
      manifestHash,
      unchanged,
      nodes: unchanged ? [] : descriptors,
    };
  },

  async batchGet({ userId, allowAllWorkspaces = false, nodes = [] } = {}) {
    runtimeMetrics.batchGets += 1;
    const results = [];
    const inputNodes = (Array.isArray(nodes) ? nodes : []).slice(0, 100);
    runtimeMetrics.batchGetRequestedNodes += inputNodes.length;
    const includeUserRole = inputNodes.some((request) =>
      ["workspace-members", "workspace-permissions"].includes(
        classifyNodeKey(request?.nodeKey)?.kind
      )
    );
    const visibility = await visibilityContextForUser(
      prisma,
      userId,
      allowAllWorkspaces,
      { includeUserRole }
    );
    const requestByNodeKey = new Map();
    let accessibleRequests = 0;
    for (const request of inputNodes) {
      const parsed = classifyNodeKey(request?.nodeKey);
      if (!parsed) continue;
      if (
        !(await canAccessNode(prisma, parsed.nodeKey, {
          userId,
          allowAllWorkspaces,
          visibilityContext: visibility,
        }))
      )
        continue;
      accessibleRequests += 1;
      const current = requestByNodeKey.get(parsed.nodeKey);
      if (
        !current ||
        Number(request.knownVersion || 0) >=
          Number(current.request.knownVersion || 0)
      ) {
        requestByNodeKey.set(parsed.nodeKey, { request, parsed });
      }
    }
    const requests = [...requestByNodeKey.values()];
    runtimeMetrics.batchGetDeduplicatedNodes += Math.max(
      accessibleRequests - requests.length,
      0
    );
    const existingNodes = requests.length
      ? await prisma.sync_nodes.findMany({
          where: {
            nodeKey: { in: requests.map(({ parsed }) => parsed.nodeKey) },
          },
        })
      : [];
    const existingByKey = new Map(
      existingNodes.map((node) => [node.nodeKey, node])
    );
    const projectionCache = createProjectionCache();
    const hydrationNow = new Date();
    const preparedRequests = requests.map(({ request, parsed }) => {
      const existing = existingByKey.get(parsed.nodeKey) || null;
      return {
        request,
        parsed,
        existing,
        hydration: requestHydrationState(
          request,
          parsed,
          existing,
          hydrationNow
        ),
      };
    });
    await primeProjectionCache(
      prisma,
      projectionCache,
      preparedRequests.filter(
        ({ hydration }) => !hydration.descriptorMatches || hydration.sampleHash
      ),
      userId
    );

    for (const { request, parsed, existing, hydration } of preparedRequests) {
      const { usesContentHash, descriptorMatches, sampleHash } = hydration;
      if (descriptorMatches && !sampleHash) {
        results.push({
          descriptor: descriptor(existing),
          unchanged: true,
          repaired: false,
        });
        runtimeMetrics.batchGetDescriptorFastPathNodes += 1;
        runtimeMetrics.nodesReturned += 1;
        runtimeMetrics.unchangedNodes += 1;
        continue;
      }
      if (sampleHash) runtimeMetrics.batchGetHashSampledNodes += 1;
      const payload = await loadNodePayload(prisma, parsed, {
        userId,
        allowAllWorkspaces,
        visibilityContext: visibility,
        accessChecked: true,
        projectionCache,
      });
      if (payload === null) continue;
      const expectedHash = usesContentHash ? contentHash(payload) : null;
      const needsReconcile =
        !existing ||
        (usesContentHash
          ? existing.contentHash !== expectedHash
          : Boolean(existing.contentHash));
      const reconciled = needsReconcile
        ? await this.reconcileNode({
            nodeKey: parsed.nodeKey,
            content: payload,
          })
        : { node: descriptor(existing), event: null };
      if (needsReconcile) runtimeMetrics.batchGetReconciles += 1;
      else runtimeMetrics.batchGetFastPathNodes += 1;
      const nodeDescriptor = reconciled.node;
      const unchanged =
        Number(request.knownVersion || 0) ===
          Number(nodeDescriptor.stateVersion) &&
        (!usesContentHash ||
          !request.knownHash ||
          request.knownHash === nodeDescriptor.hash);
      results.push({
        descriptor: nodeDescriptor,
        unchanged,
        ...(unchanged ? {} : { payload }),
        repaired: Boolean(reconciled.event),
      });
      runtimeMetrics.nodesReturned += 1;
      if (unchanged) runtimeMetrics.unchangedNodes += 1;
      if (reconciled.event) runtimeMetrics.hashRepairs += 1;
    }
    return results;
  },

  async eventsAfter({
    userId,
    allowAllWorkspaces = false,
    after = null,
    limit = 100,
  } = {}) {
    runtimeMetrics.eventReplays += 1;
    const take = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const checkpoint = await prisma.sync_outbox.findFirst({
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const minimum = await prisma.sync_outbox.findFirst({
      where: { expiresAt: { gt: new Date() } },
      orderBy: { seq: "asc" },
      select: { seq: true },
    });
    if (after === null || after === undefined || after === "") {
      runtimeMetrics.fullReconciles += 1;
      return {
        events: [],
        checkpointSeq: Number(checkpoint?.seq || 0),
        nextSeq: null,
        hasMore: false,
        requiresFullSync: true,
      };
    }
    const cursor = Number(after);
    if (
      !Number.isInteger(cursor) ||
      cursor < 0 ||
      cursor > Number(checkpoint?.seq || 0) ||
      (minimum && cursor < minimum.seq - 1)
    ) {
      runtimeMetrics.fullReconciles += 1;
      return {
        events: [],
        checkpointSeq: Number(checkpoint?.seq || 0),
        nextSeq: null,
        hasMore: false,
        requiresFullSync: true,
      };
    }
    const visibility = await visibilityContextForUser(
      prisma,
      userId,
      allowAllWorkspaces
    );
    const workspaceIds = visibility.workspaceIds;
    const threadIds = visibility.threadIds;
    const visible = [];
    let scannedSeq = cursor;
    let exhausted = false;
    while (!exhausted && visible.length <= take) {
      const rows = await prisma.sync_outbox.findMany({
        where: {
          seq: { gt: scannedSeq },
          expiresAt: { gt: new Date() },
          OR: [
            { ownerType: "user", ownerId: Number(userId) },
            { ownerType: "workspace", ownerId: { in: workspaceIds } },
            { ownerType: "thread", ownerId: { in: threadIds } },
          ],
        },
        orderBy: { seq: "asc" },
        take: 500,
      });
      if (!rows.length) break;
      for (const row of rows) {
        scannedSeq = Number(row.seq);
        const audience = safeJsonParse(row.audienceJson, []);
        const audienceAllows =
          !audience.length || audience.map(Number).includes(Number(userId));
        if (!audienceAllows) continue;
        if (
          ["workspace", "thread"].includes(row.ownerType) &&
          !(await canAccessNode(prisma, row.nodeKey, {
            userId,
            allowAllWorkspaces,
            visibilityContext: visibility,
          }))
        )
          continue;
        visible.push(row);
        if (visible.length > take) break;
      }
      exhausted = rows.length < 500;
    }
    const hasMore = visible.length > take;
    const page = hasMore ? visible.slice(0, take) : visible;
    return {
      events: page.map(outboxEvent),
      checkpointSeq: Number(checkpoint?.seq || 0),
      nextSeq: Number(
        hasMore
          ? page.at(-1)?.seq || cursor
          : Math.max(scannedSeq, Number(checkpoint?.seq || 0))
      ),
      hasMore,
      requiresFullSync: false,
    };
  },

  async updateCursor({
    userId,
    clientId,
    platform = null,
    lastAppliedSeq = 0,
  }) {
    const checkpoint = await prisma.sync_outbox.findFirst({
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const current = await prisma.sync_client_cursors.findUnique({
      where: {
        userId_clientId: { userId: Number(userId), clientId: String(clientId) },
      },
    });
    const next = Math.min(
      Math.max(
        Number(current?.lastAppliedSeq || 0),
        Number(lastAppliedSeq || 0)
      ),
      Number(checkpoint?.seq || 0)
    );
    const cursor = await prisma.sync_client_cursors.upsert({
      where: {
        userId_clientId: { userId: Number(userId), clientId: String(clientId) },
      },
      create: {
        userId: Number(userId),
        clientId: String(clientId),
        platform: platform ? String(platform) : null,
        lastAppliedSeq: next,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
      update: {
        platform: platform ? String(platform) : undefined,
        lastAppliedSeq: next,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const normalizedPlatform = String(platform || "unknown").toLowerCase();
    const metricPlatform = [
      "web",
      "ios",
      "ipados",
      "android",
      "macos",
      "windows",
      "desktop",
      "unknown",
    ].includes(normalizedPlatform)
      ? normalizedPlatform
      : "other";
    metrics.syncCursorLag.observe(
      { platform: metricPlatform },
      Math.max(Number(checkpoint?.seq || 0) - next, 0)
    );
    return cursor;
  },

  async mutationReplay({ nodeKey, mutationId }) {
    if (!mutationId) return null;
    const event = await prisma.sync_outbox.findFirst({
      where: { nodeKey, mutationId: String(mutationId) },
      orderBy: { seq: "desc" },
    });
    if (!event) return null;
    const laterEvents = await prisma.sync_outbox.findMany({
      where: { nodeKey, stateVersion: { gt: Number(event.stateVersion) } },
      orderBy: { stateVersion: "desc" },
    });
    const compensation = laterEvents.find((candidate) => {
      const hint = safeJsonParse(candidate.payloadHintJson, {});
      return (
        hint.compensatedMutation === true &&
        hint.compensatedMutationId === String(mutationId)
      );
    });
    const node = await prisma.sync_nodes.findUnique({ where: { nodeKey } });
    const hydratedEvent = outboxEvent(compensation || event);
    return {
      replayed: true,
      compensated: Boolean(compensation),
      event: hydratedEvent,
      descriptor: descriptor(node, compensation?.seq || event.seq),
    };
  },

  async pendingOutbox(limit = 100) {
    if (!(await this.schemaReady())) return [];
    return await prisma.sync_outbox.findMany({
      where: { dispatchedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { seq: "asc" },
      take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    });
  },

  async claimOutbox({
    limit = 100,
    leaseOwner,
    leaseMs = 30_000,
    now = new Date(),
  } = {}) {
    if (!(await this.schemaReady())) return [];
    const owner = String(leaseOwner || "")
      .trim()
      .slice(0, 160);
    if (!owner) throw new Error("sync_v2_outbox_lease_owner_required");
    const take = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const leaseUntil = new Date(
      now.getTime() + Math.max(Number(leaseMs) || 30_000, 5_000)
    );
    return await prisma.$transaction(async (tx) => {
      await tx.sync_outbox.updateMany({
        where: {
          dispatchedAt: null,
          deadLetteredAt: null,
          status: "claimed",
          leaseExpiresAt: { lte: now },
        },
        data: {
          status: "retry",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: now,
        },
      });
      const laneHeads = await tx.sync_outbox.groupBy({
        by: ["nodeKey"],
        where: {
          dispatchedAt: null,
          deadLetteredAt: null,
          expiresAt: { gt: now },
        },
        _min: { seq: true },
        orderBy: { _min: { seq: "asc" } },
        take,
      });
      const headSeqs = laneHeads
        .map((row) => Number(row._min.seq))
        .filter(Number.isInteger);
      if (!headSeqs.length) return [];
      const headRows = await tx.sync_outbox.findMany({
        where: {
          seq: { in: headSeqs },
          dispatchedAt: null,
          deadLetteredAt: null,
          expiresAt: { gt: now },
          status: { in: ["pending", "retry"] },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: { seq: "asc" },
      });
      const eligibleHeadKeys = new Set(headRows.map((row) => row.nodeKey));
      if (!eligibleHeadKeys.size) return [];
      const laneRows = await tx.sync_outbox.findMany({
        where: {
          nodeKey: { in: [...eligibleHeadKeys] },
          dispatchedAt: null,
          deadLetteredAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { seq: "asc" },
        take: Math.min(take * 4, 2_000),
      });
      const blocked = new Set();
      const candidates = [];
      for (const row of laneRows) {
        if (candidates.length >= take) break;
        if (blocked.has(row.nodeKey)) continue;
        const due =
          ["pending", "retry"].includes(row.status) &&
          (!row.nextAttemptAt || row.nextAttemptAt <= now);
        if (!due) {
          blocked.add(row.nodeKey);
          continue;
        }
        candidates.push({ seq: row.seq });
      }
      if (!candidates.length) return [];
      const seqs = candidates.map((row) => Number(row.seq));
      await tx.sync_outbox.updateMany({
        where: {
          seq: { in: seqs },
          dispatchedAt: null,
          deadLetteredAt: null,
          status: { in: ["pending", "retry"] },
        },
        data: {
          status: "claimed",
          leaseOwner: owner,
          leaseExpiresAt: leaseUntil,
        },
      });
      return await tx.sync_outbox.findMany({
        where: { seq: { in: seqs }, leaseOwner: owner, status: "claimed" },
        orderBy: { seq: "asc" },
      });
    });
  },

  async releaseOutboxClaims({ seqs = [], leaseOwner } = {}) {
    const normalized = [...new Set(seqs.map(Number).filter(Number.isInteger))];
    if (!normalized.length || !leaseOwner) return { count: 0 };
    return await prisma.sync_outbox.updateMany({
      where: {
        seq: { in: normalized },
        leaseOwner: String(leaseOwner),
        status: "claimed",
        dispatchedAt: null,
      },
      data: {
        status: "retry",
        nextAttemptAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
  },

  async renewOutboxClaims({ seqs = [], leaseOwner, leaseMs = 30_000 } = {}) {
    const normalized = [...new Set(seqs.map(Number).filter(Number.isInteger))];
    if (!normalized.length || !leaseOwner) return { count: 0 };
    return await prisma.sync_outbox.updateMany({
      where: {
        seq: { in: normalized },
        leaseOwner: String(leaseOwner),
        status: "claimed",
        dispatchedAt: null,
      },
      data: {
        leaseExpiresAt: new Date(
          Date.now() + Math.max(Number(leaseMs) || 30_000, 5_000)
        ),
      },
    });
  },

  async markOutboxDispatched({ seq, leaseOwner } = {}) {
    const result = await prisma.sync_outbox.updateMany({
      where: {
        seq: Number(seq),
        leaseOwner: String(leaseOwner || ""),
        status: "claimed",
        dispatchedAt: null,
      },
      data: {
        status: "dispatched",
        dispatchedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
      },
    });
    if (result.count !== 1) {
      const error = new Error("sync_v2_outbox_lease_lost");
      error.code = "sync_v2_outbox_lease_lost";
      throw error;
    }
    return result;
  },

  async failOutboxClaim({
    seq,
    leaseOwner,
    errorCode = "sync_v2_dispatch_failed",
    errorDetail = null,
    permanent = false,
    maxAttempts = 8,
    nextAttemptAt = new Date(),
  } = {}) {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.sync_outbox.findFirst({
        where: {
          seq: Number(seq),
          leaseOwner: String(leaseOwner || ""),
          status: "claimed",
          dispatchedAt: null,
        },
        select: { attemptCount: true },
      });
      if (!row) return { updated: false, deadLettered: false };
      const attempts = Number(row.attemptCount || 0) + 1;
      const deadLettered = permanent || attempts >= Number(maxAttempts || 8);
      const result = await tx.sync_outbox.updateMany({
        where: {
          seq: Number(seq),
          leaseOwner: String(leaseOwner || ""),
          status: "claimed",
        },
        data: {
          status: deadLettered ? "dead_letter" : "retry",
          attemptCount: attempts,
          nextAttemptAt: deadLettered ? null : nextAttemptAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: String(errorCode || "sync_v2_dispatch_failed").slice(
            0,
            160
          ),
          lastErrorDetail: errorDetail
            ? String(errorDetail).slice(0, 500)
            : null,
          deadLetteredAt: deadLettered ? new Date() : null,
        },
      });
      return {
        updated: result.count === 1,
        deadLettered,
        attempts,
      };
    });
  },

  async markDispatched(seq) {
    return await prisma.sync_outbox.update({
      where: { seq: Number(seq) },
      data: {
        status: "dispatched",
        dispatchedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
  },

  async pruneExpired({ now = new Date() } = {}) {
    if (!(await this.schemaReady())) return { count: 0 };
    const deadLetterRetentionMs = Math.max(
      Number(
        process.env.SYNC_V2_OUTBOX_DEAD_LETTER_RETENTION_MS ||
          90 * 24 * 60 * 60 * 1_000
      ),
      syncV2RetentionMs()
    );
    const result = await prisma.sync_outbox.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: now }, deadLetteredAt: null },
          {
            deadLetteredAt: {
              lte: new Date(now.getTime() - deadLetterRetentionMs),
            },
          },
        ],
      },
    });
    runtimeMetrics.prunedEvents += Number(result.count || 0);
    return result;
  },

  async audienceUserIds(row = {}) {
    const explicit = safeJsonParse(row.audienceJson, [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0);
    if (explicit.length) {
      const candidates = [...new Set(explicit)];
      if (row.ownerType === "user")
        return candidates.filter((userId) => userId === Number(row.ownerId));
      const authorized = [];
      for (const userId of candidates) {
        if (
          await canAccessNode(prisma, row.nodeKey, {
            userId,
            allowAllWorkspaces: false,
          })
        )
          authorized.push(userId);
      }
      return authorized;
    }
    if (row.ownerType === "user" && Number(row.ownerId) > 0)
      return [Number(row.ownerId)];
    let workspaceId = null;
    let threadUserId = null;
    if (row.ownerType === "workspace") workspaceId = Number(row.ownerId);
    if (row.ownerType === "thread") {
      const thread = await prisma.workspace_threads.findUnique({
        where: { id: Number(row.ownerId) },
        select: { workspace_id: true, user_id: true },
      });
      workspaceId = Number(thread?.workspace_id || 0);
      threadUserId = Number(thread?.user_id || 0) || null;
    }
    if (threadUserId) return [threadUserId];
    if (!workspaceId) return [];
    return [
      ...new Set(
        (
          await prisma.workspace_users.findMany({
            where: { workspace_id: workspaceId },
            select: { user_id: true },
          })
        ).map((entry) => Number(entry.user_id))
      ),
    ];
  },

  async outboxHealth({ now = new Date() } = {}) {
    if (!(await this.schemaReady()))
      return { pending: 0, oldestPendingAgeMs: 0 };
    const [pending, retrying, deadLetters, oldest] = await Promise.all([
      prisma.sync_outbox.count({
        where: { dispatchedAt: null, deadLetteredAt: null },
      }),
      prisma.sync_outbox.count({ where: { status: "retry" } }),
      prisma.sync_outbox.count({ where: { status: "dead_letter" } }),
      prisma.sync_outbox.findFirst({
        where: { dispatchedAt: null, deadLetteredAt: null },
        orderBy: { seq: "asc" },
        select: { createdAt: true },
      }),
    ]);
    return {
      pending,
      retrying,
      deadLetters,
      oldestPendingAgeMs: oldest?.createdAt
        ? Math.max(now.getTime() - oldest.createdAt.getTime(), 0)
        : 0,
    };
  },

  async snapshot() {
    if (!(await this.schemaReady())) return { ready: false };
    const [
      nodes,
      pending,
      latest,
      cursors,
      oldestPending,
      cursorRows,
      retrying,
      claimed,
      deadLetters,
    ] = await Promise.all([
      prisma.sync_nodes.count(),
      prisma.sync_outbox.count({
        where: { dispatchedAt: null, deadLetteredAt: null },
      }),
      prisma.sync_outbox.findFirst({
        orderBy: { seq: "desc" },
        select: { seq: true },
      }),
      prisma.sync_client_cursors.count(),
      prisma.sync_outbox.findFirst({
        where: { dispatchedAt: null, deadLetteredAt: null },
        orderBy: { seq: "asc" },
        select: { seq: true, createdAt: true },
      }),
      prisma.sync_client_cursors.findMany({
        select: { lastAppliedSeq: true },
      }),
      prisma.sync_outbox.count({ where: { status: "retry" } }),
      prisma.sync_outbox.count({ where: { status: "claimed" } }),
      prisma.sync_outbox.count({ where: { status: "dead_letter" } }),
    ]);
    const latestSeq = Number(latest?.seq || 0);
    const cursorLags = cursorRows.map((row) =>
      Math.max(latestSeq - Number(row.lastAppliedSeq || 0), 0)
    );
    return {
      ready: true,
      enabled: syncV2Enabled(),
      activeDomains: [
        "profile",
        "preferences",
        "workspace",
        "chat",
        "security",
        "memory",
        "cognition",
        "agents",
        "meetings",
        "documents",
        "tasks",
        "workflows",
        "notifications",
        "entitlements",
        "integrations",
      ].filter((domain) => this.enabled(domain)),
      nodes,
      pendingOutbox: pending,
      retryingOutbox: retrying,
      claimedOutbox: claimed,
      deadLetterOutbox: deadLetters,
      latestSeq,
      cursors,
      oldestPendingSeq: oldestPending?.seq || null,
      oldestPendingAgeMs: oldestPending?.createdAt
        ? Math.max(Date.now() - oldestPending.createdAt.getTime(), 0)
        : 0,
      maxCursorLag: cursorLags.length ? Math.max(...cursorLags) : 0,
      averageCursorLag: cursorLags.length
        ? Math.round(
            cursorLags.reduce((sum, lag) => sum + lag, 0) / cursorLags.length
          )
        : 0,
      metrics: { ...runtimeMetrics },
    };
  },

  _descriptor: descriptor,
  _outboxEvent: outboxEvent,
  _canAccessNode: canAccessNode,
  _loadNodePayload: loadNodePayload,
  _pathsOverlap: pathsOverlap,
  _startupMaterializationKeys: startupMaterializationKeys,
  _resetSchemaReadyForTests() {
    schemaReadyCache = { checkedAt: 0, ready: false };
    for (const key of Object.keys(runtimeMetrics)) runtimeMetrics[key] = 0;
  },
};

module.exports = { SyncV2 };
