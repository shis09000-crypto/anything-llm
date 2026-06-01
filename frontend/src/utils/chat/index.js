import { THREAD_RENAME_EVENT } from "@/components/Sidebar/ActiveWorkspaces/ThreadContainer";
import {
  debugChatTurn,
  normalizedEventSummary,
  rawEventSummary,
} from "@/utils/chat/debug";

export const ABORT_STREAM_EVENT = "abort-chat-stream";

export function dispatchThreadRename(thread) {
  if (!thread?.slug || !thread?.name) return;
  window.dispatchEvent(
    new CustomEvent(THREAD_RENAME_EVENT, {
      detail: {
        threadSlug: thread.slug,
        newName: thread.name,
        title: thread.title || thread.name,
        titleVersion: thread.titleVersion,
        animate: !!thread.animate,
      },
    })
  );
}

export default function handleChat(chatResult = {}) {
  const {
    uuid,
    textResponse,
    type,
    sources = [],
    error,
    close,
    animate = false,
    chatId = null,
    action = null,
    metrics = {},
    websocketUUID = null,
    thread = null,
  } = chatResult;

  let normalized = null;

  if (action === "rename_thread") dispatchThreadRename(thread);

  if (type === "agentInitWebsocketConnection") {
    normalized = {
      type: "agent_socket_start",
      websocketUUID,
    };
    debugChatTurn("normalize:event", {
      ...rawEventSummary(chatResult, "SSE"),
      ...normalizedEventSummary(normalized, "SSE"),
    });
    return normalized;
  }

  if (type === "statusResponse") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "thought",
        uuid,
        content: textResponse || "",
        animate,
      },
    };
    debugChatTurn("normalize:event", {
      ...rawEventSummary(chatResult, "SSE"),
      ...normalizedEventSummary(normalized, "SSE"),
    });
    return normalized;
  }

  if (type === "textResponseChunk") {
    if (close) {
      normalized = {
        type: "assistant_final",
        uuid,
        content: textResponse || "",
        sources,
        chatId,
        metrics,
        closed: true,
      };
      debugChatTurn("normalize:event", {
        ...rawEventSummary(chatResult, "SSE"),
        ...normalizedEventSummary(normalized, "SSE"),
      });
      return normalized;
    }

    normalized = {
      type: "assistant_delta",
      uuid,
      content: textResponse || "",
      sources,
      closed: !!close,
      chatId,
      metrics,
    };
    debugChatTurn("normalize:event", {
      ...rawEventSummary(chatResult, "SSE"),
      ...normalizedEventSummary(normalized, "SSE"),
    });
    return normalized;
  }

  if (type === "textResponse" || type === "finalizeResponseStream") {
    normalized = {
      type: "assistant_final",
      uuid,
      content: textResponse || "",
      sources,
      chatId,
      metrics,
      closed: !!close,
    };
    debugChatTurn("normalize:event", {
      ...rawEventSummary(chatResult, "SSE"),
      ...normalizedEventSummary(normalized, "SSE"),
    });
    return normalized;
  }

  if (type === "abort") {
    normalized = {
      type: "assistant_error",
      uuid,
      content: error || textResponse || "Stream aborted.",
      error: error || textResponse || "Stream aborted.",
    };
    debugChatTurn("normalize:event", {
      ...rawEventSummary(chatResult, "SSE"),
      ...normalizedEventSummary(normalized, "SSE"),
    });
    return normalized;
  }

  if (type === "stopGeneration") {
    normalized = {
      type: "stop_generation",
      uuid,
      content: "Generation stopped by user.",
    };
    debugChatTurn("normalize:event", {
      ...rawEventSummary(chatResult, "SSE"),
      ...normalizedEventSummary(normalized, "SSE"),
    });
    return normalized;
  }

  if (type === "wssFailure") {
    normalized = {
      type: "assistant_error",
      uuid,
      content: error || textResponse || "Websocket connection failed.",
      error: error || textResponse || "Websocket connection failed.",
    };
    debugChatTurn("normalize:event", {
      ...rawEventSummary(chatResult, "SSE"),
      ...normalizedEventSummary(normalized, "SSE"),
    });
    return normalized;
  }

  if (action === "reset_chat") {
    normalized = { type: "reset_chat" };
    debugChatTurn("normalize:event", {
      ...rawEventSummary(chatResult, "SSE"),
      ...normalizedEventSummary(normalized, "SSE"),
    });
    return normalized;
  }

  debugChatTurn("normalize:event", {
    ...rawEventSummary(chatResult, "SSE"),
    normalizedType: null,
  });
  return null;
}

export function getWorkspaceSystemPrompt(workspace) {
  return (
    workspace?.openAiPrompt ??
    "请根据以下 conversation、relevant context 和用户的 follow-up question，回答用户当前正在询问的问题。请只输出对当前问题的回答，并在需要时遵循用户的 instructions。\n\n当用户要求向量化文件时，优先使用 document-ingest-agent 的 document_identifiers 批量路径，而非 rag-memory store。"
  );
}

export function chatQueryRefusalResponse(workspace) {
  return (
    workspace?.queryRefusalResponse ??
    "There is no relevant information in this workspace to answer your query."
  );
}
