const crypto = require("crypto");
const prisma = require("../prisma");
const authPrisma = require("../authPrisma");
const { decryptSecretIfNeeded } = require("./encryption");
const {
  USER_DOMAIN_KEY_VERSION,
  USER_DOMAIN_WRAP_VERSION,
  normalizedUserDomainMetadata,
  platformWrapMetadata,
  sealUserDomainMaterialForDevice,
  validateUserDomainWrapEnvelope,
} = require("./userDomainWrapping");

const PREPARABLE_RESOURCE_TYPES = new Set([
  "chat-conversation-key",
  "content-object",
  "direct-field-dek",
]);
const WRAP_STATUS_PENDING = "pending";
const WRAP_STATUS_ACTIVE = "active";
const WRAP_STATUS_DEVICE_VERIFIED = "active_device_verified";

function wrapId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function safeJson(value, fallback = {}) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function wrapIdempotencyKey(input = {}) {
  const metadata = normalizedUserDomainMetadata(input);
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        version: USER_DOMAIN_WRAP_VERSION,
        ...metadata,
      })
    )
    .digest("hex");
}

async function activeUserRoot(authUserId) {
  return authPrisma.user_root_key_epochs.findFirst({
    where: {
      authUserId: Number(authUserId),
      status: "active",
    },
    orderBy: { rootEpoch: "desc" },
  });
}

function publicWrap(row = null, { includeEnvelope = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    domain: row.domain,
    wrapVersion: row.wrapVersion,
    rootKeyId: row.rootKeyId,
    rootEpoch: row.rootEpoch,
    domainKeyVersion: row.domainKeyVersion,
    platformWrapVersion: row.platformWrapVersion || null,
    platformKeyId: row.platformKeyId || null,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt || null,
    ...(includeEnvelope && row.userWrappedKeyJson
      ? { envelope: safeJson(row.userWrappedKeyJson, null) }
      : {}),
  };
}

async function queueUserDomainWrap({
  userId,
  authUserId,
  resourceType,
  resourceId,
  domain,
  platformWrappedValue = null,
  platformWrapVersion = null,
  platformKeyId = null,
  domainKeyVersion = USER_DOMAIN_KEY_VERSION,
  createdByClientId = null,
  migrationJobId = null,
  client = prisma,
} = {}) {
  const root = await activeUserRoot(authUserId);
  if (!root) return { queued: false, reason: "user_root_not_initialized" };
  const metadata = normalizedUserDomainMetadata({
    authUserId,
    rootKeyId: root.rootKeyId,
    rootEpoch: root.rootEpoch,
    domainKeyVersion,
    domain,
    resourceType,
    resourceId,
  });
  const platform = platformWrappedValue
    ? platformWrapMetadata(platformWrappedValue)
    : {
        platformWrapVersion: platformWrapVersion || null,
        platformKeyId: platformKeyId || null,
      };
  const where = {
    authUserId_resourceType_resourceId_domain_rootKeyId_domainKeyVersion: {
      authUserId: metadata.authUserId,
      resourceType: metadata.resourceType,
      resourceId: metadata.resourceId,
      domain: metadata.domain,
      rootKeyId: metadata.rootKeyId,
      domainKeyVersion: metadata.domainKeyVersion,
    },
  };
  const row = await client.user_domain_key_wraps.upsert({
    where,
    create: {
      id: wrapId("udw"),
      userId: Number(userId),
      ...metadata,
      wrapVersion: USER_DOMAIN_WRAP_VERSION,
      platformWrapVersion: platform.platformWrapVersion,
      platformKeyId: platform.platformKeyId,
      createdByClientId: createdByClientId ? String(createdByClientId) : null,
      migrationJobId: migrationJobId ? String(migrationJobId) : null,
      idempotencyKey: wrapIdempotencyKey(metadata),
    },
    update: {
      platformWrapVersion: platform.platformWrapVersion,
      platformKeyId: platform.platformKeyId,
      migrationJobId: migrationJobId ? String(migrationJobId) : undefined,
      updatedAt: new Date(),
    },
  });
  return { queued: true, wrap: publicWrap(row) };
}

