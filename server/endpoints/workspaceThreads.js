const crypto = require("crypto");
const {
  multiUserMode,
  userFromSession,
  reqBody,
  queryParams,
} = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  TelemetryRepository: Telemetry,
} = require("../repositories/telemetryRepository");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const { DataAccessCenter } = require("../utils/dataAccess");
const {
  validWorkspaceSlug,
  validWorkspaceAndThreadSlug,
} = require("../utils/middleware/validWorkspace");
const {
  getAuthorizedWorkspaceThread,
} = require("../utils/authz/resourceAccess");
const {
  convertToChatHistoryWithExecution,
  writeResponseChunk,
} = require("../utils/helpers/chat/responses");
const { getModelTag } = require("./utils");
const {
  compactThread,
  getThreadCompactionStatus,
} = require("../utils/chats/threadCompaction");
const {
  remoteThreadMemoryCompact,
  remoteThreadMemoryEnabled,
  remoteThreadMemoryStatus,
} = require("../utils/chats/threadMemoryRemoteClient");
const {
  subscribeToThreadTitleUpdates,
} = require("../utils/chats/threadTitleEvents");
const {
  publishWorkspaceSyncEvent,
  subscribeToWorkspaceSyncEvents,
} = require("../utils/chats/workspaceSyncEvents");
const {
  chatIdentifierPayload,
  chatIdentifiersWhere,
  chatIdentityFromRequest,
} = require("../utils/chats/chatIdentifiers");
const {
  setSseTransportHeaders,
} = require("../utils/security/transportSecurity");
const { getClientContext } = require("../utils/clientIdentity");
const {
  isSupportedThreadChatModel,
} = require("../utils/chats/threadChatModel");
const {
  chatMutationHTTPStatus,
  deleteChatTurnAndPublish,
} = require("../utils/chats/chatTurnMutations");

const Workspace = DataAccessCenter.workspace;
const WorkspaceThread = DataAccessCenter.workspaceThread;
const WorkspaceChats = DataAccessCenter.workspaceChat;
const WeChatGatewayThread = DataAccessCenter.wechatGatewayThread;
const MutationReceipt = DataAccessCenter.athenaMutationReceipt;
const { readRequestHeader } = require("../utils/http/requestHeaders");

function compactActionId(value = null) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, 160) : null;
}

function parseHistoryQuery(request) {
  const query = queryParams(request);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const beforeChatId = Number(query.beforeChatId) || null;
  const afterChatId = Number(query.afterChatId) || null;
  const anchorChatId = Number(query.anchorChatId) || null;
  const priorityWindow = Math.min(
    Math.max(Number(query.priorityWindow) || 0, 0),
    limit
  );
  return {
    enabled:
      query.limit !== undefined ||
      query.beforeChatId !== undefined ||
      query.afterChatId !== undefined ||
      query.anchorChatId !== undefined ||
      query.detail !== undefined ||
      query.priorityWindow !== undefined,
    limit,
    beforeChatId,
    afterChatId,
    anchorChatId,
    detail: query.detail === "light" ? "light" : "full",
    priorityWindow,
    attachmentMode:
      query.attachmentMode === "reference" ||
      readRequestHeader(request, "X-Athena-Chat-Payload-Version") === "2"
        ? "reference"
        : "inline",
  };
}

async function threadHistorySyncMetadata(thread, user = null) {
  const [metadata] = await WorkspaceThread.historyFingerprintManifest({
    threads: [thread],
    userId: user?.id || null,
  });
  return (
    metadata || {
      historyRevision: Number(thread?.historyRevision || 0),
      historyFingerprint: null,
      latestChatId: null,
      latestChatAt: null,
    }
  );
}

function historyETag(fingerprint = null) {
  return fingerprint ? `"${fingerprint}"` : null;
}

function requestMatchesHistoryETag(request, fingerprint = null) {
  const tag = historyETag(fingerprint);
  if (!tag) return false;
  return String(readRequestHeader(request, "If-None-Match") || "")
    .split(",")
    .map((value) => value.trim())
    .includes(tag);
}

function attachHistorySyncHeaders(response, metadata = {}) {
  const tag = historyETag(metadata.historyFingerprint);
  if (tag) response.setHeader("ETag", tag);
  response.setHeader("Cache-Control", "private, no-cache");
}

function nullableUserId(value) {
  if (value === null || value === "" || value === "null") return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : NaN;
}

