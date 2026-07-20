const { WorkspaceChats } = require("../models/workspaceChats");
const { createModelRepository } = require("./createModelRepository");
const prisma = require("../utils/prisma");
const { newPublicChatId } = require("../utils/chats/chatIdentifiers");
const {
  rebuildChatCryptoChainFromChatId,
} = require("../utils/security/chatHistoryEncryption");
const { SyncV2 } = require("../models/syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");

const WorkspaceChatRepository = createModelRepository(WorkspaceChats, {
  domain: "workspace-chat",
  repositoryName: "WorkspaceChatRepository",
});

WorkspaceChatRepository.publicIdColumnExists = async function () {
  const columns = await prisma.$queryRawUnsafe(
    `PRAGMA table_info("workspace_chats")`
  );
  return columns.some((column) => column.name === "public_id");
};

WorkspaceChatRepository.backfillMissingPublicIds = async function ({
  dryRun = false,
} = {}) {
  if (!(await this.publicIdColumnExists())) {
    throw new Error(
      "workspace_chats.public_id does not exist. Run Prisma migrations first."
    );
  }

  const missingRows = await prisma.$queryRawUnsafe(`
    SELECT id
    FROM "workspace_chats"
    WHERE "public_id" IS NULL OR TRIM("public_id") = ''
    ORDER BY id ASC
  `);

  let updated = 0;
  for (const row of missingRows) {
    const publicId = newPublicChatId();
    if (!dryRun) {
      await prisma.$executeRawUnsafe(
        `UPDATE "workspace_chats" SET "public_id" = ? WHERE id = ?`,
        publicId,
        row.id
      );
    }
    updated += 1;
  }

  return {
    success: true,
    dryRun,
    missing: missingRows.length,
    updated,
  };
};

function normalizedMutationScope({
  workspaceId,
  threadId = null,
  userId = null,
  sourceActionId = null,
} = {}) {
  const normalizedWorkspaceId = Number(workspaceId);
  const normalizedThreadId = threadId === null ? null : Number(threadId);
  const normalizedUserId = userId === null ? null : Number(userId);
  const normalizedActionId = String(sourceActionId || "")
    .trim()
    .slice(0, 160);

  if (!Number.isInteger(normalizedWorkspaceId) || normalizedWorkspaceId <= 0) {
    const error = new Error("Invalid workspace for chat mutation.");
    error.code = "chat_mutation_invalid_workspace";
    throw error;
  }
  if (!normalizedActionId) {
    const error = new Error("Missing source action for chat mutation.");
    error.code = "chat_mutation_missing_source_action";
    throw error;
  }
  if (
    normalizedThreadId !== null &&
    (!Number.isInteger(normalizedThreadId) || normalizedThreadId <= 0)
  ) {
    const error = new Error("Invalid thread for chat mutation.");
    error.code = "chat_mutation_invalid_thread";
    throw error;
  }
  return {
    workspaceId: normalizedWorkspaceId,
    threadId: normalizedThreadId,
    userId: normalizedUserId,
    sourceActionId: normalizedActionId,
    where: {
      workspaceId: normalizedWorkspaceId,
      thread_id: normalizedThreadId,
      user_id: normalizedUserId,
      api_session_id: null,
    },
    crypto: {
      workspaceId: normalizedWorkspaceId,
      threadId: normalizedThreadId,
      userId: normalizedUserId,
      apiSessionId: null,
    },
    compaction: {
      workspace_id: normalizedWorkspaceId,
      thread_id: normalizedThreadId,
      user_id: normalizedUserId,
      api_session_id: null,
    },
  };
}

function positiveChatId(value, code) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error("Invalid chat for chat mutation.");
    error.code = code;
    throw error;
  }
  return parsed;
}

function receiptMatches(receipt, { action, scope, resource = {} }) {
  if (!receipt) return true;
  let receiptResource = {};
  try {
    receiptResource = JSON.parse(receipt.resourceJson || "{}") || {};
  } catch {}
  const resourceMatches = Object.entries(resource || {}).every(
    ([key, value]) =>
      receiptResource[key] === undefined ||
      String(receiptResource[key]) === String(value)
  );
  return (
    receipt.action === action &&
    Number(receipt.workspaceId) === scope.workspaceId &&
    (receipt.threadId === null ? null : Number(receipt.threadId)) ===
      scope.threadId &&
    resourceMatches
  );
}

