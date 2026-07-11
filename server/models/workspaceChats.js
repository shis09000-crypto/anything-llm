const prisma = require("../utils/prisma");
const { safeJSONStringify } = require("../utils/helpers/chat/responses");
const {
  hasDeepSeekCacheDiagnostics,
  withDeepSeekCacheDiagnosis,
} = require("../utils/AiProviders/deepseek/promptCache");
const { newPublicChatId } = require("../utils/chats/chatIdentifiers");
const {
  decryptWorkspaceChatRecordAsync,
  decryptWorkspaceChatRecordsAsync,
  encryptWorkspaceChatFieldAsync,
  rebuildChatCryptoChainForScope,
  scopeFromChat,
} = require("../utils/security/chatHistoryEncryption");

function safeParseResponse(response = null) {
  if (!response) return {};
  if (typeof response === "object") return response;
  try {
    return JSON.parse(response);
  } catch {
    return {};
  }
}

function deepSeekMetricsFromChat(chat = null) {
  const metrics = safeParseResponse(chat?.response)?.metrics || null;
  return hasDeepSeekCacheDiagnostics(metrics) ? metrics : null;
}

function comparableDeepSeekMetrics(current = {}, previous = {}) {
  const currentDiagnostics = current?.promptCacheDiagnostics || {};
  const previousDiagnostics = previous?.promptCacheDiagnostics || {};
  if (
    currentDiagnostics.providerPath &&
    previousDiagnostics.providerPath &&
    currentDiagnostics.providerPath !== previousDiagnostics.providerPath
  )
    return false;
  if (current.model && previous.model && current.model !== previous.model)
    return false;
  return true;
}

async function previousDeepSeekMetricsForSave({
  workspaceId,
  threadId = null,
  apiSessionId = null,
  excludeChatId = null,
  currentMetrics = {},
} = {}) {
  if (!workspaceId || !hasDeepSeekCacheDiagnostics(currentMetrics)) return null;

  const previousChats = await prisma.workspace_chats.findMany({
    where: {
      workspaceId,
      thread_id: threadId || null,
      api_session_id: apiSessionId || null,
      ...(excludeChatId ? { id: { not: Number(excludeChatId) } } : {}),
    },
    orderBy: { id: "desc" },
    take: 25,
  });

  for (const chat of previousChats) {
    const metrics = deepSeekMetricsFromChat(
      await decryptWorkspaceChatRecordAsync(chat)
    );
    if (metrics && comparableDeepSeekMetrics(currentMetrics, metrics))
      return metrics;
  }
  return null;
}

async function responseWithDeepSeekCacheDiagnosis({
  workspaceId,
  threadId = null,
  apiSessionId = null,
  excludeChatId = null,
  response = {},
} = {}) {
  const metrics = response?.metrics || null;
  if (!hasDeepSeekCacheDiagnostics(metrics)) return response;

  try {
    const previousMetrics = await previousDeepSeekMetricsForSave({
      workspaceId,
      threadId,
      apiSessionId,
      excludeChatId,
      currentMetrics: metrics,
    });
    return {
      ...(response || {}),
      metrics: withDeepSeekCacheDiagnosis(metrics, previousMetrics),
    };
  } catch (error) {
    console.warn("[DeepSeekCacheDiagnosis] failed to attach diagnosis", {
      message: error.message,
      workspaceId,
      threadId,
      apiSessionId,
      excludeChatId,
    });
    return response;
  }
}

