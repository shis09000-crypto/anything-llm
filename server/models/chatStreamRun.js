const crypto = require("crypto");
const prisma = require("../utils/prisma");
const {
  encryptWorkspaceChatFieldAsync,
} = require("../utils/security/chatHistoryEncryption");
const {
  decryptChatFieldCompat,
} = require("../utils/security/chatHistorySerialEncryption");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");

const TERMINAL_STATUSES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function normalizedScope({ workspaceId, threadId = null, userId = null } = {}) {
  return {
    workspaceId: Number(workspaceId),
    threadId: threadId === null ? null : Number(threadId),
    userId: userId === null ? null : Number(userId),
    apiSessionId: null,
  };
}

function scopeWhere({ workspaceId, threadId = null, userId = null } = {}) {
  return {
    workspaceId: Number(workspaceId),
    threadId: threadId === null ? null : Number(threadId),
    userId: userId === null ? null : Number(userId),
  };
}

function matchesScope(row, { workspaceId, threadId = null, userId = null }) {
  return (
    Number(row.workspaceId) === Number(workspaceId) &&
    (row.threadId === null ? null : Number(row.threadId)) ===
      (threadId === null ? null : Number(threadId)) &&
    (row.userId === null ? null : Number(row.userId)) ===
      (userId === null ? null : Number(userId))
  );
}

async function hydrate(row = null) {
  if (!row) return null;
  return {
    ...row,
    partialResponse: row.partialResponse
      ? await decryptChatFieldCompat(row.partialResponse)
      : "",
  };
}

const ChatStreamRun = {
  terminalStatuses: TERMINAL_STATUSES,

  claim: async function ({
    clientTurnId,
    workspaceId,
    threadId = null,
    userId = null,
  } = {}) {
    const normalizedClientTurnId = String(clientTurnId || "").trim();
    if (!normalizedClientTurnId) {
      const error = new Error("chat_stream_client_turn_required");
      error.code = "chat_stream_client_turn_required";
      throw error;
    }
    try {
      const claimed = await prisma.$transaction(async (tx) => {
        const existing = await tx.chat_stream_runs.findUnique({
          where: { clientTurnId: normalizedClientTurnId },
        });
        if (existing) {
          if (!matchesScope(existing, { workspaceId, threadId, userId })) {
            const error = new Error("chat_stream_run_scope_conflict");
            error.code = "chat_stream_run_scope_conflict";
            throw error;
          }
          return { run: existing, created: false };
        }

        const run = await tx.chat_stream_runs.create({
          data: {
            id: crypto.randomUUID(),
            clientTurnId: normalizedClientTurnId,
            workspaceId: Number(workspaceId),
            threadId: threadId === null ? null : Number(threadId),
            userId: userId === null ? null : Number(userId),
            status: "running",
            revision: 0,
            partialResponse: "",
          },
        });
        return { run, created: true };
      });
      return { ...claimed, run: await hydrate(claimed.run) };
    } catch (error) {
      if (error?.code === "P2002") {
        const existing = await prisma.chat_stream_runs.findUnique({
          where: { clientTurnId: normalizedClientTurnId },
        });
        if (
          existing &&
          matchesScope(existing, { workspaceId, threadId, userId })
        ) {
          return { run: await hydrate(existing), created: false };
        }
      }
      throwModelDataAccessError("chatStreamRun.claim", error);
    }
  },

  getScoped: async function ({
    clientTurnId,
    workspaceId,
    threadId = null,
    userId = null,
  } = {}) {
    try {
      const row = await prisma.chat_stream_runs.findFirst({
        where: {
          clientTurnId: String(clientTurnId || "").trim(),
          ...scopeWhere({ workspaceId, threadId, userId }),
        },
      });
      return await hydrate(row);
    } catch (error) {
      throwModelDataAccessError("chatStreamRun.getScoped", error);
    }
  },

  checkpoint: async function ({
    id,
    workspaceId,
    threadId = null,
    userId = null,
    revision = 0,
    partialResponse = "",
  } = {}) {
    try {
      const scope = normalizedScope({ workspaceId, threadId, userId });
      const encrypted = await encryptWorkspaceChatFieldAsync(
        partialResponse,
        scope
      );
      const result = await prisma.chat_stream_runs.updateMany({
        where: {
          id: String(id),
          ...scopeWhere({ workspaceId, threadId, userId }),
          status: "running",
          revision: { lt: Number(revision) },
        },
        data: {
          revision: Number(revision),
          partialResponse: encrypted,
          lastUpdatedAt: new Date(),
        },
      });
      return result.count > 0;
    } catch (error) {
      throwModelDataAccessError("chatStreamRun.checkpoint", error);
    }
  },

  settle: async function ({
    id,
    workspaceId,
    threadId = null,
    userId = null,
    status,
    revision = 0,
    partialResponse = "",
    finalChatId = null,
    finalPublicChatId = null,
    errorCode = null,
  } = {}) {
    if (!TERMINAL_STATUSES.includes(status)) {
      const error = new Error("chat_stream_invalid_terminal_status");
      error.code = "chat_stream_invalid_terminal_status";
      throw error;
    }
    try {
      const scope = normalizedScope({ workspaceId, threadId, userId });
      const encrypted = await encryptWorkspaceChatFieldAsync(
        partialResponse,
        scope
      );
      const result = await prisma.chat_stream_runs.updateMany({
        where: {
          id: String(id),
          ...scopeWhere({ workspaceId, threadId, userId }),
        },
        data: {
          status,
          revision: Number(revision),
          partialResponse: encrypted,
          finalChatId:
            finalChatId === null || finalChatId === undefined
              ? null
              : Number(finalChatId),
          finalPublicChatId: finalPublicChatId || null,
          errorCode: errorCode ? String(errorCode).slice(0, 160) : null,
          completedAt: new Date(),
          lastUpdatedAt: new Date(),
        },
      });
      return result.count > 0;
    } catch (error) {
      throwModelDataAccessError("chatStreamRun.settle", error);
    }
  },
};

module.exports = { ChatStreamRun };
