const prisma = require("../utils/prisma");
const { safeJSONStringify } = require("../utils/helpers/chat/responses");
const {
  hasDeepSeekCacheDiagnostics,
  withDeepSeekCacheDiagnosis,
} = require("../utils/AiProviders/deepseek/promptCache");
const { newPublicChatId } = require("../utils/chats/chatIdentifiers");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");
const {
  appendChatCryptoMetadataForRows,
  decryptWorkspaceChatRecordAsync,
  decryptWorkspaceChatRecordsAsync,
  encryptWorkspaceChatFieldAsync,
  rebuildChatCryptoChainFromChatId,
  scopeFromChat,
} = require("../utils/security/chatHistoryEncryption");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const { ContentObject } = require("./contentObject");
const {
  hydrateChatPayload,
  hydrateChatPayloads,
  prepareChatPayload,
} = require("../utils/contentObjects/chatPayload");
const {
  contentObjectWritesEnabled,
} = require("../utils/contentObjects/policy");

async function hydrateWorkspaceChatRelations(client, chats = []) {
  if (!Array.isArray(chats) || chats.length === 0) return [];
  const workspaceIds = [
    ...new Set(
      chats
        .map((chat) => Number(chat.workspaceId))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
  const userIds = [
    ...new Set(
      chats
        .map((chat) => Number(chat.user_id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
  const [workspaces, users] = await Promise.all([
    workspaceIds.length
      ? client.workspaces.findMany({
          where: { id: { in: workspaceIds } },
          select: { id: true, name: true, slug: true },
        })
      : [],
    userIds.length
      ? client.users.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true },
        })
      : [],
  ]);
  const workspaceById = new Map(
    workspaces.map((workspace) => [Number(workspace.id), workspace])
  );
  const userById = new Map(users.map((user) => [Number(user.id), user]));

  return chats.map((chat) => {
    const workspace = workspaceById.get(Number(chat.workspaceId));
    const user = chat.user_id
      ? userById.get(Number(chat.user_id)) || null
      : null;
    return {
      ...chat,
      workspace: workspace
        ? { name: workspace.name, slug: workspace.slug }
        : { name: "deleted workspace", slug: null },
      user: user
        ? { username: user.username }
        : {
            username: chat.api_session_id !== null ? "API" : "unknown user",
          },
    };
  });
}

function chatScopeKey(scope = {}) {
  return JSON.stringify({
    workspaceId: Number(scope.workspaceId),
    userId: scope.userId == null ? null : Number(scope.userId),
    threadId: scope.threadId == null ? null : Number(scope.threadId),
    apiSessionId:
      scope.apiSessionId == null ? null : String(scope.apiSessionId),
  });
}

async function decryptAndHydrateRecord(chat, options = {}) {
  return hydrateChatPayload(
    await decryptWorkspaceChatRecordAsync(chat),
    options
  );
}

async function decryptAndHydrateRecords(chats = [], options = {}) {
  return hydrateChatPayloads(
    await decryptWorkspaceChatRecordsAsync(chats),
    options
  );
}

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
    sourceChannel = "web",
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
            chat: await decryptAndHydrateRecord(existing, {
              attachmentMode: "reference",
            }),
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
      const workspace = contentObjectWritesEnabled()
        ? await prisma.workspaces.findUnique({
            where: { id: Number(workspaceId) },
            select: { slug: true },
          })
        : null;
      const preparedPayload = await prepareChatPayload({
        response,
        scope,
        workspaceSlug: workspace?.slug || String(workspaceId),
      });
      const chatData = {
        public_id: newPublicChatId(),
        clientTurnId: normalizedClientTurnId,
        workspaceId,
        prompt: await encryptWorkspaceChatFieldAsync(prompt, scope),
        response: await encryptWorkspaceChatFieldAsync(
          safeJSONStringify(preparedPayload.response),
          scope
        ),
        user_id: user?.id || null,
        thread_id: threadId,
        api_session_id: apiSessionId,
        created_from: sourceChannel,
        include,
        payloadVersion: preparedPayload.payloadVersion,
      };
      const syncReady =
        threadId &&
        include &&
        !apiSessionId &&
        SyncV2.enabled("chat") &&
        (await SyncV2.schemaReady());
      const chat = await prisma.$transaction(async (tx) => {
        const created = await tx.workspace_chats.create({ data: chatData });
        if (syncReady) {
          const thread = await tx.workspace_threads.update({
            where: { id: Number(threadId) },
            data: { historyRevision: { increment: 1 } },
          });
          const audience = thread.user_id
            ? [Number(thread.user_id)]
            : (
                await tx.workspace_users.findMany({
                  where: { workspace_id: Number(workspaceId) },
                  select: { user_id: true },
                })
              ).map((row) => Number(row.user_id));
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.threadMessages(threadId),
            content: {
              threadId: Number(threadId),
              historyRevision: thread.historyRevision,
              latestChatId: created.id,
              latestPublicChatId: created.public_id,
            },
            eventType: "message.appended",
            changedPaths: [`messages.${created.id}`],
            payloadHint: {
              operation: "append",
              messageId: created.id,
              publicMessageId: created.public_id,
              messageVersion: created.messageVersion,
              historyRevision: thread.historyRevision,
            },
            originClientId: null,
            mutationId: normalizedClientTurnId,
            audience,
          });
        }
        await ContentObject.attachToChat(tx, {
          chatId: created.id,
          attachments: preparedPayload.attachments,
          contentRefs: preparedPayload.contentRefs,
        });
        await appendChatCryptoMetadataForRows([created], scope, {
          client: tx,
        });
        return created;
      });
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
      const persistedChat = await hydrateChatPayload(
        await decryptWorkspaceChatRecordAsync(chat),
        { attachmentMode: "reference" }
      );
      try {
        if (process.env.NODE_ENV === "test")
          return {
            chat: persistedChat,
            message: null,
            replayed: false,
          };
        const { WorkspaceCognition } = require("./workspaceCognition");
        WorkspaceCognition.enqueueFinalizedTurn({
          chat: persistedChat,
          sourceChannel,
        }).catch((error) =>
          console.warn(
            "[WorkspaceCognition] failed to enqueue finalized turn",
            error.message
          )
        );
      } catch (error) {
        console.warn(
          "[WorkspaceCognition] failed to schedule extraction",
          error.message
        );
      }
      return {
        chat: persistedChat,
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
            chat: await decryptAndHydrateRecord(existing, {
              attachmentMode: "reference",
            }),
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
    orderBy = null,
    options = {}
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
      return await decryptAndHydrateRecords(chats, options);
    } catch (error) {
      throwModelDataAccessError("workspaceChats.forWorkspaceByUser", error);
    }
  },

  forWorkspaceByApiSessionId: async function (
    workspaceId = null,
    apiSessionId = null,
    limit = null,
    orderBy = null,
    options = {}
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
      return await decryptAndHydrateRecords(chats, options);
    } catch (error) {
      throwModelDataAccessError(
        "workspaceChats.forWorkspaceByApiSessionId",
        error
      );
    }
  },

  forWorkspace: async function (
    workspaceId = null,
    limit = null,
    orderBy = null,
    options = {}
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
      return await decryptAndHydrateRecords(chats, options);
    } catch (error) {
      throwModelDataAccessError("workspaceChats.forWorkspace", error);
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

  get: async function (
    clause = {},
    limit = null,
    orderBy = null,
    options = {}
  ) {
    try {
      const chat = await prisma.workspace_chats.findFirst({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return await decryptAndHydrateRecord(chat || null, options);
    } catch (error) {
      throwModelDataAccessError("workspaceChats.get", error);
    }
  },

  delete: async function (clause = {}) {
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: clause,
        select: {
          id: true,
          workspaceId: true,
          user_id: true,
          thread_id: true,
          api_session_id: true,
        },
      });
      try {
        const byWorkspace = new Map();
        for (const chat of chats) {
          if (!byWorkspace.has(chat.workspaceId))
            byWorkspace.set(chat.workspaceId, []);
          byWorkspace.get(chat.workspaceId).push(chat.id);
        }
        const { WorkspaceCognition } = require("./workspaceCognition");
        await Promise.all(
          [...byWorkspace.entries()].map(([workspaceId, chatIds]) =>
            WorkspaceCognition.cancelBufferedChats(
              workspaceId,
              chatIds,
              "chat_deleted"
            )
          )
        );
      } catch (error) {
        console.warn(
          "[WorkspaceCognition] failed to cancel deleted chat buffers",
          error.message
        );
      }
      await prisma.$transaction(async (tx) => {
        const affectedChats = await tx.workspace_chats.findMany({
          where: clause,
          select: {
            id: true,
            workspaceId: true,
            user_id: true,
            thread_id: true,
            api_session_id: true,
          },
        });
        const affectedChatIds = affectedChats.map((chat) => Number(chat.id));
        const [attachmentRefs, contentRefs] = affectedChatIds.length
          ? await Promise.all([
              tx.workspace_chat_attachment_refs.findMany({
                where: { chatId: { in: affectedChatIds } },
                select: { contentObjectId: true },
              }),
              tx.workspace_chat_content_refs.findMany({
                where: { chatId: { in: affectedChatIds } },
                select: { contentObjectId: true },
              }),
            ])
          : [[], []];
        await tx.workspace_chats.deleteMany({ where: clause });
        const released = new Map();
        for (const ref of [...attachmentRefs, ...contentRefs]) {
          released.set(
            ref.contentObjectId,
            Number(released.get(ref.contentObjectId) || 0) + 1
          );
        }
        for (const [contentObjectId, count] of released.entries()) {
          const object = await tx.content_objects.update({
            where: { id: contentObjectId },
            data: { refCount: { decrement: count } },
          });
          if (Number(object.refCount) <= 0) {
            await tx.content_objects.update({
              where: { id: contentObjectId },
              data: {
                refCount: 0,
                state: "delete_pending",
                deleteAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              },
            });
          }
        }
        const affectedScopes = new Map();
        for (const chat of affectedChats) {
          const scope = scopeFromChat(chat);
          const key = chatScopeKey(scope);
          const current = affectedScopes.get(key);
          if (!current || Number(chat.id) < current.startChatId) {
            affectedScopes.set(key, {
              scope,
              startChatId: Number(chat.id),
            });
          }
        }
        for (const affected of affectedScopes.values()) {
          await rebuildChatCryptoChainFromChatId(
            affected.scope,
            affected.startChatId,
            { client: tx }
          );
        }
      });
      try {
        const byWorkspace = new Map();
        for (const chat of chats) {
          if (!byWorkspace.has(chat.workspaceId))
            byWorkspace.set(chat.workspaceId, []);
          byWorkspace.get(chat.workspaceId).push(chat.id);
        }
        const { WorkspaceCognition } = require("./workspaceCognition");
        await Promise.all(
          [...byWorkspace.entries()].map(([workspaceId, chatIds]) =>
            WorkspaceCognition.markChatEvidenceStale(
              workspaceId,
              chatIds,
              "source_chat_deleted"
            )
          )
        );
      } catch (error) {
        console.warn(
          "[WorkspaceCognition] failed to stale deleted chat evidence",
          error.message
        );
      }
      return true;
    } catch (error) {
      throwModelDataAccessError("workspaceChats.delete", error);
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null,
    options = {}
  ) {
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return await decryptAndHydrateRecords(chats, options);
    } catch (error) {
      throwModelDataAccessError("WorkspaceChats.where", error, {
        hasClause: Object.keys(clause || {}).length > 0,
      });
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
      throwModelDataAccessError("WorkspaceChats.whereMetadata", error, {
        hasClause: Object.keys(clause || {}).length > 0,
      });
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.workspace_chats.count({
        where: clause,
      });
      return count;
    } catch (error) {
      throwModelDataAccessError("WorkspaceChats.count", error, {
        hasClause: Object.keys(clause || {}).length > 0,
      });
    }
  },

  whereWithData: async function (
    clause = {},
    limit = null,
    offset = null,
    orderBy = null
  ) {
    try {
      const results = await this.where(clause, limit, orderBy, offset);
      return await hydrateWorkspaceChatRelations(prisma, results);
    } catch (error) {
      throwModelDataAccessError("WorkspaceChats.whereWithData", error, {
        hasClause: Object.keys(clause || {}).length > 0,
      });
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
      const syncReady =
        contentUpdated &&
        existing.thread_id &&
        existing.include &&
        !existing.api_session_id &&
        SyncV2.enabled("chat") &&
        (await SyncV2.schemaReady());
      if (contentUpdated) {
        await prisma.$transaction(async (tx) => {
          const updated = await tx.workspace_chats.update({
            where: { id },
            data: syncReady
              ? { ...payload, messageVersion: { increment: 1 } }
              : payload,
          });
          if (syncReady) {
            const thread = await tx.workspace_threads.update({
              where: { id: Number(existing.thread_id) },
              data: { historyRevision: { increment: 1 } },
            });
            const audience = thread.user_id
              ? [Number(thread.user_id)]
              : (
                  await tx.workspace_users.findMany({
                    where: { workspace_id: Number(existing.workspaceId) },
                    select: { user_id: true },
                  })
                ).map((row) => Number(row.user_id));
            await SyncV2.recordNodeChange(tx, {
              nodeKey: nodeKeys.threadMessages(existing.thread_id),
              content: {
                threadId: Number(existing.thread_id),
                historyRevision: thread.historyRevision,
                latestChatId: updated.id,
              },
              eventType: "message.edited",
              changedPaths: [`messages.${updated.id}`],
              payloadHint: {
                operation: "edit",
                messageId: updated.id,
                publicMessageId: updated.public_id,
                messageVersion: updated.messageVersion,
                historyRevision: thread.historyRevision,
              },
              audience,
            });
          }
          await rebuildChatCryptoChainFromChatId(scope, updated.id || id, {
            client: tx,
          });
        });
      } else {
        await prisma.workspace_chats.update({
          where: { id },
          data: payload,
        });
      }
      if (contentUpdated) {
        try {
          if (process.env.NODE_ENV === "test") return true;
          const { WorkspaceCognition } = require("./workspaceCognition");
          await WorkspaceCognition.markChatEvidenceStale(
            scope.workspaceId,
            [id],
            "source_chat_updated"
          );
          const updated = await prisma.workspace_chats.findFirst({
            where: { id },
          });
          const decrypted = await decryptWorkspaceChatRecordAsync(updated);
          await WorkspaceCognition.cancelBufferedChats(
            scope.workspaceId,
            [id],
            "chat_content_replaced"
          );
          await WorkspaceCognition.enqueueFinalizedTurn({
            chat: decrypted,
            sourceChannel: decrypted.created_from || "web",
          });
        } catch (error) {
          console.warn(
            "[WorkspaceCognition] failed to refresh updated chat evidence",
            error.message
          );
        }
      }
      return true;
    } catch (error) {
      throwModelDataAccessError("workspaceChats._update", error);
    }
  },
  bulkCreate: async function (chatsData) {
    // TODO: Replace with createMany when we update prisma to latest version
    // The version of prisma that we are currently using does not support createMany with SQLite
    try {
      const preparedChats = [];
      for (const chatData of chatsData) {
        const scope = {
          workspaceId: chatData.workspaceId,
          userId: chatData.user_id ?? chatData.user?.id ?? null,
          threadId: chatData.thread_id ?? chatData.threadId ?? null,
          apiSessionId:
            chatData.api_session_id ?? chatData.apiSessionId ?? null,
        };
        const sourceChatId =
          chatData.sourceChatId ?? chatData.original_message_id ?? null;
        const referenceClone =
          Number(chatData.payloadVersion || 1) >= 2 && sourceChatId
            ? await ContentObject.prepareChatReferenceClone(prisma, {
                sourceChatId,
                response: chatData.response,
                workspaceSlug: chatData.workspaceSlug,
              })
            : { response: chatData.response, attachments: [], contentRefs: [] };
        const data = { ...chatData };
        delete data.sourceChatId;
        delete data.workspaceSlug;
        preparedChats.push({
          scope,
          data: {
            ...data,
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
                    typeof referenceClone.response === "string"
                      ? referenceClone.response
                      : safeJSONStringify(referenceClone.response),
                    scope
                  ),
                }
              : {}),
            public_id: chatData.public_id || newPublicChatId(),
          },
          attachments: referenceClone.attachments,
          contentRefs: referenceClone.contentRefs,
        });
      }
      const chats = await prisma.$transaction(async (tx) => {
        const created = [];
        const rowsByScope = new Map();
        for (const prepared of preparedChats) {
          const chat = await tx.workspace_chats.create({ data: prepared.data });
          await ContentObject.attachToChat(tx, {
            chatId: chat.id,
            attachments: prepared.attachments,
            contentRefs: prepared.contentRefs,
          });
          created.push(chat);
          const key = JSON.stringify(prepared.scope);
          const group = rowsByScope.get(key) || {
            scope: prepared.scope,
            rows: [],
          };
          group.rows.push(chat);
          rowsByScope.set(key, group);
        }
        for (const group of rowsByScope.values()) {
          await appendChatCryptoMetadataForRows(group.rows, group.scope, {
            client: tx,
          });
        }
        return created;
      });
      const createdChats = [];
      for (const chat of chats) {
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
        clientTurnId: String(data.clientTurnId || "").trim() || undefined,
        workspaceId: data.workspaceId,
        response: await encryptWorkspaceChatFieldAsync(
          safeJSONStringify(data.response),
          scope
        ),
        user_id: data.user?.id || null,
        thread_id: data.threadId,
        api_session_id: data.apiSessionId,
        include: data.include,
        created_from: data.sourceChannel || "agent",
      };

      const createPayload = {
        ...payload,
        prompt: await encryptWorkspaceChatFieldAsync(data.prompt, scope),
        public_id: data.public_id || newPublicChatId(),
      };
      const chat = await prisma.$transaction(async (tx) => {
        const existing = Number(chatId)
          ? await tx.workspace_chats.findFirst({
              where: {
                id: Number(chatId),
                user_id: data.user?.id || null,
              },
            })
          : null;
        const persisted = await tx.workspace_chats.upsert({
          where: {
            id: Number(chatId),
            user_id: data.user?.id || null,
          },
          // On updates, we already have the prompt so we don't need to set it again.
          update: { ...payload, lastUpdatedAt: new Date() },

          // On creates, we need to set the prompt or else record will fail.
          create: createPayload,
        });
        if (!existing) {
          await appendChatCryptoMetadataForRows([persisted], scope, {
            client: tx,
          });
          return persisted;
        }

        const previousScope = scopeFromChat(existing);
        await rebuildChatCryptoChainFromChatId(scope, persisted.id, {
          client: tx,
        });
        if (chatScopeKey(previousScope) !== chatScopeKey(scope)) {
          await rebuildChatCryptoChainFromChatId(previousScope, persisted.id, {
            client: tx,
          });
        }
        return persisted;
      });
      const persistedChat = await decryptWorkspaceChatRecordAsync(chat);
      try {
        if (process.env.NODE_ENV === "test")
          return { chat: persistedChat, message: null };
        const { WorkspaceCognition } = require("./workspaceCognition");
        await WorkspaceCognition.enqueueFinalizedTurn({
          chat: persistedChat,
          sourceChannel: data.sourceChannel || "agent",
        });
      } catch (error) {
        console.warn(
          "[WorkspaceCognition] failed to enqueue agent turn",
          error.message
        );
      }
      return {
        chat: persistedChat,
        message: null,
      };
    } catch (error) {
      console.error(error.message);
      return { chat: null, message: error.message };
    }
  },
};

module.exports = {
  WorkspaceChats,
  _internals: { hydrateWorkspaceChatRelations },
};
