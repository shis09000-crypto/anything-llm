const { randomUUID } = require("crypto");
const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

const DEFAULT_LEASE_MS = 2 * 60_000;

function compact(value, max = 160) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    resource: safeJsonParse(row.resourceJson, {}),
    result: safeJsonParse(row.resultJson, {}),
  };
}

async function updateOwnedReceipt({
  userId,
  sourceActionId,
  leaseOwner = null,
  data,
}) {
  const where = {
    userId: Number(userId),
    sourceActionId: String(sourceActionId),
    ...(leaseOwner ? { leaseOwner: String(leaseOwner) } : {}),
  };
  const result = await prisma.athena_mutation_receipts.updateMany({
    where,
    data,
  });
  if (leaseOwner && result.count !== 1) {
    const error = new Error("mutation_receipt_lease_lost");
    error.code = "mutation_receipt_lease_lost";
    throw error;
  }
  return hydrate(
    await prisma.athena_mutation_receipts.findUnique({
      where: {
        userId_sourceActionId: {
          userId: Number(userId),
          sourceActionId: String(sourceActionId),
        },
      },
    })
  );
}

const AthenaMutationReceipt = {
  async reserve({
    userId,
    sourceActionId,
    action,
    workspaceId,
    threadId,
    baseVersion = null,
    requestHash = null,
    nodeKey = null,
    mutationId = null,
    expiresAt = null,
    leaseOwner = randomUUID(),
    leaseMs = DEFAULT_LEASE_MS,
  }) {
    const owner = numberOrNull(userId);
    const actionId = compact(sourceActionId);
    if (!owner || !actionId)
      return { receipt: null, created: true, claimed: false, leaseOwner: null };
    const now = new Date();
    const leaseDuration = positiveInteger(leaseMs, DEFAULT_LEASE_MS);
    const leaseUntil = new Date(now.getTime() + leaseDuration);
    const staleBefore = new Date(now.getTime() - leaseDuration);
    const normalizedLeaseOwner = compact(leaseOwner) || randomUUID();

    const claimExisting = async (existing) => {
      if (!existing) return null;
      const result = await prisma.athena_mutation_receipts.updateMany({
        where: {
          id: existing.id,
          status: { in: ["pending", "recoverable"] },
          OR: [
            { status: "recoverable" },
            { leaseExpiresAt: { lte: now } },
            { leaseExpiresAt: null, updatedAt: { lte: staleBefore } },
          ],
        },
        data: {
          status: "pending",
          leaseOwner: normalizedLeaseOwner,
          leaseExpiresAt: leaseUntil,
          attemptCount: { increment: 1 },
          lastErrorCode: null,
          nodeKey: compact(nodeKey, 500) || existing.nodeKey,
          mutationId: compact(mutationId) || existing.mutationId,
          updatedAt: now,
        },
      });
      if (result.count !== 1) return null;
      const receipt = await prisma.athena_mutation_receipts.findUnique({
        where: { id: existing.id },
      });
      return {
        receipt: hydrate(receipt),
        created: true,
        claimed: true,
        recovered: true,
        leaseOwner: normalizedLeaseOwner,
      };
    };

    const existing = await prisma.athena_mutation_receipts.findUnique({
      where: {
        userId_sourceActionId: { userId: owner, sourceActionId: actionId },
      },
    });
    if (existing) {
      const claimed = await claimExisting(existing);
      if (claimed) return claimed;
      return {
        receipt: hydrate(
          await prisma.athena_mutation_receipts.findUnique({
            where: { id: existing.id },
          })
        ),
        created: false,
        claimed: false,
        leaseOwner: null,
      };
    }

    try {
      const receipt = await prisma.athena_mutation_receipts.create({
        data: {
          userId: owner,
          sourceActionId: actionId,
          action: compact(action, 80) || "unknown",
          workspaceId: numberOrNull(workspaceId),
          threadId: numberOrNull(threadId),
          baseVersion: Number.isInteger(Number(baseVersion))
            ? Number(baseVersion)
            : null,
          requestHash: compact(requestHash, 128),
          nodeKey: compact(nodeKey, 500),
          mutationId: compact(mutationId),
          leaseOwner: normalizedLeaseOwner,
          leaseExpiresAt: leaseUntil,
          attemptCount: 1,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
      });
      return {
        receipt: hydrate(receipt),
        created: true,
        claimed: true,
        leaseOwner: normalizedLeaseOwner,
      };
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      const raced = await prisma.athena_mutation_receipts.findUnique({
        where: {
          userId_sourceActionId: { userId: owner, sourceActionId: actionId },
        },
      });
      const claimed = await claimExisting(raced);
      if (claimed) return claimed;
      return {
        receipt: hydrate(raced),
        created: false,
        claimed: false,
        leaseOwner: null,
      };
    }
  },

  async complete({
    userId,
    sourceActionId,
    leaseOwner = null,
    resource = {},
    resultVersion = null,
    result = {},
  }) {
    const owner = numberOrNull(userId);
    const actionId = compact(sourceActionId);
    if (!owner || !actionId) return null;
    return await updateOwnedReceipt({
      userId: owner,
      sourceActionId: actionId,
      leaseOwner,
      data: {
        status: "completed",
        resourceJson: JSON.stringify(resource || {}),
        resultVersion: Number.isInteger(Number(resultVersion))
          ? Number(resultVersion)
          : null,
        resultJson: JSON.stringify(result || {}),
        errorCode: null,
        lastErrorCode: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      },
    });
  },

  async fail({
    userId,
    sourceActionId,
    leaseOwner = null,
    errorCode = "mutation_failed",
  }) {
    const owner = numberOrNull(userId);
    const actionId = compact(sourceActionId);
    if (!owner || !actionId) return null;
    const normalizedCode = compact(errorCode, 120);
    return await updateOwnedReceipt({
      userId: owner,
      sourceActionId: actionId,
      leaseOwner,
      data: {
        status: "failed",
        errorCode: normalizedCode,
        lastErrorCode: normalizedCode,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      },
    });
  },

  async release({
    userId,
    sourceActionId,
    leaseOwner,
    errorCode = "mutation_retry_required",
  }) {
    const owner = numberOrNull(userId);
    const actionId = compact(sourceActionId);
    if (!owner || !actionId) return null;
    return await updateOwnedReceipt({
      userId: owner,
      sourceActionId: actionId,
      leaseOwner,
      data: {
        status: "recoverable",
        errorCode: null,
        lastErrorCode: compact(errorCode, 120),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      },
    });
  },

  async renew({
    userId,
    sourceActionId,
    leaseOwner,
    leaseMs = DEFAULT_LEASE_MS,
  } = {}) {
    const owner = numberOrNull(userId);
    const actionId = compact(sourceActionId);
    if (!owner || !actionId || !leaseOwner) return { count: 0 };
    const now = new Date();
    const result = await prisma.athena_mutation_receipts.updateMany({
      where: {
        userId: owner,
        sourceActionId: actionId,
        status: "pending",
        leaseOwner: String(leaseOwner),
      },
      data: {
        leaseExpiresAt: new Date(
          now.getTime() + positiveInteger(leaseMs, DEFAULT_LEASE_MS)
        ),
        updatedAt: now,
      },
    });
    if (result.count !== 1) {
      const error = new Error("mutation_receipt_lease_lost");
      error.code = "mutation_receipt_lease_lost";
      throw error;
    }
    return result;
  },

  async sweepStale({
    now = new Date(),
    limit = 100,
    staleMs = DEFAULT_LEASE_MS,
    replayResolver = null,
  } = {}) {
    const staleBefore = new Date(
      now.getTime() - positiveInteger(staleMs, DEFAULT_LEASE_MS)
    );
    const rows = await prisma.athena_mutation_receipts.findMany({
      where: {
        status: "pending",
        OR: [
          { leaseExpiresAt: { lte: now } },
          { leaseExpiresAt: null, updatedAt: { lte: staleBefore } },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    });
    const summary = {
      scanned: rows.length,
      recovered: 0,
      released: 0,
      failed: 0,
    };
    for (const row of rows) {
      let replay = null;
      if (
        row.action === "sync-v2.mutation" &&
        row.nodeKey &&
        row.mutationId &&
        typeof replayResolver === "function"
      ) {
        replay = await replayResolver({
          nodeKey: row.nodeKey,
          mutationId: row.mutationId,
        });
      }
      if (replay) {
        const result = await prisma.athena_mutation_receipts.updateMany({
          where: {
            id: row.id,
            status: "pending",
            leaseOwner: row.leaseOwner,
            updatedAt: row.updatedAt,
          },
          data: {
            status: "completed",
            resourceJson: JSON.stringify({ nodeKey: row.nodeKey }),
            resultVersion: replay.descriptor?.stateVersion || null,
            resultJson: JSON.stringify(replay),
            errorCode: null,
            lastErrorCode: "recovered_from_sync_outbox",
            leaseOwner: null,
            leaseExpiresAt: null,
            recoveredAt: now,
            updatedAt: now,
          },
        });
        summary.recovered += Number(result.count || 0);
        continue;
      }
      const syncMutation = row.action === "sync-v2.mutation";
      const result = await prisma.athena_mutation_receipts.updateMany({
        where: {
          id: row.id,
          status: "pending",
          leaseOwner: row.leaseOwner,
          updatedAt: row.updatedAt,
        },
        data: {
          status: syncMutation ? "recoverable" : "failed",
          errorCode: syncMutation ? null : "mutation_recovery_required",
          lastErrorCode: syncMutation
            ? "mutation_lease_expired"
            : "mutation_recovery_required",
          leaseOwner: null,
          leaseExpiresAt: null,
          recoveredAt: now,
          updatedAt: now,
        },
      });
      if (syncMutation) summary.released += Number(result.count || 0);
      else summary.failed += Number(result.count || 0);
    }
    return summary;
  },

  async snapshot({ now = new Date() } = {}) {
    const [pending, recoverable, failed, stale] = await Promise.all([
      prisma.athena_mutation_receipts.count({ where: { status: "pending" } }),
      prisma.athena_mutation_receipts.count({
        where: { status: "recoverable" },
      }),
      prisma.athena_mutation_receipts.count({ where: { status: "failed" } }),
      prisma.athena_mutation_receipts.count({
        where: { status: "pending", leaseExpiresAt: { lte: now } },
      }),
    ]);
    return { pending, recoverable, failed, stale };
  },

  async pruneExpired({ now = new Date() } = {}) {
    return prisma.athena_mutation_receipts.deleteMany({
      where: {
        expiresAt: { lte: now },
        status: { in: ["completed", "failed", "recoverable"] },
      },
    });
  },
};

module.exports = { AthenaMutationReceipt };
