import {
  debugChatTurn,
  normalizedEventSummary,
  rawEventSummary,
} from "@/utils/chat/debug";

export const CHAT_PROTOCOL_VERSION = 1;

function streamEvent(type, raw = {}, payload = {}) {
  return {
    type,
    rawType: raw?.type || raw?.action || null,
    payload,
    raw,
    chatId: raw?.chatId ?? payload?.chatId ?? null,
    publicChatId: raw?.publicChatId ?? payload?.publicChatId ?? null,
    text: raw?.textResponse ?? payload?.text ?? null,
    error: payload?.error ?? raw?.error ?? null,
  };
}

export function normalizeChatStreamEvent(raw = {}) {
  const rawType = raw?.type || raw?.action || null;

  if (rawType === "agentInitWebsocketConnection") {
    return streamEvent("agent_init", raw, {
      websocketUUID: raw.websocketUUID,
    });
  }

  if (rawType === "statusResponse") {
    return streamEvent("status", raw, {
      uuid: raw.uuid,
      text: raw.textResponse || "",
      animate: !!raw.animate,
    });
  }

  if (
    rawType === "editSessionReady" ||
    rawType === "editHistoryTruncated" ||
    rawType === "regenerateSessionReady" ||
    rawType === "regenerateTurnDeleted"
  ) {
    return streamEvent("mutation_status", raw, {
      sourceActionId: raw.sourceActionId || null,
      startingChatId: raw.startingChatId ?? null,
      targetChatId: raw.targetChatId ?? null,
    });
  }

  if (rawType === "textResponseChunk") {
    return streamEvent(
      raw.close && raw.chatId ? "final" : "assistant_delta",
      raw,
      {
        uuid: raw.uuid,
        text: raw.textResponse || "",
        sources: raw.sources || [],
        close: !!raw.close,
        chatId: raw.chatId ?? null,
        publicChatId: raw.publicChatId ?? null,
        metrics: raw.metrics || {},
      }
    );
  }

  if (rawType === "textResponse" || rawType === "finalizeResponseStream") {
    return streamEvent("final", raw, {
      uuid: raw.uuid,
      text: raw.textResponse || "",
      sources: raw.sources || [],
      close: !!raw.close,
      chatId: raw.chatId ?? null,
      publicChatId: raw.publicChatId ?? null,
      metrics: raw.metrics || {},
    });
  }

  if (rawType === "abort" || rawType === "wssFailure") {
    return streamEvent("error", raw, {
      uuid: raw.uuid,
      text: raw.textResponse || "",
      error:
        raw.error ||
        raw.textResponse ||
        (rawType === "wssFailure"
          ? "Websocket connection failed."
          : "Stream aborted."),
      errorCode: raw.errorCode || null,
    });
  }

  if (rawType === "stopGeneration") {
    return streamEvent("stop_generation", raw, {
      uuid: raw.uuid,
      text: "Generation stopped by user.",
    });
  }

  if (rawType === "timeline_event") {
    return streamEvent("status", raw, { event: raw.event });
  }

  if (
    rawType === "toolApprovalRequest" ||
    rawType === "toolCallInvocation" ||
    rawType === "toolCallResult"
  ) {
    return streamEvent("status", raw, {
      toolName: raw.toolName,
      requestId: raw.requestId,
      skillName: raw.skillName,
    });
  }

  if (raw?.action === "reset_chat") {
    return streamEvent("reset", raw, {});
  }

  return streamEvent("unknown", raw, {});
}