const WorkspaceChats = {
  new: async function ({
    workspaceId,
    prompt,
    response = {},
    user = null,
    threadId = null,
    include = true,
    apiSessionId = null,
    clientTurnId = null,
  }) {
    try {
      const normalizedClientTurnId = String(clientTurnId || "").trim() || null;
      const idempotencyScope = {
        workspaceId,
        user_id: user?.id || null,
        thread_id: threadId,
        api_session_id: apiSessionId,
      };
      if (normalizedClientTurnId) {
        const existing = await prisma.workspace_chats.findFirst({
          where: {
            clientTurnId: normalizedClientTurnId,
            ...idempotencyScope,
          },
        });
        if (existing) {
          return {
            chat: await decryptWorkspaceChatRecordAsync(existing),
            message: null,
            replayed: true,
          };
        }
      }
      response = await responseWithDeepSeekCacheDiagnosis({
        workspaceId,
        threadId,
        apiSessionId,
        response,
      });
      const scope = {
        workspaceId,
        userId: user?.id || null,
        threadId,
        apiSessionId,
      };
      const chat = await prisma.workspace_chats.create({
        data: {
          public_id: newPublicChatId(),
          clientTurnId: normalizedClientTurnId,
          workspaceId,
          prompt: await encryptWorkspaceChatFieldAsync(prompt, scope),
          response: await encryptWorkspaceChatFieldAsync(
            safeJSONStringify(response),
            scope
          ),
          user_id: user?.id || null,
          thread_id: threadId,
          api_session_id: apiSessionId,
          include,
        },
      });
      await rebuildChatCryptoChainForScope(scope);
      if (threadId && include && !apiSessionId) {
        const {
          maybeEnqueueTitleGenerationAfterChat,
        } = require("../utils/chats/threadTitleGeneration");
        maybeEnqueueTitleGenerationAfterChat({
          workspaceId,
          threadId,
          userId: user?.id || null,
          include,
          apiSessionId,
        }).catch((error) =>
          console.warn("[ThreadTitle] failed to schedule", error.message)
        );
      }
      return {
        chat: await decryptWorkspaceChatRecordAsync(chat),
        message: null,
        replayed: false,
      };
    } catch (error) {
      if (clientTurnId && error?.code === "P2002") {
        const existing = await prisma.workspace_chats.findFirst({
          where: {
            clientTurnId: String(clientTurnId).trim(),
            workspaceId,
            user_id: user?.id || null,
            thread_id: threadId,
            api_session_id: apiSessionId,
          },
        });
        if (existing) {
          return {
            chat: await decryptWorkspaceChatRecordAsync(existing),
            message: null,
            replayed: true,
          };
        }
      }
      console.error(error.message);
      return { chat: null, message: error.message };
    }
  },

  forWorkspaceByUser: async function (
    workspaceId = null,
    userId = null,
    limit = null,
    orderBy = null
  ) {
    if (!workspaceId || !userId) return [];
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: {
          workspaceId,
          user_id: userId,
          thread_id: null, // this function is now only used for the default thread on workspaces and users
          api_session_id: null, // do not include api-session chats in the frontend for anyone.
          include: true,
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : { orderBy: { id: "asc" } }),
      });
      return await decryptWorkspaceChatRecordsAsync(chats);
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  forWorkspaceByApiSessionId: async function (
    workspaceId = null,
    apiSessionId = null,
    limit = null,
    orderBy = null
  ) {
    if (!workspaceId || !apiSessionId) return [];
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: {
          workspaceId,
          user_id: null,
          api_session_id: String(apiSessionId),
          thread_id: null,
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : { orderBy: { id: "asc" } }),
      });
      return await decryptWorkspaceChatRecordsAsync(chats);
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  forWorkspace: async function (
    workspaceId = null,
    limit = null,
    orderBy = null
  ) {
    if (!workspaceId) return [];
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: {
          workspaceId,
          thread_id: null, // this function is now only used for the default thread on workspaces
          api_session_id: null, // do not include api-session chats in the frontend for anyone.
          include: true,
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : { orderBy: { id: "asc" } }),
      });
      return await decryptWorkspaceChatRecordsAsync(chats);
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * @deprecated Use markThreadHistoryInvalidV2 instead.
   */
  markHistoryInvalid: async function (workspaceId = null, user = null) {
    if (!workspaceId) return;
    try {
      await prisma.workspace_chats.updateMany({
        where: {
          workspaceId,
          user_id: user?.id,
          thread_id: null, // this function is now only used for the default thread on workspaces
        },
        data: {
          include: false,
        },
      });
      return;
    } catch (error) {
      console.error(error.message);
    }
  },

  /**
   * @deprecated Use markThreadHistoryInvalidV2 instead.
   */
  markThreadHistoryInvalid: async function (
    workspaceId = null,
    user = null,
    threadId = null
  ) {
    if (!workspaceId || !threadId) return;
    try {
      await prisma.workspace_chats.updateMany({
        where: {
          workspaceId,
          thread_id: threadId,
          user_id: user?.id,
        },
        data: {
          include: false,
        },
      });
      return;
    } catch (error) {
      console.error(error.message);
    }
  },

  /**
   * @description This function is used to mark a thread's history as invalid.
   * and works with an arbitrary where clause.
   * @param {Object} whereClause - The where clause to update the chats.
   * @param {Object} data - The data to update the chats with.
   * @returns {Promise<void>}
   */
  markThreadHistoryInvalidV2: async function (whereClause = {}) {
    if (!whereClause) return;
    try {
      await prisma.workspace_chats.updateMany({
        where: whereClause,
        data: {
          include: false,
        },
      });
      return;
    } catch (error) {
      console.error(error.message);
    }
  },

  get: async function (clause = {}, limit = null, orderBy = null) {
    try {
      const chat = await prisma.workspace_chats.findFirst({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return await decryptWorkspaceChatRecordAsync(chat || null);
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.workspace_chats.deleteMany({
        where: clause,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null
  ) {
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return await decryptWorkspaceChatRecordsAsync(chats);
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  whereMetadata: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null
  ) {
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: clause,
        select: {
          id: true,
          public_id: true,
          workspaceId: true,
          user_id: true,
          thread_id: true,
          api_session_id: true,
          include: true,
          createdAt: true,
          feedbackScore: true,
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return chats;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.workspace_chats.count({
        where: clause,
      });
      return count;
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  whereWithData: async function (
    clause = {},
    limit = null,
    offset = null,
    orderBy = null
  ) {
    const { Workspace } = require("./workspace");
    const { User } = require("./user");

    try {
      const results = await this.where(clause, limit, orderBy, offset);

      for (const res of results) {
        const workspace = await Workspace.get({ id: res.workspaceId });
        res.workspace = workspace
          ? { name: workspace.name, slug: workspace.slug }
          : { name: "deleted workspace", slug: null };

        const user = res.user_id ? await User.get({ id: res.user_id }) : null;
        res.user = user
          ? { username: user.username }
          : { username: res.api_session_id !== null ? "API" : "unknown user" };
      }

      return results;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },
  updateFeedbackScore: async function (chatId = null, feedbackScore = null) {
    if (!chatId) return;
    try {
      await prisma.workspace_chats.update({
        where: {
          id: Number(chatId),
        },
        data: {
          feedbackScore:
            feedbackScore === null ? null : Number(feedbackScore) === 1,
        },
      });
      return;
    } catch (error) {
      console.error(error.message);
    }
  },

  // Explicit update of settings + key validations.
  // Only use this method when directly setting a key value
  // that takes no user input for the keys being modified.
  _update: async function (id = null, data = {}) {
    if (!id) throw new Error("No workspace chat id provided for update");

    try {
      const existing = await prisma.workspace_chats.findFirst({
        where: { id },
      });
      if (!existing) return false;
      const scope = scopeFromChat(existing);
      const contentUpdated =
        Object.prototype.hasOwnProperty.call(data, "prompt") ||
        Object.prototype.hasOwnProperty.call(data, "response");
      const payload = { ...data };
      if (Object.prototype.hasOwnProperty.call(data, "prompt")) {
        payload.prompt = await encryptWorkspaceChatFieldAsync(
          data.prompt,
          scope
        );
      }
      if (Object.prototype.hasOwnProperty.call(data, "response")) {
        payload.response = await encryptWorkspaceChatFieldAsync(
          data.response,
          scope
        );
      }
      await prisma.workspace_chats.update({
        where: { id },
        data: payload,
      });
      if (contentUpdated) await rebuildChatCryptoChainForScope(scope);
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },
  bulkCreate: async function (chatsData) {
    // TODO: Replace with createMany when we update prisma to latest version
    // The version of prisma that we are currently using does not support createMany with SQLite
    try {
      const createdChats = [];
      for (const chatData of chatsData) {
        const scope = {
          workspaceId: chatData.workspaceId,
          userId: chatData.user_id ?? chatData.user?.id ?? null,
          threadId: chatData.thread_id ?? chatData.threadId ?? null,
          apiSessionId:
            chatData.api_session_id ?? chatData.apiSessionId ?? null,
        };
        const chat = await prisma.workspace_chats.create({
          data: {
            ...chatData,
            ...(Object.prototype.hasOwnProperty.call(chatData, "prompt")
              ? {
                  prompt: await encryptWorkspaceChatFieldAsync(
                    chatData.prompt,
                    scope
                  ),
                }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(chatData, "response")
              ? {
                  response: await encryptWorkspaceChatFieldAsync(
                    chatData.response,
                    scope
                  ),
                }
              : {}),
            public_id: chatData.public_id || newPublicChatId(),
          },
        });
        await rebuildChatCryptoChainForScope(scope);
        createdChats.push(await decryptWorkspaceChatRecordAsync(chat));
      }
      return { chats: createdChats, message: null };
    } catch (error) {
      console.error(error.message);
      return { chats: null, message: error.message };
    }
  },
  upsert: async function (
    chatId = null,
    data = {
      workspaceId: null,
      prompt: null,
      response: {},
      user: null,
      threadId: null,
      include: true,
      apiSessionId: null,
    }
  ) {
    try {
      data.response = await responseWithDeepSeekCacheDiagnosis({
        workspaceId: data.workspaceId,
        threadId: data.threadId,
        apiSessionId: data.apiSessionId,
        excludeChatId: chatId,
        response: data.response,
      });
      const scope = {
        workspaceId: data.workspaceId,
        userId: data.user?.id || null,
        threadId: data.threadId,
        apiSessionId: data.apiSessionId,
      };
      const payload = {
        workspaceId: data.workspaceId,
        response: await encryptWorkspaceChatFieldAsync(
          safeJSONStringify(data.response),
          scope
        ),
        user_id: data.user?.id || null,
        thread_id: data.threadId,
        api_session_id: data.apiSessionId,
        include: data.include,
      };

      const chat = await prisma.workspace_chats.upsert({
        where: {
          id: Number(chatId),
          user_id: data.user?.id || null,
        },
        // On updates, we already have the prompt so we don't need to set it again.
        update: { ...payload, lastUpdatedAt: new Date() },

        // On creates, we need to set the prompt or else record will fail.
        create: {
          ...payload,
          prompt: await encryptWorkspaceChatFieldAsync(data.prompt, scope),
          public_id: data.public_id || newPublicChatId(),
        },
      });
      await rebuildChatCryptoChainForScope(scope);
      return {
        chat: await decryptWorkspaceChatRecordAsync(chat),
        message: null,
      };
    } catch (error) {
      console.error(error.message);
      return { chat: null, message: error.message };
    }
  },
};

module.exports = { WorkspaceChats };
