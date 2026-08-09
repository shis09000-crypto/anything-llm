const { DataAccessCenter } = require("../dataAccess");
const {
  maybeEnqueueTitleGenerationAfterChat,
} = require("./threadTitleGeneration");
const { publishWorkspaceSyncEvent } = require("./workspaceSyncEvents");
const crypto = require("crypto");
const {
  finalizedTurnPersister,
  hotTurnBuffer,
  scopeKey,
} = require("./hotTurnBuffer");

const AGENT_RESERVATION_TTL_MS = 10 * 60 * 1000;
const agentReservations = new Map();

function positiveId(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === ""))
    return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error(`agent_turn_${label}_invalid`);
    error.code = `agent_turn_${label}_invalid`;
    error.httpStatus = 400;
    throw error;
  }
  return id;
}

function normalizedInput(input = {}) {
  return {
    workspaceId: positiveId(input.workspaceId, "workspace_id"),
    threadId: positiveId(input.threadId, "thread_id", { nullable: true }),
    userId: positiveId(input.userId, "user_id", { nullable: true }),
    clientTurnId: String(input.clientTurnId || "").trim() || null,
  };
}

async function reserveAgentTurn(input = {}) {
  const scope = normalizedInput(input);
  const reservationId = `ath_agent_turn_${crypto.randomUUID()}`;
  const reservation = {
    ...scope,
    id: reservationId,
    prompt: String(input.prompt || ""),
    createdAt: Date.now(),
  };
  agentReservations.set(reservationId, reservation);
  const timer = setTimeout(
    () => agentReservations.delete(reservationId),
    AGENT_RESERVATION_TTL_MS
  );
  timer.unref?.();
  return { id: reservationId, reservationId, publicId: null };
}

async function finalizeAgentTurn(input = {}) {
  const scope = normalizedInput(input);
  const reservationId = String(
    input.reservationId || input.chatId || ""
  ).trim();
  const reservation = agentReservations.get(reservationId) || null;
  const legacyChatId = reservation ? null : positiveId(input.chatId, "chat_id");
  if (
    reservation &&
    (reservation.workspaceId !== scope.workspaceId ||
      reservation.threadId !== scope.threadId ||
      reservation.userId !== scope.userId)
  ) {
    const error = new Error("agent_turn_reservation_scope_conflict");
    error.code = "agent_turn_reservation_scope_conflict";
    error.httpStatus = 409;
    throw error;
  }
  const workspace = await DataAccessCenter.workspace.get({
    id: scope.workspaceId,
  });
  if (!workspace) {
    const error = new Error("agent_turn_workspace_not_found");
    error.code = "agent_turn_workspace_not_found";
    error.httpStatus = 404;
    throw error;
  }

  const clientTurnId = scope.clientTurnId || reservation?.clientTurnId || null;
  const prompt = String(input.prompt || reservation?.prompt || "");
  const responsePayload = input.response || {};
  const hotStage = hotTurnBuffer.stage({
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    userId: scope.userId,
    clientTurnId: clientTurnId || reservationId,
    prompt,
    response: String(responsePayload?.text || ""),
    metadata: { sourceChannel: "agent" },
  });
  const persist = async () => {
    let lastError = null;
    for (const delayMs of [0, 250, 1_000, 4_000]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        return legacyChatId
          ? await DataAccessCenter.workspaceChat.upsert(legacyChatId, {
              workspaceId: scope.workspaceId,
              prompt,
              response: responsePayload,
              user: { id: scope.userId },
              threadId: scope.threadId,
              include: true,
              clientTurnId,
              sourceChannel: "agent",
            })
          : await DataAccessCenter.workspaceChat.new({
              workspaceId: scope.workspaceId,
              prompt,
              response: responsePayload,
              user: { id: scope.userId },
              threadId: scope.threadId,
              include: true,
              clientTurnId,
              sourceChannel: "agent",
            });
      } catch (error) {
        lastError = error;
        hotTurnBuffer.updateStatus(clientTurnId || reservationId, "retrying");
      }
    }
    throw lastError || new Error("agent_turn_finalization_failed");
  };
  const { chat: updated, message } = await finalizedTurnPersister.enqueue(
    scopeKey(scope),
    persist
  );
  if (!updated) {
    const error = new Error(message || "agent_turn_finalization_failed");
    error.code = "agent_turn_finalization_failed";
    error.httpStatus = 503;
    throw error;
  }
  const chatId = updated.id;
  agentReservations.delete(reservationId);
  if (hotStage.accepted) hotTurnBuffer.delete(clientTurnId || reservationId);

  const thread = scope.threadId
    ? await DataAccessCenter.workspaceThread.get({
        id: scope.threadId,
        workspace_id: scope.workspaceId,
        user_id: scope.userId,
      })
    : null;
  publishWorkspaceSyncEvent({
    type: "chat_finalized",
    workspaceId: scope.workspaceId,
    workspaceSlug: workspace.slug,
    userId: scope.userId,
    threadId: scope.threadId,
    threadSlug: thread?.slug || null,
    chatId,
    publicChatId: updated.public_id || input.publicChatId || null,
    clientTurnId,
  });

  let renamedThread = null;
  if (scope.threadId) {
    // Chat Runtime owns the authoritative message count and the title lease.
    // An Agent Runtime process-local hint must never suppress the first/5th
    // message trigger after a reconnect, thread switch, or process recovery.
    renamedThread = await maybeEnqueueTitleGenerationAfterChat({
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      userId: scope.userId,
      include: true,
      apiSessionId: null,
    });
  }
  return {
    id: chatId,
    publicId: updated.public_id || input.publicChatId || null,
    renamedThread: renamedThread || null,
  };
}

function registerAgentTurnPersistenceRoutes(app) {
  app.post(
    "/internal/v1/chat/agent-turns/reserve",
    async (request, response) => {
      try {
        const chat = await reserveAgentTurn(request.body || {});
        response.status(200).json({ success: true, chat });
      } catch (error) {
        response.status(error.httpStatus || 500).json({
          success: false,
          error: error.code || "agent_turn_reservation_failed",
        });
      }
    }
  );
  app.post(
    "/internal/v1/chat/agent-turns/finalize",
    async (request, response) => {
      try {
        const chat = await finalizeAgentTurn(request.body || {});
        response.status(200).json({ success: true, chat });
      } catch (error) {
        response.status(error.httpStatus || 500).json({
          success: false,
          error: error.code || "agent_turn_finalization_failed",
        });
      }
    }
  );
}

module.exports = {
  AGENT_RESERVATION_TTL_MS,
  agentReservations,
  finalizeAgentTurn,
  registerAgentTurnPersistenceRoutes,
  reserveAgentTurn,
};