function compactionUserFromInput(
  sessionUser,
  userId = undefined,
  { thread = null, isMultiUser = false } = {}
) {
  if (!isMultiUser) {
    if (userId === undefined)
      return { ok: true, user: sessionUser ? { id: sessionUser.id } : null };
    const id = nullableUserId(userId);
    return { ok: true, user: id === null ? null : { id } };
  }

  const sessionUserId = sessionUser?.id ? Number(sessionUser.id) : null;
  const threadUserId =
    thread?.user_id === null || thread?.user_id === undefined
      ? null
      : Number(thread.user_id);
  const requestedUserId =
    userId === undefined ? sessionUserId : nullableUserId(userId);
  const matchesSession =
    sessionUserId &&
    Number.isFinite(requestedUserId) &&
    Number(requestedUserId) === sessionUserId;
  const matchesThread =
    threadUserId === null || Number(threadUserId) === sessionUserId;

  if (!matchesSession || !matchesThread) return { ok: false, user: null };
  return { ok: true, user: { id: sessionUserId } };
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
  const newestId = history[history.length - 1]?.id || null;
  const hasMore =
    !!oldestId &&
    (history.length >= options.limit
      ? (await WorkspaceChats.count({
          ...baseClause,
          id: { lt: oldestId },
        })) > 0
      : false);
  const hasNewer =
    !!newestId &&
    !!options.afterChatId &&
    history.length >= options.limit &&
    (await WorkspaceChats.count({
      ...baseClause,
      id: { gt: newestId },
    })) > 0;
  return {
    limit: options.limit,
    beforeChatId: options.beforeChatId,
    afterChatId: options.afterChatId,
    anchorChatId: options.anchorChatId,
    nextBeforeChatId: oldestId,
    olderBeforeChatId: oldestId,
    nextAfterChatId: newestId,
    newerAfterChatId: newestId,
    totalReturned: history.length,
    hasMore,
    hasOlder: hasMore,
    hasNewer,
  };
}

function anchorWindowLimits(limit = 20) {
  const remaining = Math.max(limit - 1, 0);
  const beforeLimit = Math.floor(remaining / 2);
  return {
    beforeLimit,
    afterLimit: remaining - beforeLimit,
  };
}

async function anchoredChatHistory(baseClause = {}, options = {}) {
  const anchorChatId = options.anchorChatId;
  const [anchor] = await WorkspaceChats.where(
    { ...baseClause, id: anchorChatId },
    1,
    { id: "asc" },
    null,
    { attachmentMode: options.attachmentMode }
  );
  if (!anchor) {
    return {
      history: [],
      page: {
        limit: options.limit,
        beforeChatId: null,
        afterChatId: null,
        anchorChatId,
        anchorFound: false,
        nextBeforeChatId: null,
        olderBeforeChatId: null,
        nextAfterChatId: null,
        newerAfterChatId: null,
        totalReturned: 0,
        hasMore: false,
        hasOlder: false,
        hasNewer: false,
      },
    };
  }

  const { beforeLimit, afterLimit } = anchorWindowLimits(options.limit);
  const olderDesc = beforeLimit
    ? await WorkspaceChats.where(
        { ...baseClause, id: { lt: anchorChatId } },
        beforeLimit,
        { id: "desc" },
        null,
        { attachmentMode: options.attachmentMode }
      )
    : [];
  const newerAsc = afterLimit
    ? await WorkspaceChats.where(
        { ...baseClause, id: { gt: anchorChatId } },
        afterLimit,
        { id: "asc" },
        null,
        { attachmentMode: options.attachmentMode }
      )
    : [];
  const history = [...olderDesc].reverse().concat(anchor, newerAsc);
  const oldestId = history[0]?.id || null;
  const newestId = history[history.length - 1]?.id || null;
  const hasOlder =
    !!oldestId &&
    (await WorkspaceChats.count({
      ...baseClause,
      id: { lt: oldestId },
    })) > 0;
  const hasNewer =
    !!newestId &&
    (await WorkspaceChats.count({
      ...baseClause,
      id: { gt: newestId },
    })) > 0;

  return {
    history,
    page: {
      limit: options.limit,
      beforeChatId: null,
      afterChatId: null,
      anchorChatId,
      anchorFound: true,
      nextBeforeChatId: oldestId,
      olderBeforeChatId: oldestId,
      nextAfterChatId: newestId,
      newerAfterChatId: newestId,
      totalReturned: history.length,
      hasMore: hasOlder,
      hasOlder,
      hasNewer,
    },
  };
}

