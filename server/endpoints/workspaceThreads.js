const {
  multiUserMode,
  userFromSession,
  reqBody,
  safeJsonParse,
  queryParams,
} = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { Telemetry } = require("../models/telemetry");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { EventLogs } = require("../models/eventLogs");
const { WorkspaceThread } = require("../models/workspaceThread");
const {
  validWorkspaceSlug,
  validWorkspaceAndThreadSlug,
} = require("../utils/middleware/validWorkspace");
const { WorkspaceChats } = require("../models/workspaceChats");
const { convertToChatHistory } = require("../utils/helpers/chat/responses");
const { getModelTag } = require("./utils");
const {
  compactThread,
  getThreadCompactionStatus,
} = require("../utils/chats/threadCompaction");

function normalizedChatIds(chatIds = []) {
  return [...new Set(chatIds.map((id) => Number(id)).filter((id) => id > 0))];
}

function parseHistoryQuery(request) {
  const query = queryParams(request);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const beforeChatId = Number(query.beforeChatId) || null;
  const priorityWindow = Math.min(
    Math.max(Number(query.priorityWindow) || 0, 0),
    limit
  );
  return {
    enabled:
      query.limit !== undefined ||
      query.beforeChatId !== undefined ||
      query.detail !== undefined ||
      query.priorityWindow !== undefined,
    limit,
    beforeChatId,
    detail: query.detail === "light" ? "light" : "full",
    priorityWindow,
  };
}

function compactionUserFromInput(sessionUser, userId = undefined) {
  if (userId === undefined) return sessionUser ? { id: sessionUser.id } : null;
  if (userId === null || userId === "" || userId === "null") return null;
  return { id: Number(userId) };
}

function lightChatIdsForHistory(history = [], options = {}) {
  if (!options.enabled || options.detail !== "light") return new Set();
  const fullStart = Math.max(history.length - options.priorityWindow, 0);
  return new Set(
    history
      .filter((record, index) => index < fullStart)
      .map((record) => record.id)
  );
}

async function historyPageMeta(baseClause = {}, history = [], options = {}) {
  const oldestId = history[0]?.id || null;
  const hasMore =
    !!oldestId &&
    (history.length >= options.limit
      ? (await WorkspaceChats.count({
          ...baseClause,
          id: { lt: oldestId },
        })) > 0
      : false);
  return {
    limit: options.limit,
    beforeChatId: options.beforeChatId,
    nextBeforeChatId: oldestId,
    totalReturned: history.length,
    hasMore,
  };
}

function workspaceThreadEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/thread/new",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const { thread, message } = await WorkspaceThread.new(
          workspace,
          user?.id
        );
        await Telemetry.sendTelemetry(
          "workspace_thread_created",
          {
            multiUserMode: multiUserMode(response),
            LLMSelection: process.env.LLM_PROVIDER || "openai",
            Embedder: process.env.EMBEDDING_ENGINE || "inherit",
            VectorDbSelection: process.env.VECTOR_DB || "lancedb",
            TTSSelection: process.env.TTS_PROVIDER || "native",
            LLMModel: getModelTag(),
          },
          user?.id
        );

        await EventLogs.logEvent(
          "workspace_thread_created",
          {
            workspaceName: workspace?.name || "Unknown Workspace",
          },
          user?.id
        );
        response.status(200).json({ thread, message });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/threads",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const threads = await WorkspaceThread.where({
          workspace_id: workspace.id,
          user_id: user?.id || null,
        });
        response.status(200).json({ threads });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/thread/:threadSlug",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (_, response) => {
      try {
        const thread = response.locals.thread;
        await WorkspaceThread.delete({ id: thread.id });
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/thread-bulk-delete",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const { slugs = [] } = reqBody(request);
        if (slugs.length === 0) return response.sendStatus(200).end();

        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        await WorkspaceThread.delete({
          slug: { in: slugs },
          user_id: user?.id ?? null,
          workspace_id: workspace.id,
        });
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/thread/:threadSlug/chats",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;
        const historyOptions = parseHistoryQuery(request);
        const baseClause = {
          workspaceId: workspace.id,
          user_id: user?.id || null,
          thread_id: thread.id,
          api_session_id: null, // Do not include API session chats.
          include: true,
        };
        const whereClause = {
          ...baseClause,
          ...(historyOptions.beforeChatId
            ? { id: { lt: historyOptions.beforeChatId } }
            : {}),
        };
        const history = await WorkspaceChats.where(
          whereClause,
          historyOptions.enabled ? historyOptions.limit : null,
          historyOptions.enabled ? { id: "desc" } : { id: "asc" }
        );
        const orderedHistory = historyOptions.enabled
          ? [...history].reverse()
          : history;
        const lightChatIds = lightChatIdsForHistory(
          orderedHistory,
          historyOptions
        );
        const page = historyOptions.enabled
          ? await historyPageMeta(baseClause, orderedHistory, historyOptions)
          : null;

        response.status(200).json({
          history: convertToChatHistory(orderedHistory, { lightChatIds }),
          ...(page
            ? { page: { ...page, lightChatIds: [...lightChatIds] } }
            : {}),
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/chats/hydrate",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const { chatIds = [] } = reqBody(request);
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;

        if (!Array.isArray(chatIds)) {
          response.sendStatus(400).end();
          return;
        }

        const ids = normalizedChatIds(chatIds);
        if (ids.length === 0) {
          response.status(200).json({ history: [], hydratedChatIds: [] });
          return;
        }

        const history = await WorkspaceChats.where(
          {
            workspaceId: workspace.id,
            user_id: user?.id || null,
            thread_id: thread.id,
            api_session_id: null,
            include: true,
            id: { in: ids },
          },
          null,
          { id: "asc" }
        );

        response.status(200).json({
          history: convertToChatHistory(history),
          hydratedChatIds: history.map((chat) => chat.id),
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/update",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const data = reqBody(request);
        const currentThread = response.locals.thread;
        const { thread, message } = await WorkspaceThread.update(
          currentThread,
          data
        );
        response.status(200).json({ thread, message });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/compact",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const {
          userId = undefined,
          apiSessionId = null,
          force = false,
          mode = "target",
          targetRatio = undefined,
          compactInstructions = "",
        } = reqBody(request);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;
        const user = compactionUserFromInput(sessionUser, userId);

        const result = await compactThread({
          workspace,
          user,
          thread,
          apiSessionId,
          force: Boolean(force),
          reason: "manual",
          mode,
          targetRatio,
          compactInstructions,
        });

        response.status(200).json({
          success: !!result.success,
          compactionId: result.compactionId || null,
          coveredMessageCount: result.coveredMessageCount || 0,
          tokenBefore: result.tokenBefore || 0,
          tokenAfter: result.tokenAfter || 0,
          mode: result.mode,
          provider: result.provider,
          model: result.model,
          compactionInputLimit: result.compactionInputLimit,
          chatInjectionLimit: result.chatInjectionLimit,
          targetBase: result.targetBase,
          targetReached: result.targetReached,
          targetRatio: result.targetRatio,
          targetTokens: result.targetTokens,
          estimatedSummaryBudget: result.estimatedSummaryBudget,
          recentRawBudget: result.recentRawBudget,
          usedTokensAfterCompact: result.usedTokensAfterCompact,
          ratioAfterCompact: result.ratioAfterCompact,
          retainedRecentMessageCount: result.retainedRecentMessageCount,
          targetCompactableMessageCount: result.targetCompactableMessageCount,
          cannotReachTargetReason: result.cannotReachTargetReason,
          rollingCompactionUsed: result.rollingCompactionUsed,
          ...(result.error ? { error: result.error } : {}),
          ...(result.skipped ? { skipped: result.skipped } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/thread/:threadSlug/compact/status",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const query = queryParams(request);
        const userId = Object.prototype.hasOwnProperty.call(query, "userId")
          ? query.userId
          : undefined;
        const apiSessionId = Object.prototype.hasOwnProperty.call(
          query,
          "apiSessionId"
        )
          ? query.apiSessionId || null
          : null;
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;
        const user = compactionUserFromInput(sessionUser, userId);
        const status = await getThreadCompactionStatus({
          workspace,
          user,
          thread,
          apiSessionId,
        });

        response.status(200).json({
          success: true,
          status,
        });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).json({
          success: false,
          error: e.message,
        });
      }
    }
  );

  app.delete(
    "/workspace/:slug/thread/:threadSlug/delete-edited-chats",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const { startingId } = reqBody(request);
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;

        await WorkspaceChats.delete({
          workspaceId: Number(workspace.id),
          thread_id: Number(thread.id),
          user_id: user?.id,
          id: { gte: Number(startingId) },
        });

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/update-chat",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const { chatId, newText = null, role = "assistant" } = reqBody(request);
        if (!newText || !String(newText).trim())
          throw new Error("Cannot save empty edit");

        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;
        const existingChat = await WorkspaceChats.get({
          workspaceId: workspace.id,
          thread_id: thread.id,
          user_id: user?.id,
          id: Number(chatId),
        });
        if (!existingChat) throw new Error("Invalid chat.");

        if (role === "user") {
          await WorkspaceChats._update(existingChat.id, {
            prompt: String(newText),
          });
        } else {
          const chatResponse = safeJsonParse(existingChat.response, null);
          if (!chatResponse) throw new Error("Failed to parse chat response");
          await WorkspaceChats._update(existingChat.id, {
            response: JSON.stringify({
              ...chatResponse,
              text: String(newText),
            }),
          });
        }

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { workspaceThreadEndpoints };
