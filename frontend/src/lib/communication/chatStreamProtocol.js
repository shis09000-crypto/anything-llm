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

  if (rawType === "response.output_text.delta") {
    return streamEvent("assistant_delta", raw, {
      text: raw.delta || "",
      revision: raw.sequence_number ?? null,
    });
  }

  if (rawType === "response.completed") {
    return streamEvent("final", raw, {
      chatId: raw.response?.metadata?.chatId ?? null,
      publicChatId: raw.response?.metadata?.publicChatId ?? null,
      metrics: raw.response?.usage || {},
    });
  }

  if (rawType === "response.failed" || rawType === "response.incomplete") {
    return streamEvent("error", raw, {
      error:
        raw.response?.error?.message ||
        raw.response?.error?.code ||
        raw.response?.incomplete_details?.reason ||
        "Responses turn did not complete.",
    });
  }

  if (rawType?.startsWith?.("athena.")) {
    return streamEvent("status", raw, raw);
  }

  if (
    rawType === "response.created" ||
    rawType === "response.in_progress" ||
    rawType === "response.output_text.done" ||
    rawType === "response.output_item.added" ||
    rawType === "response.output_item.done"
  ) {
    return streamEvent("lifecycle", raw, raw);
  }

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

  if (rawType === "streamReconnectState") {
    return streamEvent("connection_status", raw, {
      state: raw.state === "connected" ? "connected" : "reconnecting",
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
        revision: raw.runRevision ?? null,
      }
    );
  }

  if (rawType === "fullTextResponse") {
    return streamEvent("assistant_snapshot", raw, {
      uuid: raw.uuid,
      text: raw.textResponse || "",
      sources: raw.sources || [],
      close: !!raw.close,
      chatId: raw.chatId ?? null,
      publicChatId: raw.publicChatId ?? null,
      metrics: raw.metrics || {},
      revision: raw.runRevision ?? null,
    });
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

  if (type === "response.output_text.delta") {
    normalized = {
      type: "assistant_delta",
      uuid: raw.response_id,
      content: raw.delta || "",
      sources: [],
      closed: false,
      revision: raw.sequence_number ?? null,
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "response.completed") {
    normalized = {
      type: "assistant_final",
      uuid: raw.response_id || raw.response?.id,
      content: "",
      sources: [],
      chatId: raw.response?.metadata?.chatId ?? null,
      publicChatId: raw.response?.metadata?.publicChatId ?? null,
      metrics: raw.response?.usage || {},
      closed: true,
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "response.failed") {
    const responseError =
      raw.response?.error?.message ||
      raw.response?.error?.code ||
      "Responses turn failed.";
    normalized = {
      type: "assistant_error",
      uuid: raw.response_id || raw.response?.id,
      content: responseError,
      error: responseError,
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "response.incomplete") {
    normalized = {
      type: "stop_generation",
      uuid: raw.response_id || raw.response?.id,
      content:
        raw.response?.incomplete_details?.reason || "Generation stopped.",
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "athena.tool.progress") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "thought",
        uuid: `${raw.response_id}:${raw.sequence_number}`,
        content: raw.content || "",
        animate: true,
      },
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "athena.tool.started") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "tool_call",
        uuid: raw.call_id,
        toolName: raw.tool_name,
        content: raw.content || `Calling ${raw.tool_name}`,
      },
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "athena.tool.completed") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "tool_result",
        uuid: raw.call_id,
        toolName: raw.tool_name,
        result: raw.result || null,
        content: raw.content || "Tool completed.",
      },
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "athena.approval.required") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "approval_request",
        requestId: raw.request_id || raw.action_id,
        responseId: raw.response_id,
        skillName: raw.tool_name,
        payload: raw.payload || {},
        description: raw.description || null,
        content: raw.description || `Approval requested for ${raw.tool_name}`,
      },
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "athena.clarification.required") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "clarification_request",
        requestId: raw.request_id || raw.action_id,
        responseId: raw.response_id,
        questions: raw.questions || [],
        content: "Additional input is required.",
      },
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "athena.citations") {
    normalized = {
      type: "assistant_patch",
      uuid: raw.response_id,
      patch: { sources: raw.citations || [] },
      revision: raw.sequence_number ?? null,
      closed: false,
      protocolEvent: normalizedStreamEvent,
    };
  } else if (
    type === "response.created" ||
    type === "response.in_progress" ||
    type === "response.output_text.done" ||
    type === "response.output_item.added" ||
    type === "response.output_item.done"
  ) {
    normalized = {
      type: "response_lifecycle",
      status: type,
      chatId: raw.response?.metadata?.chatId ?? null,
      publicChatId: raw.response?.metadata?.publicChatId ?? null,
      clientTurnId: raw.response?.metadata?.clientTurnId ?? null,
      responseId: raw.response_id || raw.response?.id || null,
      protocolEvent: normalizedStreamEvent,
    };
  } else if (type === "agentInitWebsocketConnection") {
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
  } else if (type === "streamReconnectState") {
    normalized = {
      type: "connection_status",
      state: raw.state === "connected" ? "connected" : "reconnecting",
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
        revision: raw.runRevision ?? null,
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
              revision: raw.runRevision ?? null,
              protocolEvent: normalizedStreamEvent,
            }
          : {
              type: "assistant_patch",
              uuid,
              patch: { metrics },
              revision: raw.runRevision ?? null,
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
        revision: raw.runRevision ?? null,
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
  } else if (type === "fullTextResponse") {
    normalized = {
      type: "assistant_snapshot",
      uuid,
      content: textResponse || "",
      sources,
      chatId,
      publicChatId,
      metrics,
      revision: raw.runRevision ?? null,
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