async function pagedChatHistory(
  baseClause = {},
  whereClause = {},
  options = {}
) {
  const orderBy = options.afterChatId
    ? { id: "asc" }
    : options.enabled
      ? { id: "desc" }
      : { id: "asc" };
  if (
    options.enabled &&
    options.detail === "light" &&
    options.priorityWindow < options.limit
  ) {
    const history = await WorkspaceChats.whereMetadata(
      whereClause,
      options.limit,
      orderBy
    );
    const orderedHistory = options.afterChatId
      ? history
      : [...history].reverse();
    const lightChatIds = lightChatIdsForHistory(orderedHistory, options);
    const fullChatIds = orderedHistory
      .filter((chat) => !lightChatIds.has(chat.id))
      .map((chat) => chat.id);

    const fullHistory = fullChatIds.length
      ? await WorkspaceChats.where(
          { ...baseClause, id: { in: fullChatIds } },
          null,
          { id: "asc" },
          null,
          { attachmentMode: options.attachmentMode }
        )
      : [];
    const fullHistoryById = new Map(fullHistory.map((chat) => [chat.id, chat]));
    return orderedHistory.map((chat) => fullHistoryById.get(chat.id) || chat);
  }

  const history = await WorkspaceChats.where(
    whereClause,
    options.enabled ? options.limit : null,
    orderBy,
    null,
    { attachmentMode: options.attachmentMode }
  );
  return options.enabled && !options.afterChatId
    ? [...history].reverse()
    : history;
}