async function permanentChatMutation({
  scope,
  receiptAction,
  targetWhere,
  deleteWhere,
  validateTarget,
  resource,
} = {}) {
  const syncReady =
    scope.threadId && SyncV2.enabled("chat") && (await SyncV2.schemaReady());
  return await prisma.$transaction(async (transaction) => {
    let receipt = null;
    if (scope.userId) {
      receipt = await transaction.athena_mutation_receipts.findUnique({
        where: {
          userId_sourceActionId: {
            userId: scope.userId,
            sourceActionId: scope.sourceActionId,
          },
        },
      });
      if (
        !receiptMatches(receipt, { action: receiptAction, scope, resource })
      ) {
        const error = new Error(
          "The source action is already bound to another mutation."
        );
        error.code = "chat_mutation_source_action_conflict";
        throw error;
      }
      if (receipt?.status === "completed") {
        let completedResource = {};
        try {
          completedResource = JSON.parse(receipt.resourceJson || "{}") || {};
        } catch {}
        return {
          success: true,
          replayed: true,
          deletedCount: Number(completedResource.deletedCount || 0),
          deletedChatIds: Array.isArray(completedResource.deletedChatIds)
            ? completedResource.deletedChatIds
            : [],
          ...completedResource,
          ...(resource || {}),
        };
      }
      if (receipt?.status === "failed") {
        const error = new Error(
          receipt.errorCode || "Chat mutation previously failed."
        );
        error.code = receipt.errorCode || "chat_mutation_failed";
        throw error;
      }
    }

    const target = await transaction.workspace_chats.findFirst({
      where: { ...scope.where, ...targetWhere },
    });
    if (!target) {
      const error = new Error("The target chat no longer exists.");
      error.code = "chat_mutation_target_not_found";
      throw error;
    }
    if (validateTarget) {
      await validateTarget({ transaction, target, scope });
    }

    if (scope.userId && !receipt) {
      await transaction.athena_mutation_receipts.create({
        data: {
          userId: scope.userId,
          sourceActionId: scope.sourceActionId,
          action: receiptAction,
          workspaceId: scope.workspaceId,
          threadId: scope.threadId,
          resourceJson: JSON.stringify(resource || {}),
        },
      });
    }

    const rows = await transaction.workspace_chats.findMany({
      where: { ...scope.where, ...deleteWhere },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const deletedChatIds = rows.map((row) => Number(row.id));
    const deleted = await transaction.workspace_chats.deleteMany({
      where: { ...scope.where, ...deleteWhere },
    });
    await transaction.workspace_chat_compactions.deleteMany({
      where: scope.compaction,
    });
    if (deletedChatIds.length) {
      await rebuildChatCryptoChainFromChatId(scope.crypto, deletedChatIds[0], {
        client: transaction,
      });
    }

    let sync = null;
    if (syncReady) {
      const thread = await transaction.workspace_threads.update({
        where: { id: scope.threadId },
        data: { historyRevision: { increment: 1 } },
      });
      const latest = await transaction.workspace_chats.findFirst({
        where: scope.where,
        select: { id: true, public_id: true, lastUpdatedAt: true },
        orderBy: { id: "desc" },
      });
      const audience = thread.user_id
        ? [Number(thread.user_id)]
        : (
            await transaction.workspace_users.findMany({
              where: { workspace_id: scope.workspaceId },
              select: { user_id: true },
            })
          ).map((row) => Number(row.user_id));
      sync = await SyncV2.recordNodeChange(transaction, {
        nodeKey: nodeKeys.threadMessages(scope.threadId),
        content: {
          threadId: scope.threadId,
          historyRevision: thread.historyRevision,
          latestChatId: latest?.id || null,
          latestPublicChatId: latest?.public_id || null,
          latestChatAt: latest?.lastUpdatedAt || null,
        },
        eventType: "message.deleted",
        changedPaths: deletedChatIds.map((id) => `messages.${id}`),
        payloadHint: {
          operation: "delete",
          deletedMessageIds: deletedChatIds,
          historyRevision: thread.historyRevision,
        },
        mutationId: scope.sourceActionId,
        audience,
      });
    }

    const completedResource = {
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      deletedChatIds,
      deletedCount: deleted.count,
      ...(resource || {}),
    };
    if (scope.userId) {
      await transaction.athena_mutation_receipts.update({
        where: {
          userId_sourceActionId: {
            userId: scope.userId,
            sourceActionId: scope.sourceActionId,
          },
        },
        data: {
          status: "completed",
          resourceJson: JSON.stringify(completedResource),
          errorCode: null,
          ...(sync
            ? {
                resultVersion: sync.node.stateVersion,
                resultJson: JSON.stringify({
                  descriptor: sync.node,
                  deletedChatIds,
                }),
              }
            : {}),
          updatedAt: new Date(),
        },
      });
    }

    return {
      success: true,
      replayed: false,
      deletedCount: deleted.count,
      deletedChatIds,
      ...completedResource,
    };
  });
}

WorkspaceChatRepository.truncateForNativeEdit = async function ({
  workspaceId,
  threadId = null,
  userId = null,
  startingChatId,
  sourceActionId = null,
} = {}) {
  const scope = normalizedMutationScope({
    workspaceId,
    threadId,
    userId,
    sourceActionId,
  });
  const normalizedStartingChatId = positiveChatId(
    startingChatId,
    "edit_invalid_starting_chat"
  );

  return permanentChatMutation({
    scope,
    receiptAction: "chat.edit.truncate-and-resend",
    targetWhere: { id: normalizedStartingChatId, include: true },
    deleteWhere: { id: { gte: normalizedStartingChatId } },
    resource: { startingChatId: normalizedStartingChatId },
  });
};

WorkspaceChatRepository.regenerateLastTurn = async function ({
  workspaceId,
  threadId = null,
  userId = null,
  targetChatId,
  sourceActionId = null,
} = {}) {
  const scope = normalizedMutationScope({
    workspaceId,
    threadId,
    userId,
    sourceActionId,
  });
  const normalizedTargetChatId = positiveChatId(
    targetChatId,
    "regenerate_invalid_target_chat"
  );

  return permanentChatMutation({
    scope,
    receiptAction: "chat.regenerate.replace",
    targetWhere: { id: normalizedTargetChatId, include: true },
    deleteWhere: { id: normalizedTargetChatId },
    validateTarget: async ({ transaction }) => {
      const newer = await transaction.workspace_chats.findFirst({
        where: {
          ...scope.where,
          include: true,
          id: { gt: normalizedTargetChatId },
        },
        select: { id: true },
      });
      if (newer) {
        const error = new Error(
          "Only the latest confirmed chat can be regenerated."
        );
        error.code = "regenerate_target_not_latest";
        throw error;
      }
    },
    resource: { targetChatId: normalizedTargetChatId },
  });
};

WorkspaceChatRepository.deleteTurnPermanently = async function ({
  workspaceId,
  threadId = null,
  userId = null,
  chatId = null,
  publicChatId = null,
  sourceActionId = null,
} = {}) {
  const scope = normalizedMutationScope({
    workspaceId,
    threadId,
    userId,
    sourceActionId,
  });
  const normalizedPublicChatId = String(publicChatId || "").trim();
  const normalizedChatId = normalizedPublicChatId
    ? null
    : positiveChatId(chatId, "delete_invalid_target_chat");
  const identity = normalizedPublicChatId
    ? { public_id: normalizedPublicChatId }
    : { id: normalizedChatId };

  return permanentChatMutation({
    scope,
    receiptAction: "chat.delete.permanent",
    targetWhere: { ...identity, include: true },
    deleteWhere: identity,
    resource: {
      targetChatId: normalizedChatId,
      targetPublicChatId: normalizedPublicChatId || null,
    },
  });
};

module.exports = { WorkspaceChatRepository };
