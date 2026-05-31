import { ABORT_STREAM_EVENT } from "@/utils/chat";
import { API_BASE } from "@/utils/constants";
import { baseHeaders, safeJsonParse } from "@/utils/request";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { v4 } from "uuid";
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
    const { threads } = await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/threads`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch(() => {
        return { threads: [] };
      });

    return { threads };
  },
  titleEvents: async function (
    workspaceSlug,
    { signal = null, onThreadRename = null } = {}
  ) {
    if (!workspaceSlug) return;

    await fetchEventSource(
      `${API_BASE}/workspace/${workspaceSlug}/thread-title-events`,
      {
        method: "GET",
        headers: baseHeaders(),
        signal,
        openWhenHidden: true,
        async onopen(response) {
          if (response.ok) return;
          throw new Error(`Title event stream failed: ${response.status}`);
        },
        async onmessage(msg) {
          const event = safeJsonParse(msg.data, null);
          if (event?.action !== "rename_thread" || !event?.thread) return;
          onThreadRename?.(event.thread);
        },
        onerror(error) {
          if (signal?.aborted) return;
          console.warn("[ThreadTitle] event stream error", error.message);
          return 3_000;
        },
      }
    );
  },
  new: async function (workspaceSlug) {
    try {
      const response = await fetch(
        `${API_BASE}/workspace/${workspaceSlug}/thread/new`,
        {
          method: "POST",
          headers: baseHeaders(),
        }
      );
      const payload = await response.json().catch(() => ({}));
      const error =
        payload?.error ||
        payload?.message ||
        (!response.ok ? `Request failed with status ${response.status}` : null);
      if (error) return { thread: null, error };
      if (!payload?.thread?.slug)
        return { thread: null, error: "Invalid thread response" };
      return { thread: payload.thread, error: null };
    } catch (e) {
      return { thread: null, error: e.message };
    }
  },
  update: async function (workspaceSlug, threadSlug, data = {}) {
    const { thread, message } = await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/thread/${threadSlug}/update`,
      {
        method: "POST",
        body: JSON.stringify(data),
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((e) => {
        return { thread: null, message: e.message };
      });

    return { thread, message };
  },
  delete: async function (workspaceSlug, threadSlug) {
    return await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/thread/${threadSlug}`,
      {
        method: "DELETE",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.ok)
      .then((ok) => {
        if (ok) threadHistoryCache.invalidateThread(workspaceSlug, threadSlug);
        return ok;
      })
      .catch(() => false);
  },
  deleteBulk: async function (workspaceSlug, threadSlugs = []) {
    return await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/thread-bulk-delete`,
      {
        method: "DELETE",
        body: JSON.stringify({ slugs: threadSlugs }),
        headers: baseHeaders(),
      }
    )
      .then((res) => res.ok)
      .then((ok) => {
        if (ok) {
          threadSlugs.forEach((threadSlug) =>
            threadHistoryCache.invalidateThread(workspaceSlug, threadSlug)
          );
        }
        return ok;
      })
      .catch(() => false);
  },
  chatHistory: async function (workspaceSlug, threadSlug, options = {}) {
    const history = await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/thread/${threadSlug}/chats`,
      {
        method: "GET",
        headers: baseHeaders(),
        signal: options.signal,
      }
    )
      .then((res) => res.json())
      .then((res) => res.history || [])
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return [];
      });
    return history;
  },
  chatHistoryPage: async function (workspaceSlug, threadSlug, options = {}) {
    const query = historyPageQuery(options);
    const payload = await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/thread/${threadSlug}/chats?${query}`,
      {
        method: "GET",
        headers: baseHeaders(),
        signal: options.signal,
      }
    )
      .then((res) => res.json())
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
    if (!chatIds.length) return { history: [], hydratedChatIds: [] };
    const payload = await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/thread/${threadSlug}/chats/hydrate`,
      {
        method: "POST",
        headers: baseHeaders(),
        signal: options.signal,
        body: JSON.stringify({ chatIds }),
      }
    )
      .then((res) => res.json())
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return { history: [], hydratedChatIds: [] };
      });
    return {
      history: payload.history || [],
      hydratedChatIds: payload.hydratedChatIds || [],
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
    return await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/thread/${threadSlug}/compact/status${query ? `?${query}` : ""}`,
      {
        method: "GET",
        headers: baseHeaders(),
        signal,
      }
    )
      .then((res) => res.json())
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
    return await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/thread/${threadSlug}/compact`,
      {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify(body),
        signal,
      }
    )
      .then((res) => res.json())
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return { success: false, error: error.message };
      });
  },
  streamChat: async function (
    { workspaceSlug, threadSlug },
    message,
    handleChat,
    attachments = [],
    fileAccessMode = null,
    nodeContext = null
  ) {
    const ctrl = new AbortController();

    // Listen for the ABORT_STREAM_EVENT key to be emitted by the client
    // to early abort the streaming response. On abort we send a special `stopGeneration`
    // event to be handled which resets the UI for us to be able to send another message.
    // The backend response abort handling is done in each LLM's handleStreamResponse.
    const abortStream = () => {
      ctrl.abort();
      handleChat({ id: v4(), type: "stopGeneration" });
    };
    window.addEventListener(ABORT_STREAM_EVENT, abortStream);

    try {
      await fetchEventSource(
        `${API_BASE}/workspace/${workspaceSlug}/thread/${threadSlug}/stream-chat`,
        {
          method: "POST",
          body: JSON.stringify({
            message,
            attachments,
            fileAccess: { mode: fileAccessMode },
            nodeContext,
          }),
          headers: baseHeaders(),
          signal: ctrl.signal,
          openWhenHidden: true,
          async onopen(response) {
            if (response.ok) {
              return; // everything's good
            } else if (
              response.status >= 400 &&
              response.status < 500 &&
              response.status !== 429
            ) {
              handleChat({
                id: v4(),
                type: "abort",
                textResponse: null,
                sources: [],
                close: true,
                error: `An error occurred while streaming response. Code ${response.status}`,
              });
              ctrl.abort();
              throw new Error("Invalid Status code response.");
            } else {
              handleChat({
                id: v4(),
                type: "abort",
                textResponse: null,
                sources: [],
                close: true,
                error: `An error occurred while streaming response. Unknown Error.`,
              });
              ctrl.abort();
              throw new Error("Unknown error");
            }
          },
          async onmessage(msg) {
            const chatResult = safeJsonParse(msg.data, null);
            if (chatResult) handleChat(chatResult);
          },
          onerror(err) {
            handleChat({
              id: v4(),
              type: "abort",
              textResponse: null,
              sources: [],
              close: true,
              error: `An error occurred while streaming response. ${err.message}`,
            });
            ctrl.abort();
            throw new Error();
          },
        }
      );
    } finally {
      window.removeEventListener(ABORT_STREAM_EVENT, abortStream);
    }
  },
  _deleteEditedChats: async function (
    workspaceSlug = "",
    threadSlug = "",
    startingId
  ) {
    return await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/thread/${threadSlug}/delete-edited-chats`,
      {
        method: "DELETE",
        headers: baseHeaders(),
        body: JSON.stringify({ startingId }),
      }
    )
      .then((res) => {
        if (res.ok) {
          threadHistoryCache.invalidateThread(workspaceSlug, threadSlug);
          return true;
        }
        throw new Error("Failed to delete chats.");
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
    return await fetch(
      `${API_BASE}/workspace/${workspaceSlug}/thread/${threadSlug}/update-chat`,
      {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ chatId, newText, role }),
      }
    )
      .then((res) => {
        if (res.ok) {
          threadHistoryCache.invalidateThread(workspaceSlug, threadSlug);
          return true;
        }
        throw new Error("Failed to update chat.");
      })
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
};

export default WorkspaceThread;
