const { DataAccessCenter } = require("../dataAccess");
const {
  maybeEnqueueTitleGenerationAfterChat,
} = require("./threadTitleGeneration");
const { publishWorkspaceSyncEvent } = require("./workspaceSyncEvents");

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
  const { chat } = await DataAccessCenter.workspaceChat.new({
    workspaceId: scope.workspaceId,
    user: { id: scope.userId },
    threadId: scope.threadId,
    include: false,
    prompt: String(input.prompt || ""),
    response: {},
    clientTurnId: scope.clientTurnId,
    sourceChannel: "agent",
  });
  if (!chat) {
    const error = new Error("agent_turn_reservation_failed");
    error.code = "agent_turn_reservation_failed";
    error.httpStatus = 503;
    throw error;
  }
  return { id: chat.id, publicId: chat.public_id || null };
}

async function finalizeAgentTurn(input = {}) {
  const scope = normalizedInput(input);
  const chatId = positiveId(input.chatId, "chat_id");
  const workspace = await DataAccessCenter.workspace.get({
    id: scope.workspaceId,
  });
  if (!workspace) {
    const error = new Error("agent_turn_workspace_not_found");
    error.code = "agent_turn_workspace_not_found";
    error.httpStatus = 404;
    throw error;
  }

  const { chat: updated, message } =
    await DataAccessCenter.workspaceChat.upsert(chatId, {
      workspaceId: scope.workspaceId,
      prompt: String(input.prompt || ""),
      response: input.response || {},
      user: { id: scope.userId },
      threadId: scope.threadId,
      include: true,
      clientTurnId: scope.clientTurnId,
      sourceChannel: "agent",
    });
  if (!updated) {
    const error = new Error(message || "agent_turn_finalization_failed");
    error.code = "agent_turn_finalization_failed";
    error.httpStatus = 503;
    throw error;
  }

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
    clientTurnId: scope.clientTurnId,
  });

  let renamedThread = null;
  if (scope.threadId && input.renameThread !== false) {
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
  finalizeAgentTurn,
  registerAgentTurnPersistenceRoutes,
  reserveAgentTurn,
};
