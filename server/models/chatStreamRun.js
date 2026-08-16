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
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RECOVERY_GRACE_MS = 60_000;

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
    ownerId = null,
    leaseMs = DEFAULT_LEASE_MS,
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
            ownerId: ownerId ? String(ownerId) : null,
            heartbeatAt: ownerId ? new Date() : null,
            leaseExpiresAt: ownerId
              ? new Date(Date.now() + Math.max(5_000, Number(leaseMs) || 0))
              : null,
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

  getScopedById: async function ({
    id,
    workspaceId,
    threadId = null,
    userId = null,
  } = {}) {
    try {
      const row = await prisma.chat_stream_runs.findFirst({
        where: {
          id: String(id || "").trim(),
          ...scopeWhere({ workspaceId, threadId, userId }),
        },
      });
      return await hydrate(row);
    } catch (error) {
      throwModelDataAccessError("chatStreamRun.getScopedById", error);
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

  appendEvents: async function ({
    id,
    workspaceId,
    threadId = null,
    userId = null,
    events = [],
  } = {}) {
    const normalized = Array.isArray(events)
      ? events
          .filter(
            (event) =>
              Number.isSafeInteger(Number(event?.sequence)) &&
              Number(event.sequence) > 0 &&
              event?.payload &&
              typeof event.payload === "object"
          )
          .sort((left, right) => Number(left.sequence) - Number(right.sequence))
      : [];
    if (!normalized.length) return 0;
    try {
      const scope = normalizedScope({ workspaceId, threadId, userId });
      const prepared = [];
      for (const event of normalized) {
        const plaintext = JSON.stringify(event.payload);
        prepared.push({
          runId: String(id),
          sequence: Number(event.sequence),
          eventType: String(event.payload.type || "unknown").slice(0, 120),
          payloadJson: await encryptWorkspaceChatFieldAsync(plaintext, scope),
          payloadHash: crypto
            .createHash("sha256")
            .update(plaintext)
            .digest("hex"),
        });
      }
      return await prisma.$transaction(async (tx) => {
        const run = await tx.chat_stream_runs.findFirst({
          where: {
            id: String(id),
            ...scopeWhere({ workspaceId, threadId, userId }),
          },
          select: { id: true },
        });
        if (!run) throw new Error("chat_stream_run_scope_conflict");
        const existing = new Set(
          (
            await tx.chat_run_events.findMany({
              where: {
                runId: String(id),
                sequence: { in: prepared.map((event) => event.sequence) },
              },
              select: { sequence: true },
            })
          ).map((event) => Number(event.sequence))
        );
        let inserted = 0;
        for (const event of prepared) {
          if (existing.has(event.sequence)) continue;
          await tx.chat_run_events.create({ data: event });
          inserted += 1;
        }
        return inserted;
      });
    } catch (error) {
      throwModelDataAccessError("chatStreamRun.appendEvents", error);
    }
  },

  eventsAfter: async function ({
    id,
    workspaceId,
    threadId = null,
    userId = null,
    afterSequence = 0,
    limit = 200,
  } = {}) {
    try {
      const run = await prisma.chat_stream_runs.findFirst({
        where: {
          id: String(id),
          ...scopeWhere({ workspaceId, threadId, userId }),
        },
        select: { id: true },
      });
      if (!run) return [];
      const rows = await prisma.chat_run_events.findMany({
        where: {
          runId: String(id),
          sequence: { gt: Math.max(0, Number(afterSequence) || 0) },
        },
        orderBy: { sequence: "asc" },
        take: Math.max(1, Math.min(Number(limit) || 200, 500)),
      });
      const events = [];
      for (const row of rows) {
        const plaintext = await decryptChatFieldCompat(row.payloadJson);
        if (
          crypto.createHash("sha256").update(plaintext).digest("hex") !==
          row.payloadHash
        )
          throw new Error("chat_run_event_hash_mismatch");
        events.push({
          sequence: row.sequence,
          payload: JSON.parse(plaintext),
          createdAt: row.createdAt,
        });
      }
      return events;
    } catch (error) {
      throwModelDataAccessError("chatStreamRun.eventsAfter", error);
    }
  },

  renewLease: async function ({
    id,
    workspaceId,
    threadId = null,
    userId = null,
    ownerId,
    leaseMs = DEFAULT_LEASE_MS,
  } = {}) {
    if (!ownerId) return false;
    try {
      const now = new Date();
      const result = await prisma.chat_stream_runs.updateMany({
        where: {
          id: String(id),
          ...scopeWhere({ workspaceId, threadId, userId }),
          status: "running",
          ownerId: String(ownerId),
        },
        data: {
          heartbeatAt: now,
          leaseExpiresAt: new Date(
            now.getTime() + Math.max(5_000, Number(leaseMs) || 0)
          ),
        },
      });
      return result.count > 0;
    } catch (error) {
      throwModelDataAccessError("chatStreamRun.renewLease", error);
    }
  },

  reconcileExpired: async function ({
    clientTurnId,
    workspaceId,
    threadId = null,
    userId = null,
    recoveryGraceMs = DEFAULT_RECOVERY_GRACE_MS,
  } = {}) {
    try {
      const scope = scopeWhere({ workspaceId, threadId, userId });
      const run = await prisma.chat_stream_runs.findFirst({
        where: { clientTurnId: String(clientTurnId || "").trim(), ...scope },
      });
      if (!run || run.status !== "running") return await hydrate(run);
      const leaseExpiry = run.leaseExpiresAt
        ? Date.parse(run.leaseExpiresAt)
        : Number.NaN;
      if (Number.isFinite(leaseExpiry) && leaseExpiry > Date.now())
        return await hydrate(run);

      const finalChat = await prisma.workspace_chats.findFirst({
        where: {
          clientTurnId: run.clientTurnId,
          workspaceId: Number(workspaceId),
          user_id: userId === null ? null : Number(userId),
          thread_id: threadId === null ? null : Number(threadId),
        },
        select: { id: true, public_id: true },
      });
      if (finalChat) {
        return await hydrate(
          await prisma.chat_stream_runs.update({
            where: { id: run.id },
            data: {
              status: "completed",
              finalChatId: finalChat.id,
              finalPublicChatId: finalChat.public_id,
              ownerId: null,
              leaseExpiresAt: null,
              completedAt: new Date(),
            },
          })
        );
      }

      const graceDeadline =
        (Number.isFinite(leaseExpiry)
          ? leaseExpiry
          : Date.parse(run.lastUpdatedAt)) +
        Math.max(10_000, Number(recoveryGraceMs) || 0);
      if (Date.now() < graceDeadline) return await hydrate(run);
      return await hydrate(
        await prisma.chat_stream_runs.update({
          where: { id: run.id },
          data: {
            status: "interrupted",
            errorCode: "chat_stream_owner_lease_expired",
            ownerId: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          },
        })
      );
    } catch (error) {
      throwModelDataAccessError("chatStreamRun.reconcileExpired", error);
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
          ownerId: null,
          leaseExpiresAt: null,
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

module.exports = {
  ChatStreamRun,
  DEFAULT_LEASE_MS,
  DEFAULT_RECOVERY_GRACE_MS,
};
