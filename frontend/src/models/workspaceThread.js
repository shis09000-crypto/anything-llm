import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorMessage as failureMessage } from "@/lib/communication/apiError";
import { streamThreadTitleEvents } from "@/lib/communication/workspaceRealtimeClient";
import { threadHistoryCache } from "@/utils/chat/threadHistoryCache";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { submitProjectedSyncMutation } from "@/utils/syncV2/syncV2ProjectedMutation";

const SYNC_V2_THREAD_METADATA_FIELDS = ["name", "chatModel"];
const CHAT_PAYLOAD_HEADERS = { "X-Athena-Chat-Payload-Version": "2" };

function cachedThread(workspaceSlug, threadSlug) {
  return (
    workspaceNavigationCache
      .getThreads(workspaceSlug, { allowStale: true })
      ?.find((thread) => thread.slug === threadSlug) || null
  );
}

async function syncV2ThreadIndex(workspaceSlug, options = {}) {
  if (options.preferSyncV2Cache !== true || options.includeArchived)
    return null;
  try {
    const { syncV2Runtime } = await import("@/utils/syncV2/syncV2Runtime");
    const result = await syncV2Runtime.bootstrap({ signal: options.signal });
    if (!result?.enabled) return null;
    return workspaceNavigationCache.getThreads(workspaceSlug, {
      allowStale: true,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return null;
  }
}

async function updateThreadWithSyncV2(
  workspaceSlug,
  threadSlug,
  data,
  options = {}
) {
  const current = cachedThread(workspaceSlug, threadSlug);
  if (!Number.isInteger(Number(current?.id))) return null;
  const submitted = await submitProjectedSyncMutation(
    {
      nodeKey: `threads/${Number(current.id)}/metadata`,
      payload: data,
      allowedFields: SYNC_V2_THREAD_METADATA_FIELDS,
    },
    {
      allowOffline: options.allowOffline !== false,
      signal: options.signal,
    }
  );
  if (!submitted) return null;
  const thread = { ...current, ...data };
  workspaceNavigationCache.updateThread(workspaceSlug, thread);
  return {
    thread,
    message: null,
    queued: submitted.result?.queued === true,
  };
}

function threadTask({
  label,
  workspaceSlug = null,
  threadSlug = null,
  surface = "thread",
  priority = "P1",
  policy = null,
  protectedTask = false,
  abortable = null,
  intentRank = undefined,
} = {}) {
  return {
    label,
    kind: "workspace-thread",
    priority,
    policy:
      policy ||
      (priority === "P0"
        ? "foreground"
        : priority === "P4"
          ? "maintenance"
          : "visible"),
    resource: "network",
    protected: protectedTask,
    abortable:
      abortable !== null && abortable !== undefined
        ? abortable
        : !protectedTask,
    ...(intentRank !== undefined ? { intentRank } : {}),
    scope: {
      route: "workspace-chat",
      surface,
      ...(workspaceSlug ? { workspaceSlug } : {}),
      ...(threadSlug ? { threadSlug } : {}),
    },
  };
}

function threadUserActionTask(
  label,
  workspaceSlug,
  threadSlug = null,
  intentRank = 0
) {
  return threadTask({
    label,
    workspaceSlug,
    threadSlug,
    surface: "thread-action",
    priority: "P0",
    protectedTask: true,
    abortable: false,
    intentRank,
  });
}

function historyPageQuery({
  limit = 20,
  beforeChatId = null,
  afterChatId = null,
  anchorChatId = null,
  detail = "light",
  priorityWindow = 5,
} = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("detail", detail);
  params.set("priorityWindow", String(priorityWindow));
  if (beforeChatId) params.set("beforeChatId", String(beforeChatId));
  if (afterChatId) params.set("afterChatId", String(afterChatId));
  if (anchorChatId) params.set("anchorChatId", String(anchorChatId));
  return params.toString();
}

const WorkspaceThread = {
  all: async function (workspaceSlug, options = {}) {
    const projected = await syncV2ThreadIndex(workspaceSlug, options);
    if (Array.isArray(projected)) {
      return { threads: projected, defaultThreads: null };
    }
    const query = options.includeArchived ? "?includeArchived=true" : "";
    const { threads, defaultThreads } = await getJson(
      `/workspace/${workspaceSlug}/threads${query}`,
      {
        signal: options.signal,
        headers: CHAT_PAYLOAD_HEADERS,
        communicationScene:
          options.communicationScene || "workspace-navigation",
        task: options.task,
      }
    )
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return { threads: [], defaultThreads: null };
      });
    if (Array.isArray(threads) && !options.includeArchived)
      workspaceNavigationCache.setThreads(workspaceSlug, threads);

    return { threads, defaultThreads };
  },
  titleEvents: async function (
    workspaceSlug,
    { signal = null, onThreadRename = null } = {}
  ) {
    return streamThreadTitleEvents({
      workspaceSlug,
      signal,
      onThreadRename,
    });
  },
  new: async function (workspaceSlug, options = {}) {
    try {
      const { data: payload } = await postJson(
        `/workspace/${workspaceSlug}/thread/new`,
        {},
        {
          signal: options.signal,
          communicationScene:
            options.communicationScene || "workspace-thread-create",
          task:
            options.task === undefined
              ? threadUserActionTask("thread:create", workspaceSlug, null, 2)
              : options.task,
        }
      );
      const error = payload?.error || payload?.message || null;
      if (error) return { thread: null, error };
      if (!payload?.thread?.slug)
        return { thread: null, error: "Invalid thread response" };
      if (!options.skipCacheUpdate) {
        workspaceNavigationCache.updateThread(workspaceSlug, payload.thread);
      }
      return { thread: payload.thread, error: null };
    } catch (e) {
      return { thread: null, error: failureMessage(e) };
    }
  },
  update: async function (workspaceSlug, threadSlug, data = {}, options = {}) {
    try {
      const synced = await updateThreadWithSyncV2(
        workspaceSlug,
        threadSlug,
        data,
        options
      );
      if (synced) return synced;
    } catch (error) {
      return {
        thread: null,
        message: error?.message || "Thread update failed",
      };
    }
    const { thread, message } = await postJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/update`,
      data,
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-thread-action",
        task:
          options.task === undefined
            ? threadUserActionTask("thread:update", workspaceSlug, threadSlug)
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => {
        return { thread: null, message: e.message };
      });

    if (thread?.slug)
      workspaceNavigationCache.updateThread(workspaceSlug, thread);
    return { thread, message };
  },
  archive: async function (workspaceSlug, threadSlug) {
    return postJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/archive`,
      {},
      {
        communicationScene: "workspace-thread-action",
        task: threadUserActionTask("thread:archive", workspaceSlug, threadSlug),
      }
    )
      .then(({ data }) => data)
      .catch((error) => ({ success: false, error: failureMessage(error) }));
  },
  restore: async function (workspaceSlug, threadSlug) {
    return postJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/restore`,
      {},
      {
        communicationScene: "workspace-thread-action",
        task: threadUserActionTask("thread:restore", workspaceSlug, threadSlug),
      }
    )
      .then(({ data }) => data)
      .catch((error) => ({ success: false, error: failureMessage(error) }));
  },
  move: async function (
    workspaceSlug,
    threadSlug,
    targetWorkspaceSlug,
    options = {}
  ) {
    try {
      const { data: payload } = await postJson(
        `/workspace/${workspaceSlug}/thread/${threadSlug}/move`,
        { targetWorkspaceSlug },
        {
          signal: options.signal,
          communicationScene:
            options.communicationScene || "workspace-thread-action",
          task:
            options.task === undefined
              ? threadUserActionTask("thread:move", workspaceSlug, threadSlug)
              : options.task,
        }
      );
      const error = payload?.error || payload?.message || null;
      if (error) return { success: false, error, thread: null };

      threadHistoryCache.invalidateThread(workspaceSlug, threadSlug);
      threadHistoryCache.invalidateThread(targetWorkspaceSlug, threadSlug);
      workspaceNavigationCache.removeThread(workspaceSlug, threadSlug);
      if (payload.thread?.slug)
        workspaceNavigationCache.updateThread(
          targetWorkspaceSlug,
          payload.thread
        );
      return {
        success: !!payload.success,
        thread: payload.thread || null,
        sourceWorkspaceSlug: payload.sourceWorkspaceSlug || workspaceSlug,
        targetWorkspaceSlug: payload.targetWorkspaceSlug || targetWorkspaceSlug,
        movedChatCount: payload.movedChatCount || 0,
        error: null,
      };
    } catch (e) {
      return { success: false, error: failureMessage(e), thread: null };
    }
  },
  delete: async function (workspaceSlug, threadSlug, options = {}) {
    return await deleteJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}`,
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-thread-action",
        task:
          options.task === undefined
            ? threadUserActionTask("thread:delete", workspaceSlug, threadSlug)
            : options.task,
      }
    )
      .then(() => {
        threadHistoryCache.invalidateThread(workspaceSlug, threadSlug);
        if (!options.skipCacheUpdate) {
          workspaceNavigationCache.removeThread(workspaceSlug, threadSlug);
        }
        return true;
      })
      .catch(() => false);
  },
  deleteBulk: async function (workspaceSlug, threadSlugs = [], options = {}) {
    return await deleteJson(`/workspace/${workspaceSlug}/thread-bulk-delete`, {
      body: { slugs: threadSlugs },
      signal: options.signal,
      communicationScene:
        options.communicationScene || "workspace-thread-action",
      task:
        options.task === undefined
          ? threadUserActionTask("thread:delete-bulk", workspaceSlug)
          : options.task,
    })
      .then(() => {
        threadSlugs.forEach((threadSlug) =>
          threadHistoryCache.invalidateThread(workspaceSlug, threadSlug)
        );
        if (!options.skipCacheUpdate) {
          threadSlugs.forEach((threadSlug) =>
            workspaceNavigationCache.removeThread(workspaceSlug, threadSlug)
          );
        }
        return true;
      })
      .catch(() => false);
  },
  chatHistory: async function (workspaceSlug, threadSlug, options = {}) {
    const history = await getJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/chats`,
      {
        signal: options.signal,
        communicationScene: "workspace-chat",
        task: options.task,
      }
    )
      .then(({ data }) => data.history || [])
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return [];
      });
    return history;
  },
  chatHistoryPage: async function (workspaceSlug, threadSlug, options = {}) {
    const query = historyPageQuery(options);
    const result = await getJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/chats?${query}`,
      {
        signal: options.signal,
        headers: {
          ...CHAT_PAYLOAD_HEADERS,
          ...(options.historyFingerprint
            ? { "If-None-Match": `"${options.historyFingerprint}"` }
            : {}),
        },
        acceptNotModified: true,
        communicationScene: "workspace-chat",
        task: options.task,
      }
    ).catch((error) => {
      if (error?.name === "AbortError") throw error;
      return { data: { history: [], page: null }, notModified: false };
    });
    if (result?.notModified) {
      return {
        history: options.cachedHistory || [],
        page: options.cachedPage || null,
        historyFingerprint: options.historyFingerprint,
        historyRevision: options.historyRevision ?? null,
        notModified: true,
      };
    }
    const payload = result?.data || {};
    return {
      history: payload.history || [],
      page: payload.page || null,
      historyFingerprint: payload.historyFingerprint || null,
      historyRevision: payload.historyRevision ?? null,
      notModified: false,
    };
  },
  chatBootstrap: async function (workspaceSlug, threadSlug, options = {}) {
    const query = historyPageQuery(options);
    const payload = await getJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/bootstrap?${query}`,
      {
        signal: options.signal,
        headers: CHAT_PAYLOAD_HEADERS,
        communicationScene: "workspace-chat",
        task: options.task,
      }
    )
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return null;
      });
    if (!payload?.success)
      return this.chatHistoryPage(workspaceSlug, threadSlug, options);
    return {
      workspace: payload.workspace || null,
      thread: payload.thread || null,
      history: payload.history || [],
      page: payload.page || null,
      historyFingerprint: payload.historyFingerprint || null,
      historyRevision: payload.historyRevision ?? null,
    };
  },
  chatHistoryHydration: async function (
    workspaceSlug,
    threadSlug,
    chatIds = [],
    options = {}
  ) {
    const publicChatIds = options.publicChatIds || [];
    if (!chatIds.length && !publicChatIds.length)
      return { history: [], hydratedChatIds: [], hydratedPublicChatIds: [] };
    const payload = await postJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/chats/hydrate`,
      { chatIds, publicChatIds },
      {
        signal: options.signal,
        headers: CHAT_PAYLOAD_HEADERS,
        communicationScene: "workspace-chat",
        task: options.task,
      }
    )
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return { history: [], hydratedChatIds: [], hydratedPublicChatIds: [] };
      });
    return {
      history: payload.history || [],
      hydratedChatIds: payload.hydratedChatIds || [],
      hydratedPublicChatIds: payload.hydratedPublicChatIds || [],
    };
  },
  compactionStatus: async function (
    workspaceSlug,
    threadSlug,
    {
      userId = undefined,
      apiSessionId = undefined,
      signal,
      task = undefined,
    } = {}
  ) {
    if (!workspaceSlug || !threadSlug)
      return { success: false, status: null, error: "Missing thread." };
    const params = new URLSearchParams();
    if (userId !== undefined)
      params.set("userId", userId === null ? "null" : String(userId));
    if (apiSessionId !== undefined)
      params.set(
        "apiSessionId",
        apiSessionId === null ? "null" : String(apiSessionId)
      );
    const query = params.toString();
    return await getJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/compact/status${query ? `?${query}` : ""}`,
      {
        signal,
        communicationScene: "workspace-chat-maintenance",
        task:
          task === undefined
            ? threadTask({
                label: "thread:compaction-status",
                workspaceSlug,
                threadSlug,
                surface: "thread-compaction",
                priority: "P2",
                policy: "background",
              })
            : task,
      }
    )
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        const raw =
          error?.raw && typeof error.raw === "object" ? error.raw : null;
        return {
          success: false,
          status: raw?.status || {
            state: "degraded",
            reasonCode: raw?.error || error.message,
          },
          error: raw?.error || error.message,
        };
      });
  },
  compact: async function (
    workspaceSlug,
    threadSlug,
    {
      userId = undefined,
      apiSessionId = undefined,
      mode = undefined,
      targetRatio = undefined,
      sourceActionId = undefined,
      signal,
      task = undefined,
    } = {}
  ) {
    if (!workspaceSlug || !threadSlug)
      return { success: false, error: "Missing thread." };
    const body = {};
    if (userId !== undefined) body.userId = userId;
    if (apiSessionId !== undefined) body.apiSessionId = apiSessionId;
    if (mode !== undefined) body.mode = mode;
    if (targetRatio !== undefined) body.targetRatio = targetRatio;
    body.sourceActionId =
      sourceActionId ||
      globalThis.crypto?.randomUUID?.() ||
      `thread-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return await postJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/compact`,
      body,
      {
        signal,
        communicationScene: "workspace-thread-action",
        task:
          task === undefined
            ? threadUserActionTask("thread:compact", workspaceSlug, threadSlug)
            : task,
      }
    )
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return { success: false, error: error.message };
      });
  },
  _deleteEditedChats: async function (
    workspaceSlug = "",
    threadSlug = "",
    startingId,
    options = {}
  ) {
    return await deleteJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/delete-edited-chats`,
      {
        body: { startingId },
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-thread-action",
        task:
          options.task === undefined
            ? threadUserActionTask(
                "thread:delete-edited-chats",
                workspaceSlug,
                threadSlug
              )
            : options.task,
      }
    )
      .then(() => {
        threadHistoryCache.invalidateThread(workspaceSlug, threadSlug);
        return true;
      })
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
  _updateChat: async function (
    workspaceSlug = "",
    threadSlug = "",
    chatId,
    newText,
    role = "assistant",
    options = {}
  ) {
    return await postJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/update-chat`,
      { chatId, newText, role },
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-thread-action",
        task:
          options.task === undefined
            ? threadUserActionTask(
                "thread:update-chat",
                workspaceSlug,
                threadSlug
              )
            : options.task,
      }
    )
      .then(() => {
        threadHistoryCache.invalidateThread(workspaceSlug, threadSlug);
        return true;
      })
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
};

export default WorkspaceThread;