async function listUserDomainWraps({
  userId,
  authUserId,
  status = null,
  resourceType = null,
  resourceId = null,
  limit = 50,
  includeEnvelope = false,
} = {}) {
  const rows = await prisma.user_domain_key_wraps.findMany({
    where: {
      userId: Number(userId),
      authUserId: Number(authUserId),
      ...(status ? { status: String(status) } : {}),
      ...(resourceType ? { resourceType: String(resourceType) } : {}),
      ...(resourceId ? { resourceId: String(resourceId) } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(Number(limit) || 50, 200)),
  });
  return rows.map((row) => publicWrap(row, { includeEnvelope }));
}

async function ownedWrap({ wrapId: id, userId, authUserId } = {}) {
  return prisma.user_domain_key_wraps.findFirst({
    where: {
      id: String(id || ""),
      userId: Number(userId),
      authUserId: Number(authUserId),
    },
  });
}

async function chatConversationKeyMaterial(row, userId) {
  const rows = await prisma.$queryRaw`
    SELECT "wrapped_key"
    FROM "workspace_chat_conversation_keys"
    WHERE "key_id" = ${row.resourceId}
      AND "user_id" = ${Number(userId)}
    LIMIT 1
  `;
  const wrapped = rows?.[0]?.wrapped_key;
  if (!wrapped) throw new Error("user_domain_resource_not_found");
  return Buffer.from(decryptSecretIfNeeded(wrapped), "base64url");
}

async function contentObjectKeyMaterial(row, userId) {
  const authorized = await prisma.$queryRaw`
    SELECT 1 AS "allowed"
    FROM "content_objects" AS "object"
    WHERE "object"."id" = ${row.resourceId}
      AND EXISTS (
        SELECT 1
        FROM "workspace_chats" AS "chat"
        LEFT JOIN "workspace_chat_attachment_refs" AS "attachment"
          ON "attachment"."chatId" = "chat"."id"
        LEFT JOIN "workspace_chat_content_refs" AS "content"
          ON "content"."chatId" = "chat"."id"
        WHERE "chat"."user_id" = ${Number(userId)}
          AND "chat"."deletedAt" IS NULL
          AND (
            "attachment"."contentObjectId" = "object"."id"
            OR "content"."contentObjectId" = "object"."id"
          )
      )
    LIMIT 1
  `;
  if (!authorized?.length) throw new Error("user_domain_resource_not_found");
  const object = await prisma.content_objects.findUnique({
    where: { id: row.resourceId },
    select: { wrappedDek: true },
  });
  if (!object?.wrappedDek) throw new Error("user_domain_resource_not_found");
  return Buffer.from(
    decryptSecretIfNeeded(object.wrappedDek, {
      purpose: "content-object-dek",
      domain: "content-object",
      resource: row.resourceId,
    }),
    "base64url"
  );
}

async function platformKeyMaterial(row, userId) {
  let material;
  if (row.resourceType === "chat-conversation-key") {
    material = await chatConversationKeyMaterial(row, userId);
  } else if (row.resourceType === "content-object") {
    material = await contentObjectKeyMaterial(row, userId);
  } else if (row.resourceType === "direct-field-dek") {
    const { platformDekMaterial } = require("../cryptoAccount");
    material = await platformDekMaterial(row.resourceId, userId);
  } else {
    throw new Error("user_domain_device_material_required");
  }
  if (material.length !== 32)
    throw new Error("user_domain_key_material_invalid");
  return material;
}

async function prepareUserDomainWrap({
  wrapId: id,
  userId,
  authUserId,
  targetClientId,
  targetKeyGeneration,
  targetKEMPublicKey,
} = {}) {
  const row = await ownedWrap({ wrapId: id, userId, authUserId });
  if (!row) throw new Error("user_domain_wrap_not_found");
  if (row.status !== WRAP_STATUS_PENDING)
    throw new Error("user_domain_wrap_not_pending");
  if (!PREPARABLE_RESOURCE_TYPES.has(row.resourceType))
    throw new Error("user_domain_device_material_required");
  const root = await activeUserRoot(authUserId);
  if (
    !root ||
    root.rootKeyId !== row.rootKeyId ||
    Number(root.rootEpoch) !== Number(row.rootEpoch)
  )
    throw new Error("user_domain_root_mismatch");
  const material = await platformKeyMaterial(row, userId);
  return sealUserDomainMaterialForDevice({
    keyMaterial: material,
    targetClientId,
    targetKeyGeneration,
    targetKEMPublicKey,
    authUserId: row.authUserId,
    rootKeyId: row.rootKeyId,
    rootEpoch: row.rootEpoch,
    domainKeyVersion: row.domainKeyVersion,
    domain: row.domain,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
  });
}

async function completeUserDomainWrap({
  wrapId: id,
  userId,
  authUserId,
  clientId,
  envelope,
} = {}) {
  const row = await ownedWrap({ wrapId: id, userId, authUserId });
  if (!row) throw new Error("user_domain_wrap_not_found");
  const normalized = validateUserDomainWrapEnvelope(envelope, {
    authUserId: row.authUserId,
    rootKeyId: row.rootKeyId,
    rootEpoch: row.rootEpoch,
    domainKeyVersion: row.domainKeyVersion,
    domain: row.domain,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
  });
  if ([WRAP_STATUS_ACTIVE, WRAP_STATUS_DEVICE_VERIFIED].includes(row.status)) {
    if (row.userWrappedKeyJson === normalized.envelopeJson) {
      return publicWrap(row, { includeEnvelope: true });
    }
    throw new Error("user_domain_wrap_already_completed");
  }
  const root = await activeUserRoot(authUserId);
  if (
    !root ||
    root.rootKeyId !== row.rootKeyId ||
    Number(root.rootEpoch) !== Number(row.rootEpoch)
  )
    throw new Error("user_domain_root_mismatch");

  let status = WRAP_STATUS_DEVICE_VERIFIED;
  if (PREPARABLE_RESOURCE_TYPES.has(row.resourceType)) {
    const material = await platformKeyMaterial(row, userId);
    const commitment = crypto
      .createHash("sha256")
      .update(material)
      .digest("base64url");
    if (commitment !== normalized.keyCommitment)
      throw new Error("user_domain_key_commitment_mismatch");
    status = WRAP_STATUS_ACTIVE;
  }
  const updated = await prisma.user_domain_key_wraps.update({
    where: { id: row.id },
    data: {
      userWrappedKeyJson: normalized.envelopeJson,
      status,
      createdByClientId: String(clientId || row.createdByClientId || ""),
      completedAt: new Date(),
      updatedAt: new Date(),
    },
  });
  if (updated.resourceType === "direct-field-dek") {
    const { activateConnectionAfterWrap } = require("../cryptoAccount");
    await activateConnectionAfterWrap({
      userId: updated.userId,
      authUserId: updated.authUserId,
      connectionId: updated.resourceId,
    });
  }
  if (updated.migrationJobId) {
    await prisma.user_domain_migration_jobs.updateMany({
      where: { id: updated.migrationJobId },
      data: {
        completedCount: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    const job = await prisma.user_domain_migration_jobs.findUnique({
      where: { id: updated.migrationJobId },
    });
    if (
      job &&
      Number(job.queuedCount) > 0 &&
      Number(job.completedCount) >= Number(job.queuedCount)
    ) {
      await prisma.user_domain_migration_jobs.update({
        where: { id: job.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
  }
  return publicWrap(updated, { includeEnvelope: true });
}

async function createOrResumeMigrationJob({
  userId,
  authUserId,
  resourceType,
  domain,
  batchSize = 100,
  createdByClientId = null,
} = {}) {
  const root = await activeUserRoot(authUserId);
  if (!root) throw new Error("user_root_not_initialized");
  const idempotencyKey = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        version: "athena-user-domain-migration-job:v1",
        authUserId: Number(authUserId),
        rootKeyId: root.rootKeyId,
        rootEpoch: root.rootEpoch,
        resourceType: String(resourceType),
        domain: String(domain),
      })
    )
    .digest("hex");
  const existing = await prisma.user_domain_migration_jobs.findUnique({
    where: { idempotencyKey },
  });
  if (existing && ["waiting_device", "completed"].includes(existing.status)) {
    return existing;
  }
  return prisma.user_domain_migration_jobs.upsert({
    where: { idempotencyKey },
    create: {
      id: wrapId("udmj"),
      userId: Number(userId),
      authUserId: Number(authUserId),
      resourceType: String(resourceType),
      domain: String(domain),
      batchSize: Math.max(1, Math.min(Number(batchSize) || 100, 1_000)),
      idempotencyKey,
      createdByClientId: createdByClientId ? String(createdByClientId) : null,
    },
    update: {
      status: "running",
      updatedAt: new Date(),
      lastError: null,
    },
  });
}

async function advanceMigrationJob({
  jobId,
  checkpoint,
  scanned = 0,
  queued = 0,
  failed = 0,
  done = false,
  error = null,
} = {}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.user_domain_migration_jobs.findUnique({
      where: { id: String(jobId) },
      select: { queuedCount: true, completedCount: true },
    });
    if (!current) throw new Error("user_domain_migration_job_not_found");
    const nextQueued = Number(current.queuedCount) + (Number(queued) || 0);
    const nextCompleted = Number(current.completedCount);
    const status = error
      ? "failed"
      : done
        ? nextCompleted >= nextQueued
          ? "completed"
          : "waiting_device"
        : "running";
    return tx.user_domain_migration_jobs.update({
      where: { id: String(jobId) },
      data: {
        checkpointJson: JSON.stringify(checkpoint || {}),
        scannedCount: { increment: Number(scanned) || 0 },
        queuedCount: { increment: Number(queued) || 0 },
        failedCount: { increment: Number(failed) || 0 },
        status,
        lastError: error ? String(error).slice(0, 512) : null,
        updatedAt: new Date(),
        ...(done ? { completedAt: new Date() } : {}),
      },
    });
  });
}

async function userDomainWrapCoverage({
  userId = null,
  authUserId = null,
} = {}) {
  const currentRoot = authUserId
    ? await activeUserRoot(Number(authUserId))
    : null;
  const where = {
    ...(userId ? { userId: Number(userId) } : {}),
    ...(authUserId ? { authUserId: Number(authUserId) } : {}),
    ...(currentRoot
      ? {
          rootKeyId: currentRoot.rootKeyId,
          rootEpoch: currentRoot.rootEpoch,
        }
      : {}),
  };
  const rows = await prisma.user_domain_key_wraps.groupBy({
    by: ["resourceType", "domain", "status"],
    where,
    _count: { _all: true },
  });
  const totals = await prisma.user_domain_key_wraps.count({ where });
  const active = await prisma.user_domain_key_wraps.count({
    where: {
      ...where,
      status: { in: [WRAP_STATUS_ACTIVE, WRAP_STATUS_DEVICE_VERIFIED] },
    },
  });
  const eligible =
    userId && authUserId
      ? await eligibleUserDomainResources({ userId, authUserId })
      : null;
  const eligibleTotal = eligible
    ? Object.values(eligible.byResource).reduce(
        (total, count) => total + count,
        0
      )
    : totals;
  return {
    total: totals,
    active,
    pending: Math.max(0, totals - active),
    eligible: eligibleTotal,
    missing: Math.max(0, eligibleTotal - totals),
    coverage:
      eligibleTotal === 0 ? 1 : Math.min(active, eligibleTotal) / eligibleTotal,
    byResource: rows.map((row) => ({
      resourceType: row.resourceType,
      domain: row.domain,
      status: row.status,
      count: row._count._all,
    })),
    ...(eligible ? { eligibleByResource: eligible.byResource } : {}),
    ...(currentRoot
      ? {
          rootKeyId: currentRoot.rootKeyId,
          rootEpoch: currentRoot.rootEpoch,
        }
      : {}),
  };
}

async function eligibleUserDomainResources({ userId, authUserId } = {}) {
  const ownerId = Number(userId);
  const sharedId = Number(authUserId);
  if (
    !Number.isSafeInteger(ownerId) ||
    ownerId < 1 ||
    !Number.isSafeInteger(sharedId) ||
    sharedId < 1
  )
    throw new Error("user_domain_owner_invalid");
  const [chat, fileRows, vaultRows, cryptoConnections] = await Promise.all([
    prisma.workspace_chat_conversation_keys.count({
      where: { user_id: ownerId },
    }),
    prisma.$queryRawUnsafe(`
      SELECT COUNT(*) AS "value"
      FROM (
        SELECT DISTINCT "attachment"."contentObjectId"
        FROM "workspace_chat_attachment_refs" AS "attachment"
        INNER JOIN "workspace_chats" AS "chat"
          ON "chat"."id" = "attachment"."chatId"
        WHERE "chat"."user_id" = ${ownerId}
          AND "chat"."deletedAt" IS NULL
        UNION
        SELECT DISTINCT "content"."contentObjectId"
        FROM "workspace_chat_content_refs" AS "content"
        INNER JOIN "workspace_chats" AS "chat"
          ON "chat"."id" = "content"."chatId"
        WHERE "chat"."user_id" = ${ownerId}
          AND "chat"."deletedAt" IS NULL
      ) AS "owned_content"
    `),
    prisma.vault_items.findMany({
      where: { userId: ownerId, deletedAt: null },
      distinct: ["keyId"],
      select: { keyId: true },
    }),
    prisma.crypto_account_connections.count({
      where: {
        userId: ownerId,
        authUserId: sharedId,
        revokedAt: null,
        status: { in: ["pending_wrap", "active"] },
        readOnly: true,
      },
    }),
  ]);
  return {
    userId: ownerId,
    authUserId: sharedId,
    byResource: {
      "chat-conversation-key": Number(chat),
      "content-object": Number(fileRows?.[0]?.value || 0),
      "vault-master-key": vaultRows.filter((row) => row.keyId).length,
      "direct-field-dek": Number(cryptoConnections),
    },
  };
}

module.exports = {
  PREPARABLE_RESOURCE_TYPES,
  WRAP_STATUS_ACTIVE,
  WRAP_STATUS_DEVICE_VERIFIED,
  WRAP_STATUS_PENDING,
  activeUserRoot,
  advanceMigrationJob,
  completeUserDomainWrap,
  createOrResumeMigrationJob,
  eligibleUserDomainResources,
  listUserDomainWraps,
  platformKeyMaterial,
  prepareUserDomainWrap,
  publicWrap,
  queueUserDomainWrap,
  userDomainWrapCoverage,
};