export function normalizeChatTurnEvent(raw = {}) {
  const normalizedStreamEvent = normalizeChatStreamEvent(raw);
  const {
    uuid,
    textResponse,
    type,
    sources = [],
    error,
    close,
    animate = false,
    chatId = null,
    publicChatId = null,
    action = null,
    metrics = {},
    websocketUUID = null,
    event = null,
    requestId = null,
    skillName = null,
    payload = null,
    description = null,
    allowAlwaysAllow = false,
    timeoutMs = null,
    requestedAt = null,
    toolName = null,
    arguments: toolArguments = {},
    result = null,
    content = null,
  } = raw;

  let normalized = null;

  if (type === "agentInitWebsocketConnection") {
    normalized = {
      type: "agent_socket_start",
      websocketUUID,
      protocolEvent: normalizedStreamEvent,
    };
  } else if (
    type === "editSessionReady" ||
    type === "editHistoryTruncated" ||
    type === "regenerateSessionReady" ||
    type === "regenerateTurnDeleted"
  ) {
    normalized = {
      type: "mutation_status",
      mutationType: type,
      sourceActionId: raw.sourceActionId || null,
      startingChatId: raw.startingChatId ?? null,
      targetChatId: raw.targetChatId ?? null,
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "statusResponse") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "thought",
        uuid,
        content: textResponse || "",
        animate,
      },
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "timeline_event" && event) {
    normalized = {
      type: "timeline_event",
      event,
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "toolApprovalRequest") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "approval_request",
        requestId,
        skillName,
        payload,
        description,
        allowAlwaysAllow: !!allowAlwaysAllow,
        timeoutMs,
        requestedAt: requestedAt || Date.now(),
        content: description || `Approval requested for ${skillName}`,
      },
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "toolCallInvocation") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "tool_call",
        uuid,
        toolName,
        arguments: toolArguments,
        content: content || `Calling ${toolName}`,
      },
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "toolCallResult") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "tool_result",
        uuid,
        toolName,
        arguments: toolArguments,
        result,
        content: content || "",
      },
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "textResponseChunk") {
    if (close && chatId) {
      normalized = {
        type: "assistant_final",
        uuid,
        content: textResponse || "",
        sources,
        chatId,
        publicChatId,
        metrics,
        closed: true,
        protocolEvent: normalizedStreamEvent,
      };
    } else if (close) {
      normalized =
        textResponse || sources.length > 0
          ? {
              type: "assistant_delta",
              uuid,
              content: textResponse || "",
              sources,
              closed: true,
              chatId,
              publicChatId,
              metrics,
              protocolEvent: normalizedStreamEvent,
            }
          : {
              type: "assistant_patch",
              uuid,
              patch: { metrics },
              closed: true,
              protocolEvent: normalizedStreamEvent,
            };
    } else {
      normalized = {
        type: "assistant_delta",
        uuid,
        content: textResponse || "",
        sources,
        closed: false,
        chatId,
        publicChatId,
        metrics,
        protocolEvent: normalizedStreamEvent,
      };
    }
  } else if (type === "textResponse" || type === "finalizeResponseStream") {
    normalized = {
      type: "assistant_final",
      uuid,
      content: textResponse || "",
      sources,
      chatId,
      publicChatId,
      metrics,
      closed: !!close,
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "abort") {
    normalized = {
      type: "assistant_error",
      uuid,
      content: error || textResponse || "Stream aborted.",
      error: error || textResponse || "Stream aborted.",
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "stopGeneration") {
    normalized = {
      type: "stop_generation",
      uuid,
      content: "Generation stopped by user.",
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "wssFailure") {
    normalized = {
      type: "assistant_error",
      uuid,
      content: error || textResponse || "Websocket connection failed.",
      error: error || textResponse || "Websocket connection failed.",
      protocolEvent: normalizedStreamEvent,
    };
  } else if (action === "reset_chat") {
    normalized = {
      type: "reset_chat",
      protocolEvent: normalizedStreamEvent,
    };
  }

  debugChatTurn("normalize:event", {
    ...rawEventSummary(raw, "SSE"),
    ...(normalized
      ? normalizedEventSummary(normalized, "SSE")
      : { normalizedType: null }),
    protocolType: normalizedStreamEvent.type,
    rawType: normalizedStreamEvent.rawType,
  });

  return normalized;
}
