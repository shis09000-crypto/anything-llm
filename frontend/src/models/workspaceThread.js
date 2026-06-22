import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorMessage as failureMessage } from "@/lib/communication/apiError";
import { streamThreadTitleEvents } from "@/lib/communication/workspaceRealtimeClient";
import { threadHistoryCache } from "@/utils/chat/threadHistoryCache";

function historyPageQuery({
  limit = 20,
  beforeChatId = null,
  detail = "light",
  priorityWindow = 5,
} = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("detail", detail);
  params.set("priorityWindow", String(priorityWindow));
  if (beforeChatId) params.set("beforeChatId", String(beforeChatId));
  return params.toString();
}

const WorkspaceThread = {
  all: async function (workspaceSlug) {
    const { threads, defaultThreads } = await getJson(
      `/workspace/${workspaceSlug}/threads`
    )
      .then(({ data }) => data)
      .catch(() => {
        return { threads: [], defaultThreads: null };
      });

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
  new: async function (workspaceSlug) {
    try {
      const { data: payload } = await postJson(
        `/workspace/${workspaceSlug}/thread/new`
      );
      const error = payload?.error || payload?.message || null;
      if (error) return { thread: null, error };
      if (!payload?.thread?.slug)
        return { thread: null, error: "Invalid thread response" };
      return { thread: payload.thread, error: null };
    } catch (e) {
      return { thread: null, error: failureMessage(e) };
    }
  },
  update: async function (workspaceSlug, threadSlug, data = {}) {
    const { thread, message } = await postJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/update`,
      data
    )
      .then(({ data }) => data)
      .catch((e) => {
        return { thread: null, message: e.message };
      });

    return { thread, message };
  },
  move: async function (workspaceSlug, threadSlug, targetWorkspaceSlug) {
    try {
      const { data: payload } = await postJson(
        `/workspace/${workspaceSlug}/thread/${threadSlug}/move`,
        { targetWorkspaceSlug }
      );
      const error = payload?.error || payload?.message || null;
      if (error) return { success: false, error, thread: null };

      threadHistoryCache.invalidateThread(workspaceSlug, threadSlug);
      threadHistoryCache.invalidateThread(targetWorkspaceSlug, threadSlug);
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
  delete: async function (workspaceSlug, threadSlug) {
    return await deleteJson(`/workspace/${workspaceSlug}/thread/${threadSlug}`)
      .then(() => {
        threadHistoryCache.invalidateThread(workspaceSlug, threadSlug);
        return true;
      })
      .catch(() => false);
  },
  deleteBulk: async function (workspaceSlug, threadSlugs = []) {
    return await deleteJson(`/workspace/${workspaceSlug}/thread-bulk-delete`, {
      body: { slugs: threadSlugs },
    })
      .then(() => {
        threadSlugs.forEach((threadSlug) =>
          threadHistoryCache.invalidateThread(workspaceSlug, threadSlug)
        );
        return true;
      })
      .catch(() => false);
  },
  chatHistory: async function (workspaceSlug, threadSlug, options = {}) {
    const history = await getJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/chats`,
      { signal: options.signal }
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
    const payload = await getJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/chats?${query}`,
      { signal: options.signal }
    )
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return { history: [], page: null };
      });
    return {
      history: payload.history || [],
      page: payload.page || null,
    };
  },
  chatHistoryHydration: async function (
    workspaceSlug,
    threadSlug,
    chatIds = [],
    options = {}
  ) {
    if (!chatIds.length)
      return { history: [], hydratedChatIds: [], hydratedPublicChatIds: [] };
    const payload = await postJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/chats/hydrate`,
      { chatIds },
      { signal: options.signal }
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
    { userId = undefined, apiSessionId = undefined, signal } = {}
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
      { signal }
    )
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return { success: false, status: null, error: error.message };
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
      signal,
    } = {}
  ) {
    if (!workspaceSlug || !threadSlug)
      return { success: false, error: "Missing thread." };
    const body = {};
    if (userId !== undefined) body.userId = userId;
    if (apiSessionId !== undefined) body.apiSessionId = apiSessionId;
    if (mode !== undefined) body.mode = mode;
    if (targetRatio !== undefined) body.targetRatio = targetRatio;
    return await postJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/compact`,
      body,
      { signal }
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
    startingId
  ) {
    return await deleteJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/delete-edited-chats`,
      { body: { startingId } }
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
    role = "assistant"
  ) {
    return await postJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/update-chat`,
      { chatId, newText, role }
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
