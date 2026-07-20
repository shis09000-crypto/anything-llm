#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

const requestedMaterialize = process.argv.includes("--materialize");
const requestedRepair = process.argv.includes("--repair");
const execute = process.argv.includes("--execute");
const materialize = requestedMaterialize && execute;
const repair = requestedRepair && execute;
let prisma;
let SyncV2;
let contentHash;
let classifyNodeKey;

function isTransientSqliteWriteError(error) {
  const message = String(error?.message || error || "");
  return /database is locked|SQLITE_BUSY|Timed out during query execution/i.test(
    message
  );
}

async function withSqliteWriteRetry(operation, { attempts = 5 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientSqliteWriteError(error) || attempt === attempts - 1)
        throw error;
      const delayMs = Math.min(2_000, 100 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function permitsAllWorkspaces(user) {
  return ["admin", "owner"].includes(String(user?.role || "").toLowerCase());
}

async function visibleUsersForNode(node, users) {
  const visible = [];
  for (const user of users) {
    if (
      await SyncV2.canAccessNode({
        nodeKey: node.nodeKey,
        userId: user.id,
        allowAllWorkspaces: permitsAllWorkspaces(user),
      })
    ) {
      visible.push(user);
    }
  }
  return visible;
}

async function materializeUsers(users) {
  let created = 0;
  for (const user of users) {
    const results = await SyncV2.materializeCoreForUser({
      userId: user.id,
      allowAllWorkspaces: permitsAllWorkspaces(user),
    });
    created += results.length;
  }
  return created;
}

async function audit() {
  if (!(await SyncV2.schemaReady({ force: true }))) {
    throw new Error("sync_v2_schema_unavailable");
  }

  const users = await prisma.users.findMany({
    select: { id: true, role: true },
    orderBy: { id: "asc" },
  });
  const materializedNodes = materialize ? await materializeUsers(users) : 0;
  const nodes = await prisma.sync_nodes.findMany({
    orderBy: { nodeKey: "asc" },
  });
  const summary = {
    mode: repair
      ? "repair"
      : materialize
        ? "materialize"
        : requestedRepair || requestedMaterialize
          ? "dry-run"
          : "read-only",
    requestedMode: requestedRepair
      ? "repair"
      : requestedMaterialize
        ? "materialize"
        : null,
    instruction:
      (requestedRepair || requestedMaterialize) && !execute
        ? "Repeat with explicit APP_ENV or --env plus --execute to mutate."
        : null,
    users: users.length,
    nodes: nodes.length,
    materializedNodes,
    checkedProjections: 0,
    inaccessibleNodes: 0,
    tombstones: 0,
    missingPayloads: 0,
    hashMismatches: 0,
    projectionConflicts: 0,
    nonHashNodeHashes: 0,
    repairedNodes: 0,
    samples: [],
  };

  for (const node of nodes) {
    const parsed = classifyNodeKey(node.nodeKey);
    if (!parsed) continue;
    if (node.deletedAt) {
      summary.tombstones += 1;
      continue;
    }
    const visibleUsers = await visibleUsersForNode(node, users);
    if (!visibleUsers.length) {
      summary.inaccessibleNodes += 1;
      summary.samples.push({ nodeKey: node.nodeKey, issue: "no_visible_user" });
      continue;
    }

    if (["event-cursor", "version-only"].includes(parsed.consistency)) {
      if (node.contentHash) {
        summary.nonHashNodeHashes += 1;
        if (repair) {
          await prisma.sync_nodes.update({
            where: { nodeKey: node.nodeKey },
            data: { contentHash: null },
          });
          summary.repairedNodes += 1;
        }
      }
      continue;
    }

    const projectionHashes = new Set();
    for (const user of visibleUsers) {
      const payload = await SyncV2._loadNodePayload(prisma, parsed, {
        userId: user.id,
        allowAllWorkspaces: permitsAllWorkspaces(user),
      });
      if (payload === null) {
        summary.missingPayloads += 1;
        continue;
      }
      summary.checkedProjections += 1;
      projectionHashes.add(contentHash(payload));
    }

    if (projectionHashes.size > 1) {
      summary.projectionConflicts += 1;
      summary.samples.push({
        nodeKey: node.nodeKey,
        issue: "user_projection_conflict",
        projectionCount: projectionHashes.size,
      });
      continue;
    }
    const [expectedHash] = projectionHashes;
    if (!expectedHash || expectedHash === node.contentHash) continue;
    summary.hashMismatches += 1;
    summary.samples.push({ nodeKey: node.nodeKey, issue: "hash_mismatch" });
    if (repair) {
      const [user] = visibleUsers;
      const result = await withSqliteWriteRetry(() =>
        SyncV2.batchGet({
          userId: user.id,
          allowAllWorkspaces: permitsAllWorkspaces(user),
          nodes: [{ nodeKey: node.nodeKey }],
        })
      );
      if (result[0]?.repaired) summary.repairedNodes += 1;
    }
  }

  summary.samples = summary.samples.slice(0, 25);
  summary.snapshot = await SyncV2.snapshot();
  console.log(JSON.stringify(summary, null, 2));
}

async function run() {
  await bootstrapCliRuntime({
    access: repair || materialize ? "write" : "read",
    execute: repair || materialize,
    requiredTables: ["users", "sync_nodes", "sync_outbox"],
  });
  prisma = require("../utils/prisma");
  SyncV2 = require("../models/syncV2").SyncV2;
  contentHash = require("../utils/syncV2/canonicalJson").contentHash;
  classifyNodeKey = require("../utils/syncV2/nodeRegistry").classifyNodeKey;
  return audit();
}

run()
  .catch((error) => {
    console.error(`[sync-v2-shadow-audit] ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect();
  });