async function accessibleWorkspaceBySlug(response, user, slug = null) {
  if (!slug) return null;
  return multiUserMode(response)
    ? await Workspace.getWithUser(user, { slug: String(slug) })
    : await Workspace.get({ slug: String(slug) });
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
        const body = reqBody(request) || {};
        const sourceActionId = compactActionId(body.sourceActionId);
        const requestedChatModel = isSupportedThreadChatModel(body.chatModel)
          ? body.chatModel
          : null;
        let thread = sourceActionId
          ? await WorkspaceThread.get({ sourceActionId })
          : null;
        let message = null;
        let replayed = false;
        if (thread) {
          const ownsThread =
            Number(thread.workspace_id) === Number(workspace.id) &&
            (!multiUserMode(response) ||
              thread.user_id === null ||
              Number(thread.user_id) === Number(user?.id));
          if (!ownsThread) {
            response.status(409).json({
              thread: null,
              message: "sourceActionId is already in use",
            });
            return;
          }
          replayed = true;
        } else {
          ({ thread, message } = await WorkspaceThread.new(
            workspace,
            user?.id,
            {
              thread_type: WorkspaceThread.THREAD_TYPES.chat,
              sourceActionId,
              ...(requestedChatModel ? { chatModel: requestedChatModel } : {}),
            }
          ));
          if (!thread && sourceActionId) {
            const candidate = await WorkspaceThread.get({ sourceActionId });
            if (
              candidate &&
              Number(candidate.workspace_id) === Number(workspace.id) &&
              (!multiUserMode(response) ||
                candidate.user_id === null ||
                Number(candidate.user_id) === Number(user?.id))
            ) {
              thread = candidate;
              message = null;
              replayed = true;
            }
          }
        }
        if (!thread) {
          response.status(400).json({ thread: null, message });
          return;
        }
        if (!replayed) {
          const clientContext = getClientContext(request, { user });
          publishWorkspaceSyncEvent({
            type: "thread_created",
            workspaceId: workspace.id,
            workspaceSlug: workspace.slug,
            userId: user?.id ?? null,
            threadId: thread.id,
            threadSlug: thread.slug,
            threadName: thread.isUntitled ? "" : thread.name,
            title: thread.isUntitled ? null : thread.title || thread.name,
            isUntitled: thread.isUntitled === true,
            titleSource: thread.titleSource,
            titleGenerationStatus: thread.titleGenerationStatus,
            titleVersion: thread.titleVersion,
            threadType: thread.thread_type,
            chatModel: thread.chatModel,
            senderClientId: clientContext.clientId,
            sourceActionId,
          });
          void Promise.allSettled([
            Telemetry.sendTelemetry(
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
            ),
            EventLogs.logEvent(
              "workspace_thread_created",
              {
                workspaceName: workspace?.name || "Unknown Workspace",
              },
              user?.id
            ),
          ]);
        }
        response.status(200).json({
          thread,
          message,
          replayed,
          sourceActionId,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500).end();
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
        const defaultThreads = await WorkspaceThread.ensureOverviewThread(
          workspace,
          user?.id
        );
        const threads = WorkspaceThread.sortForDisplay(
          await WorkspaceThread.withLastChatActivity(
            queryParams(request).includeArchived === "true"
              ? defaultThreads.threads
              : defaultThreads.threads.filter((thread) => !thread.archivedAt),
            workspace.id,
            user?.id
          )
        );
        response.status(200).json({
          threads,
          defaultThreads: { ...defaultThreads, threads },
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/thread-title-events",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      const user = await userFromSession(request, response);
      const workspace = response.locals.workspace;
      const userId = user?.id ?? null;

      setSseTransportHeaders(response, {
        "Access-Control-Allow-Origin": "*",
      });
      response.flushHeaders?.();

      writeResponseChunk(response, {
        type: "thread_title_events_ready",
        workspaceSlug: workspace.slug,
      });

      const heartbeat = setInterval(() => {
        if (response.destroyed || response.writableEnded) return;
        writeResponseChunk(response, { type: "heartbeat" });
      }, 25_000);

      const unsubscribe = subscribeToThreadTitleUpdates((titleUpdate) => {
        if (Number(titleUpdate.workspaceId) !== Number(workspace.id)) return;
        if ((titleUpdate.userId ?? null) !== userId) return;
        if (response.destroyed || response.writableEnded) return;

        writeResponseChunk(response, {
          action: "rename_thread",
          thread: {
            slug: titleUpdate.slug,
            name: titleUpdate.name,
            title: titleUpdate.title,
            isUntitled: titleUpdate.isUntitled,
            titleSource: titleUpdate.titleSource,
            titleGenerationStatus: titleUpdate.titleGenerationStatus,
            titleVersion: titleUpdate.titleVersion,
            animate: true,
          },
        });

        if (process.env.THREAD_TITLE_DEBUG === "true") {
          console.log(
            "[ThreadTitle] sse:delivered",
            JSON.stringify({
              workspaceId: workspace.id,
              threadId: titleUpdate.threadId,
              slug: titleUpdate.slug,
              title: titleUpdate.title || titleUpdate.name,
            })
          );
        }
      });

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.once("close", cleanup);
      response.once("close", cleanup);
    }
  );

  app.get(
    "/workspace/:slug/sync-events",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      const user = await userFromSession(request, response);
      const workspace = response.locals.workspace;
      const userId = user?.id ?? null;

      setSseTransportHeaders(response, {
        "Access-Control-Allow-Origin": "*",
      });
      response.flushHeaders?.();

      writeResponseChunk(response, {
        type: "workspace_sync_ready",
        workspaceSlug: workspace.slug,
      });

      const heartbeat = setInterval(() => {
        if (response.destroyed || response.writableEnded) return;
        writeResponseChunk(response, { type: "heartbeat" });
      }, 25_000);

      const unsubscribe = subscribeToWorkspaceSyncEvents((event) => {
        if (Number(event.workspaceId) !== Number(workspace.id)) return;
        if ((event.userId ?? null) !== userId) return;
        if (response.destroyed || response.writableEnded) return;
        writeResponseChunk(response, event);
      });

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.once("close", cleanup);
      response.once("close", cleanup);
    }
  );

  app.delete(
    "/workspace/:slug/thread/:threadSlug",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      let receiptContext = null;
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const sourceActionId = compactActionId(
          (reqBody(request) || {}).sourceActionId
        );
        let receiptLeaseOwner = null;
        if (sourceActionId) {
          const reservation = await MutationReceipt.reserve({
            userId: user?.id,
            sourceActionId,
            action: "thread.delete",
            workspaceId: workspace.id,
          });
          receiptLeaseOwner = reservation.leaseOwner;
          if (reservation.created) {
            receiptContext = {
              userId: user?.id,
              sourceActionId,
              leaseOwner: receiptLeaseOwner,
            };
          }
          if (!reservation.created) {
            if (reservation.receipt?.status === "failed") {
              return response.status(409).json({
                error: reservation.receipt.errorCode || "thread_delete_failed",
              });
            }
            return response.status(200).json({
              success: true,
              replayed: true,
              pending: reservation.receipt?.status !== "completed",
            });
          }
        }

        const { thread } = await getAuthorizedWorkspaceThread({
          request,
          response,
          workspaceSlug: workspace.slug,
          threadSlug: request.params.threadSlug,
        });
        if (!thread) {
          if (sourceActionId) {
            await MutationReceipt.fail({
              userId: user?.id,
              sourceActionId,
              leaseOwner: receiptLeaseOwner,
              errorCode: "thread_not_found",
            });
            receiptContext = null;
          }
          return response
            .status(404)
            .json({ error: "Workspace thread does not exist." });
        }
        if (WorkspaceThread.isOverviewThread(thread)) {
          if (sourceActionId) {
            await MutationReceipt.fail({
              userId: user?.id,
              sourceActionId,
              leaseOwner: receiptLeaseOwner,
              errorCode: "overview_thread_protected",
            });
            receiptContext = null;
          }
          return response
            .status(400)
            .json({ error: "Overview thread cannot be deleted." });
        }
        await WorkspaceThread.delete({ id: thread.id });
        if (sourceActionId) {
          await MutationReceipt.complete({
            userId: user?.id,
            sourceActionId,
            leaseOwner: receiptLeaseOwner,
            resource: {
              workspaceId: workspace.id,
              workspaceSlug: workspace.slug,
              threadId: thread.id,
              threadSlug: thread.slug,
            },
          });
          receiptContext = null;
        }
        const clientContext = getClientContext(request, { user });
        publishWorkspaceSyncEvent({
          type: "thread_deleted",
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          userId: user?.id ?? null,
          threadId: thread.id,
          threadSlug: thread.slug,
          senderClientId: clientContext.clientId,
          sourceActionId,
        });
        response.status(200).json({
          success: true,
          sourceActionId,
          threadSlug: thread.slug,
        });
      } catch (e) {
        if (receiptContext) {
          await MutationReceipt.fail({
            ...receiptContext,
            errorCode: e?.code || "thread_delete_failed",
          }).catch((receiptError) => {
            console.error(
              "[MutationReceipt] Failed to settle thread deletion",
              receiptError
            );
          });
        }
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/archive",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const thread = response.locals.thread;
        if (WorkspaceThread.isOverviewThread(thread))
          return response
            .status(400)
            .json({ success: false, error: "overview_thread_protected" });
        const archived = await WorkspaceThread.archive(
          thread,
          user?.id || null
        );
        response.status(200).json({ success: true, thread: archived });
      } catch (error) {
        console.error("[WorkspaceThread] archive", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/restore",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (_request, response) => {
      try {
        const thread = await WorkspaceThread.restore(response.locals.thread);
        response.status(200).json({ success: true, thread });
      } catch (error) {
        console.error("[WorkspaceThread] restore", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
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
        const overviewThreads = await WorkspaceThread.where({
          slug: { in: slugs },
          user_id: user?.id ?? null,
          workspace_id: workspace.id,
          thread_type: WorkspaceThread.THREAD_TYPES.overview,
        });
        const protectedSlugs = new Set(
          overviewThreads.map((thread) => thread.slug)
        );
        const deletableSlugs = slugs.filter(
          (slug) => !protectedSlugs.has(slug)
        );
        if (deletableSlugs.length === 0) return response.sendStatus(200).end();
        const deletableThreads = await WorkspaceThread.where({
          slug: { in: deletableSlugs },
          user_id: user?.id ?? null,
          workspace_id: workspace.id,
        });
        await WorkspaceThread.delete({
          slug: { in: deletableSlugs },
          user_id: user?.id ?? null,
          workspace_id: workspace.id,
        });
        const clientContext = getClientContext(request, { user });
        deletableThreads.forEach((thread) => {
          publishWorkspaceSyncEvent({
            type: "thread_deleted",
            workspaceId: workspace.id,
            workspaceSlug: workspace.slug,
            userId: user?.id ?? null,
            threadId: thread.id,
            threadSlug: thread.slug,
            senderClientId: clientContext.clientId,
          });
        });
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500).end();
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
        const syncMetadata = await threadHistorySyncMetadata(thread, user);
        attachHistorySyncHeaders(response, syncMetadata);
        if (
          !historyOptions.beforeChatId &&
          !historyOptions.afterChatId &&
          !historyOptions.anchorChatId &&
          requestMatchesHistoryETag(request, syncMetadata.historyFingerprint)
        ) {
          return response.status(304).end();
        }
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
          ...(historyOptions.afterChatId
            ? { id: { gt: historyOptions.afterChatId } }
            : {}),
        };
        const anchoredHistory = historyOptions.anchorChatId
          ? await anchoredChatHistory(baseClause, historyOptions)
          : null;
        const orderedHistory = anchoredHistory
          ? anchoredHistory.history
          : await pagedChatHistory(baseClause, whereClause, historyOptions);
        const lightChatIds = lightChatIdsForHistory(
          orderedHistory,
          historyOptions
        );
        const page = historyOptions.enabled
          ? anchoredHistory?.page ||
            (await historyPageMeta(baseClause, orderedHistory, historyOptions))
          : null;

        response.status(200).json({
          history: await convertToChatHistoryWithExecution(orderedHistory, {
            lightChatIds,
            userId: response.locals.user?.id || null,
            workspaceId: workspace.id,
            threadId: thread.id,
          }),
          historyFingerprint: syncMetadata.historyFingerprint,
          historyRevision: syncMetadata.historyRevision,
          ...(page
            ? { page: { ...page, lightChatIds: [...lightChatIds] } }
            : {}),
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/thread/:threadSlug/bootstrap",
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
        const syncMetadata = await threadHistorySyncMetadata(thread, user);
        attachHistorySyncHeaders(response, syncMetadata);
        if (
          requestMatchesHistoryETag(request, syncMetadata.historyFingerprint)
        ) {
          return response.status(304).end();
        }
        const historyOptions = {
          ...parseHistoryQuery(request),
          enabled: true,
        };
        const baseClause = {
          workspaceId: workspace.id,
          user_id: user?.id || null,
          thread_id: thread.id,
          api_session_id: null,
          include: true,
        };
        const whereClause = {
          ...baseClause,
          ...(historyOptions.beforeChatId
            ? { id: { lt: historyOptions.beforeChatId } }
            : {}),
          ...(historyOptions.afterChatId
            ? { id: { gt: historyOptions.afterChatId } }
            : {}),
        };
        const anchoredHistory = historyOptions.anchorChatId
          ? await anchoredChatHistory(baseClause, historyOptions)
          : null;
        const orderedHistory = anchoredHistory
          ? anchoredHistory.history
          : await pagedChatHistory(baseClause, whereClause, historyOptions);
        const lightChatIds = lightChatIdsForHistory(
          orderedHistory,
          historyOptions
        );
        const page =
          anchoredHistory?.page ||
          (await historyPageMeta(baseClause, orderedHistory, historyOptions));

        response.status(200).json({
          success: true,
          workspace: {
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
          },
          thread: {
            ...thread,
            historyFingerprint: syncMetadata.historyFingerprint,
            historyRevision: syncMetadata.historyRevision,
          },
          history: await convertToChatHistoryWithExecution(orderedHistory, {
            lightChatIds,
            userId: response.locals.user?.id || null,
            workspaceId: workspace.id,
            threadId: thread.id,
          }),
          historyFingerprint: syncMetadata.historyFingerprint,
          historyRevision: syncMetadata.historyRevision,
          page: { ...page, lightChatIds: [...lightChatIds] },
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500).end();
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
        const { chatIds = [], publicChatIds = [] } = reqBody(request);
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;

        if (!Array.isArray(chatIds)) {
          response.sendStatus(400).end();
          return;
        }

        const identifierWhere = chatIdentifiersWhere(
          chatIdentifierPayload({ chatIds, publicChatIds })
        );
        if (!identifierWhere) {
          response.status(200).json({
            history: [],
            hydratedChatIds: [],
            hydratedPublicChatIds: [],
          });
          return;
        }

        const history = await WorkspaceChats.where(
          {
            workspaceId: workspace.id,
            user_id: user?.id || null,
            thread_id: thread.id,
            api_session_id: null,
            include: true,
            ...identifierWhere,
          },
          null,
          { id: "asc" },
          null,
          {
            attachmentMode:
              readRequestHeader(request, "X-Athena-Chat-Payload-Version") ===
              "2"
                ? "reference"
                : "inline",
          }
        );

        response.status(200).json({
          history: await convertToChatHistoryWithExecution(history, {
            userId: response.locals.user?.id || null,
            workspaceId: workspace.id,
            threadId: thread.id,
          }),
          hydratedChatIds: history.map((chat) => chat.id),
          hydratedPublicChatIds: history
            .map((chat) => chat.public_id)
            .filter(Boolean),
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500).end();
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
      let receiptContext = null;
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const requestData = reqBody(request) || {};
        const sourceActionId = compactActionId(requestData.sourceActionId);
        const data = { ...requestData };
        delete data.sourceActionId;
        const baseVersion = Number(
          request.headers?.["if-match"] ?? data.baseVersion
        );
        const changedPaths = Array.isArray(data.changedPaths)
          ? data.changedPaths
          : Object.keys(data).filter(
              (key) => !["baseVersion", "changedPaths"].includes(key)
            );
        delete data.baseVersion;
        delete data.changedPaths;
        const mutationAction = Object.prototype.hasOwnProperty.call(
          data,
          "chatModel"
        )
          ? "thread.model.update"
          : "thread.rename";
        if (
          Object.prototype.hasOwnProperty.call(data, "chatModel") &&
          !isSupportedThreadChatModel(data.chatModel)
        ) {
          return response.status(400).json({
            thread: null,
            message: "Unsupported thread chat model.",
          });
        }
        const currentThread = response.locals.thread;
        let receiptLeaseOwner = null;
        if (sourceActionId) {
          const reservation = await MutationReceipt.reserve({
            userId: user?.id,
            sourceActionId,
            action: mutationAction,
            workspaceId: workspace.id,
            threadId: currentThread.id,
          });
          receiptLeaseOwner = reservation.leaseOwner;
          if (reservation.created) {
            receiptContext = {
              userId: user?.id,
              sourceActionId,
              leaseOwner: receiptLeaseOwner,
            };
          }
          if (!reservation.created) {
            if (reservation.receipt?.status === "failed") {
              return response.status(409).json({
                thread: currentThread,
                message:
                  reservation.receipt.errorCode || "thread_update_failed",
              });
            }
            return response.status(200).json({
              thread: currentThread,
              message: null,
              replayed: true,
              pending: reservation.receipt?.status !== "completed",
            });
          }
        }
        const clientContext = getClientContext(request, { user });
        const syncContext = {
          baseVersion: Number.isInteger(baseVersion) ? baseVersion : null,
          changedPaths,
          originClientId: clientContext.clientId,
          mutationId:
            sourceActionId ||
            compactActionId(request.headers?.["idempotency-key"]),
        };
        const updateArgs = [currentThread, data];
        if (syncContext.baseVersion !== null || syncContext.mutationId) {
          updateArgs.push(syncContext);
        }
        const { thread, message } = await WorkspaceThread.update(...updateArgs);
        if (thread) {
          if (sourceActionId) {
            await MutationReceipt.complete({
              userId: user?.id,
              sourceActionId,
              leaseOwner: receiptLeaseOwner,
              resource: {
                workspaceId: workspace.id,
                workspaceSlug: workspace.slug,
                threadId: thread.id,
                threadSlug: thread.slug,
              },
            });
          }
          receiptContext = null;
          publishWorkspaceSyncEvent({
            type: "thread_updated",
            workspaceId: workspace.id,
            workspaceSlug: workspace.slug,
            userId: user?.id ?? null,
            threadId: thread.id,
            threadSlug: thread.slug,
            ...(changedPaths.includes("name")
              ? {
                  threadName: thread.isUntitled ? "" : thread.name,
                  title: thread.isUntitled ? null : thread.title || thread.name,
                  isUntitled: thread.isUntitled === true,
                  titleSource: thread.titleSource,
                  titleGenerationStatus: thread.titleGenerationStatus,
                  titleVersion: thread.titleVersion,
                }
              : {}),
            threadType: thread.thread_type,
            ...(changedPaths.includes("chatModel")
              ? { chatModel: thread.chatModel }
              : {}),
            senderClientId: clientContext.clientId,
            sourceActionId,
          });
        } else if (receiptContext) {
          await MutationReceipt.fail({
            ...receiptContext,
            errorCode: "thread_update_failed",
          });
          receiptContext = null;
        }
        response.status(200).json({ thread, message });
      } catch (e) {
        if (receiptContext) {
          await MutationReceipt.fail({
            ...receiptContext,
            errorCode: e?.code || "thread_update_failed",
          }).catch((receiptError) => {
            console.error(
              "[MutationReceipt] Failed to settle thread update",
              receiptError
            );
          });
          receiptContext = null;
        }
        if (e?.code === "state_version_conflict") {
          return response.status(409).json({
            error: "state_version_conflict",
            expectedVersion: e.expectedVersion,
            current: e.syncNode || null,
          });
        }
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/move",
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
        const { targetWorkspaceSlug = null } = reqBody(request);

        if (!targetWorkspaceSlug) {
          return response.status(400).json({
            success: false,
            error: "targetWorkspaceSlug is required.",
          });
        }

        if (Number(thread.workspace_id) !== Number(workspace.id)) {
          return response.status(404).json({
            success: false,
            error: "Workspace thread does not exist.",
          });
        }

        if (WorkspaceThread.isOverviewThread(thread)) {
          return response.status(400).json({
            success: false,
            error: "Overview thread cannot be moved.",
          });
        }

        if (String(targetWorkspaceSlug) === String(workspace.slug)) {
          return response.status(400).json({
            success: false,
            error: "Thread is already in the target workspace.",
          });
        }

        const targetWorkspace = await accessibleWorkspaceBySlug(
          response,
          user,
          targetWorkspaceSlug
        );
        if (!targetWorkspace) {
          return response.status(404).json({
            success: false,
            error: "Target workspace does not exist.",
          });
        }

        const connectorMapping = await WeChatGatewayThread.getByThreadSlug(
          thread.slug
        );
        if (connectorMapping) {
          return response.status(400).json({
            success: false,
            error: "Connector-managed threads cannot be moved.",
          });
        }

        const {
          thread: movedThread,
          message,
          movedChatCount = 0,
        } = await WorkspaceThread.moveToWorkspace({
          thread,
          sourceWorkspace: workspace,
          targetWorkspace,
        });
        if (message || !movedThread) {
          const status = String(message || "").includes("does not belong")
            ? 404
            : String(message || "").includes("cannot be moved") ||
                String(message || "").includes("target workspace")
              ? 400
              : 500;
          return response.status(status).json({
            success: false,
            error: message || "Failed to move thread.",
          });
        }

        await EventLogs.logEvent(
          "workspace_thread_moved",
          {
            sourceWorkspaceName: workspace?.name || "Unknown Workspace",
            targetWorkspaceName: targetWorkspace?.name || "Unknown Workspace",
            threadName: movedThread?.name || "Unknown Thread",
          },
          user?.id
        );

        const clientContext = getClientContext(request, { user });
        publishWorkspaceSyncEvent({
          type: "thread_deleted",
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          userId: user?.id ?? null,
          threadId: thread.id,
          threadSlug: thread.slug,
          senderClientId: clientContext.clientId,
        });
        publishWorkspaceSyncEvent({
          type: "thread_created",
          workspaceId: targetWorkspace.id,
          workspaceSlug: targetWorkspace.slug,
          userId: user?.id ?? null,
          threadId: movedThread.id,
          threadSlug: movedThread.slug,
          threadName: movedThread.name,
          title: movedThread.title || movedThread.name,
          threadType: movedThread.thread_type,
          chatModel: movedThread.chatModel,
          senderClientId: clientContext.clientId,
        });

        response.status(200).json({
          success: true,
          thread: movedThread,
          sourceWorkspaceSlug: workspace.slug,
          targetWorkspaceSlug: targetWorkspace.slug,
          movedChatCount,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(e.httpStatus || 500).end();
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
          sourceActionId = null,
        } = reqBody(request);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;
        const compactionUser = compactionUserFromInput(sessionUser, userId, {
          thread,
          isMultiUser: multiUserMode(response),
        });
        if (!compactionUser.ok) {
          return response.status(404).json({
            success: false,
            error: "Thread compaction scope not found.",
          });
        }
        const user = compactionUser.user;

        const result = remoteThreadMemoryEnabled()
          ? (
              await remoteThreadMemoryCompact({
                workspaceId: workspace.id,
                threadId: thread.id,
                userId: user?.id ?? null,
                apiSessionId,
                force: Boolean(force),
                mode,
                targetRatio,
                compactInstructions,
                sourceActionId:
                  compactActionId(sourceActionId) || crypto.randomUUID(),
              })
            ).result
          : await compactThread({
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

        response.status(result?.recoverable ? 503 : 200).json({
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
        response.status(e.httpStatus || 500).json({
          success: false,
          error: e.code || e.message,
          status: {
            state: "degraded",
            reasonCode: e.code || e.message,
          },
        });
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
        const compactionUser = compactionUserFromInput(sessionUser, userId, {
          thread,
          isMultiUser: multiUserMode(response),
        });
        if (!compactionUser.ok) {
          return response.status(404).json({
            success: false,
            error: "Thread compaction scope not found.",
          });
        }
        const user = compactionUser.user;
        const status = remoteThreadMemoryEnabled()
          ? (
              await remoteThreadMemoryStatus({
                workspaceId: workspace.id,
                threadId: thread.id,
                userId: user?.id ?? null,
                apiSessionId,
                historyRevision: thread.historyRevision,
              })
            ).status
          : await getThreadCompactionStatus({
              workspace,
              user,
              thread,
              apiSessionId,
              historyRevision: thread.historyRevision,
            });

        response.status(200).json({
          success: true,
          status,
        });
      } catch (e) {
        console.error(e.message, e);
        response.status(e.httpStatus || 500).json({
          success: false,
          error: e.code || e.message,
          status: {
            state: "degraded",
            reasonCode: e.code || e.message,
          },
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
    (_request, response) => {
      response.status(409).json({
        success: false,
        errorCode: "atomic_chat_mutation_required",
      });
    }
  );

  app.delete(
    "/workspace/:slug/thread/:threadSlug/chat/:identity",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;
        const user = await userFromSession(request, response);
        const sourceActionId = compactActionId(
          reqBody(request)?.sourceActionId
        );
        if (!sourceActionId) {
          return response.status(400).json({
            success: false,
            errorCode: "chat_mutation_missing_source_action",
          });
        }
        const identityWhere = chatIdentityFromRequest({
          id: request.params.identity,
        });
        if (!identityWhere) {
          return response.status(400).json({
            success: false,
            errorCode: "delete_invalid_target_chat",
          });
        }
        const result = await deleteChatTurnAndPublish({
          workspace,
          thread,
          user,
          clientContext: getClientContext(request, { user }),
          chatId: identityWhere.id || null,
          publicChatId: identityWhere.public_id || null,
          sourceActionId,
        });
        return response.status(200).json({
          success: true,
          sourceActionId,
          chatId: identityWhere.id || null,
          publicChatId: identityWhere.public_id || null,
          replayed: result.replayed,
        });
      } catch (error) {
        console.error(error.message, error);
        return response.status(chatMutationHTTPStatus(error)).json({
          success: false,
          errorCode: error.code || "chat_delete_failed",
        });
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
    (_request, response) => {
      response.status(409).json({
        success: false,
        errorCode: "atomic_chat_mutation_required",
      });
    }
  );
}

module.exports = { workspaceThreadEndpoints };
