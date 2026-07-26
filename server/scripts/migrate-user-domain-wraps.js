#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function parsedCheckpoint(job = null) {
  try {
    return JSON.parse(job?.checkpointJson || "{}");
  } catch {
    return {};
  }
}

async function queueBatch({
  prisma,
  queueUserDomainWrap,
  job,
  user,
  root,
  resourceType,
  domain,
}) {
  const checkpoint = parsedCheckpoint(job);
  const cursor = Number(checkpoint.lastId || 0);
  const take = Number(job.batchSize);
  let rows = [];
  let resources = [];

  if (resourceType === "chat-conversation-key") {
    rows = await prisma.workspace_chat_conversation_keys.findMany({
      where: { user_id: user.id, id: { gt: cursor } },
      orderBy: { id: "asc" },
      take,
      select: { id: true, key_id: true, wrapped_key: true },
    });
    resources = rows.map((row) => ({
      resourceId: row.key_id,
      platformWrappedValue: row.wrapped_key,
    }));
  } else if (resourceType === "content-object") {
    rows = await prisma.workspace_chats.findMany({
      where: { user_id: user.id, deletedAt: null, id: { gt: cursor } },
      orderBy: { id: "asc" },
      take,
      select: { id: true },
    });
    const chatIds = rows.map((row) => row.id);
    if (chatIds.length) {
      const [attachments, contentRefs] = await Promise.all([
        prisma.workspace_chat_attachment_refs.findMany({
          where: { chatId: { in: chatIds } },
          select: { contentObjectId: true },
        }),
        prisma.workspace_chat_content_refs.findMany({
          where: { chatId: { in: chatIds } },
          select: { contentObjectId: true },
        }),
      ]);
      const objectIds = [
        ...new Set(
          [...attachments, ...contentRefs].map((row) => row.contentObjectId)
        ),
      ];
      const objects = objectIds.length
        ? await prisma.content_objects.findMany({
            where: { id: { in: objectIds } },
            select: { id: true, wrappedDek: true },
          })
        : [];
      resources = objects.map((row) => ({
        resourceId: row.id,
        platformWrappedValue: row.wrappedDek,
      }));
    }
  } else if (resourceType === "vault-master-key") {
    rows = await prisma.vault_items.findMany({
      where: { userId: user.id, deletedAt: null, id: { gt: cursor } },
      orderBy: { id: "asc" },
      take,
      select: { id: true, keyId: true, cryptoVersion: true },
    });
    resources = rows
      .filter((row) => row.keyId)
      .map((row) => ({
        resourceId: row.keyId,
        platformWrapVersion: `vault-client:${row.cryptoVersion}`,
        platformKeyId: row.keyId,
      }));
  } else {
    throw new Error(`unsupported_user_domain_resource:${resourceType}`);
  }

  let queued = 0;
  let failed = 0;
  for (const resource of resources) {
    try {
      const result = await queueUserDomainWrap({
        userId: user.id,
        authUserId: user.authUserId,
        resourceType,
        domain,
        ...resource,
        migrationJobId: job.id,
      });
      if (result.queued) queued += 1;
    } catch {
      failed += 1;
    }
  }
  const lastId = rows.at(-1)?.id || cursor;
  return {
    checkpoint: { lastId, rootKeyId: root.rootKeyId },
    scanned: rows.length,
    queued,
    failed,
    done: rows.length < take,
  };
}

async function migrateUser({ prisma, services, user, root, batchSize, apply }) {
  const lanes = [
    { resourceType: "chat-conversation-key", domain: "data" },
    { resourceType: "content-object", domain: "file" },
    { resourceType: "vault-master-key", domain: "vault" },
  ];
  const result = {
    userId: user.id,
    authUserId: user.authUserId,
    rootKeyId: root.rootKeyId,
    rootEpoch: root.rootEpoch,
    mode: apply ? "apply" : "dry-run",
    lanes: [],
  };
  if (!apply) {
    result.eligible = await services.eligibleUserDomainResources({
      userId: user.id,
      authUserId: user.authUserId,
    });
    return result;
  }
  for (const lane of lanes) {
    const job = await services.createOrResumeMigrationJob({
      userId: user.id,
      authUserId: user.authUserId,
      ...lane,
      batchSize,
    });
    const batch = await queueBatch({
      prisma,
      queueUserDomainWrap: services.queueUserDomainWrap,
      job,
      user,
      root,
      ...lane,
    });
    const updated = await services.advanceMigrationJob({
      jobId: job.id,
      ...batch,
    });
    result.lanes.push({
      ...lane,
      jobId: job.id,
      status: updated.status,
      ...batch,
    });
  }
  result.coverage = await services.userDomainWrapCoverage({
    userId: user.id,
    authUserId: user.authUserId,
  });
  return result;
}

async function run({
  prisma,
  authPrisma,
  services,
  batchSize = 100,
  apply = false,
} = {}) {
  if (authPrisma.$authPrismaReady) await authPrisma.$authPrismaReady;
  const users = await prisma.users.findMany({
    where: { authUserId: { not: null } },
    orderBy: { id: "asc" },
    select: { id: true, authUserId: true },
  });
  const results = [];
  for (const user of users) {
    const root = await services.activeUserRoot(user.authUserId);
    if (!root) {
      results.push({
        userId: user.id,
        authUserId: user.authUserId,
        skipped: true,
        reason: "user_root_not_initialized",
      });
      continue;
    }
    results.push(
      await migrateUser({
        prisma,
        services,
        user,
        root,
        batchSize,
        apply,
      })
    );
  }
  return {
    success: true,
    mode: apply ? "apply" : "dry-run",
    batchSize,
    users: results,
    highIoLanes: {
      status: "deferred_until_owner_classification",
      resources: ["document-store", "vector-cache", "direct-encrypted-fields"],
      reason:
        "These resources require an explicit user ownership mapping before a user-domain DEK can be introduced.",
    },
  };
}

async function main() {
  await bootstrapCliRuntime({
    requiredTables: [
      "users",
      "workspace_chat_conversation_keys",
      "content_objects",
      "vault_items",
      "user_domain_key_wraps",
      "user_domain_migration_jobs",
      "_prisma_migrations",
    ],
  });
  const prisma = require("../utils/prisma");
  const authPrisma = require("../utils/authPrisma");
  const services = require("../utils/security/userDomainWrapService");
  const requestedApply = hasArg("--apply");
  const execute = hasArg("--execute");
  const result = await run({
    prisma,
    authPrisma,
    services,
    batchSize: Math.max(
      1,
      Math.min(Number(argValue("--batch-size", 100)) || 100, 1_000)
    ),
    apply: requestedApply && execute,
  });
  result.requestedApply = requestedApply;
  if (requestedApply && !execute) {
    result.instruction =
      "Repeat with --apply --execute to persist migration checkpoints and wrap records.";
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(
        JSON.stringify(
          { success: false, error: error?.message || String(error) },
          null,
          2
        )
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      const prisma = require("../utils/prisma");
      const authPrisma = require("../utils/authPrisma");
      await Promise.allSettled([
        prisma.$disconnect(),
        authPrisma.$disconnect(),
      ]);
    });
}

module.exports = { migrateUser, queueBatch, run };
