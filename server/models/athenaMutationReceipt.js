const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

function compact(value, max = 160) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    resource: safeJsonParse(row.resourceJson, {}),
  };
}

const AthenaMutationReceipt = {
  async reserve({ userId, sourceActionId, action, workspaceId, threadId }) {
    const owner = numberOrNull(userId);
    const actionId = compact(sourceActionId);
    if (!owner || !actionId) return { receipt: null, created: true };
    const existing = await prisma.athena_mutation_receipts.findUnique({
      where: {
        userId_sourceActionId: { userId: owner, sourceActionId: actionId },
      },
    });
    if (existing) return { receipt: hydrate(existing), created: false };

    try {
      const receipt = await prisma.athena_mutation_receipts.create({
        data: {
          userId: owner,
          sourceActionId: actionId,
          action: compact(action, 80) || "unknown",
          workspaceId: numberOrNull(workspaceId),
          threadId: numberOrNull(threadId),
        },
      });
      return { receipt: hydrate(receipt), created: true };
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      const receipt = await prisma.athena_mutation_receipts.findUnique({
        where: {
          userId_sourceActionId: { userId: owner, sourceActionId: actionId },
        },
      });
      return { receipt: hydrate(receipt), created: false };
    }
  },

  async complete({ userId, sourceActionId, resource = {} }) {
    const owner = numberOrNull(userId);
    const actionId = compact(sourceActionId);
    if (!owner || !actionId) return null;
    return hydrate(
      await prisma.athena_mutation_receipts.update({
        where: {
          userId_sourceActionId: { userId: owner, sourceActionId: actionId },
        },
        data: {
          status: "completed",
          resourceJson: JSON.stringify(resource || {}),
          errorCode: null,
          updatedAt: new Date(),
        },
      })
    );
  },

  async fail({ userId, sourceActionId, errorCode = "mutation_failed" }) {
    const owner = numberOrNull(userId);
    const actionId = compact(sourceActionId);
    if (!owner || !actionId) return null;
    return hydrate(
      await prisma.athena_mutation_receipts.update({
        where: {
          userId_sourceActionId: { userId: owner, sourceActionId: actionId },
        },
        data: {
          status: "failed",
          errorCode: compact(errorCode, 120),
          updatedAt: new Date(),
        },
      })
    );
  },
};

module.exports = { AthenaMutationReceipt };
