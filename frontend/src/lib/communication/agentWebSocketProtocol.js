import { dispatchThreadRename } from "@/utils/chat";
import { debugChatTurn } from "@/utils/chat/debug";
import { safeJsonParse } from "@/utils/request";

const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 500;
const MAX_TIMELINE_EVENT_CHARS = 500;
const MAX_CLARIFYING_QUESTIONS = 3;
const MAX_CLARIFYING_QUESTION_CHARS = 150;
const MAX_CLARIFYING_CHOICE_OPTIONS = 3;

function truncateText(value = "", maxChars = MAX_TIMELINE_EVENT_CHARS) {
  const text = String(value || "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function truncateUnicode(value = "", maxChars = MAX_CLARIFYING_QUESTION_CHARS) {
  const chars = Array.from(String(value || ""));
  if (chars.length <= maxChars) return chars.join("");
  return chars.slice(0, maxChars).join("");
}

function compactClarifyingQuestions(questions = []) {
  if (!Array.isArray(questions)) return [];
  return questions.slice(0, MAX_CLARIFYING_QUESTIONS).map((question) => {
    const compacted = {
      ...question,
      question: truncateUnicode(question?.question || ""),
    };
    if (compacted.kind === "choice") {
      compacted.options = Array.isArray(question.options)
        ? question.options.slice(0, MAX_CLARIFYING_CHOICE_OPTIONS)
        : [];
      compacted.optionDescriptions = Array.isArray(question.optionDescriptions)
        ? question.optionDescriptions.slice(0, MAX_CLARIFYING_CHOICE_OPTIONS)
        : [];
      compacted.multiSelect = false;
      compacted.allowOther = true;
    }
    return compacted;
  });
}

function compactApprovalPayload(payload = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const allowedKeys = [
    "command",
    "cwd",
    "mode",
    "risk",
    "root",
    "estimatedFiles",
    "scannedFiles",
    "excludedCount",
    "estimatedBytes",
    "fileTypes",
    "glob",
    "excludedByReason",
    "approvalClass",
    "scope",
    "exchange",
    "environment",
    "symbol",
    "days",
    "limit",
  ];
  return allowedKeys.reduce((acc, key) => {
    if (payload[key] === undefined) return acc;
    acc[key] =
      typeof payload[key] === "string"
        ? truncateText(payload[key], MAX_TIMELINE_EVENT_CHARS)
        : payload[key];
    return acc;
  }, {});
}

function protocolEvent(type, raw = {}, payload = {}) {
  return {
    type,
    rawType: raw?.type || null,
    payload,
    raw,
    seq: raw?.seq ?? payload?.seq ?? null,
    chatId: raw?.chatId ?? payload?.chatId ?? payload?.patch?.chatId ?? null,
    publicChatId:
      raw?.publicChatId ??
      payload?.publicChatId ??
      payload?.patch?.publicChatId ??
      null,
    text: raw?.content ?? payload?.content ?? payload?.text ?? null,
    error: payload?.error ?? raw?.error ?? null,
  };
}

function withProtocol(normalized, raw, type = normalized?.type || "unknown") {
  if (!normalized) return null;
  return {
    ...normalized,
    protocolEvent: protocolEvent(type, raw, normalized),
  };
}

function toolResultEvent(content = {}) {
  return {
    type: "timeline_event",
    seq: content.seq,
    event: {
      type: "tool_result",
      seq: content.seq,
      uuid: content.uuid,
      content: truncateText(
        content.summary ||
          content.content ||
          `Tool ${content.toolName || "unknown"} returned a result.`
      ),
      toolName: content.toolName,
      summary: content.summary,
      runId: content.runId,
      stored: content.stored,
      storageError: content.storageError,
      resultSize: content.resultSize,
      truncated: content.truncated,
      exitCode: content.exitCode,
      timedOut: content.timedOut,
      root: content.root,
      fileCount: content.fileCount,
      excludedCount: content.excludedCount,
      totalSize: content.totalSize,
      outputPreview: truncateText(
        content.outputPreview || "",
        MAX_TOOL_OUTPUT_PREVIEW_CHARS
      ),
    },
  };
}

function reportStreamEvent(content = {}) {
  const { type, uuid } = content;

  if (type === "textResponseChunk") {
    if (content.close) {
      return {
        type: "assistant_final",
        seq: content.seq,
        uuid,
        content: content.content || "",
        sources: content.sources || [],
        metrics: content.metrics || {},
        chatId: content.chatId || null,
        publicChatId: content.publicChatId || null,
        closed: true,
      };
    }

    return {
      type: "assistant_delta",
      seq: content.seq,
      uuid,
      content: content.content || "",
      sources: content.sources || [],
      metrics: content.metrics || {},
      chatId: content.chatId || null,
      publicChatId: content.publicChatId || null,
      closed: false,
    };
  }

  if (type === "fullTextResponse") {
    return {
      type: "assistant_final",
      seq: content.seq,
      uuid,
      content: content.content || "",
      sources: content.sources || [],
      metrics: content.metrics || {},
      chatId: content.chatId || null,
      publicChatId: content.publicChatId || null,
      closed: !!content.close,
    };
  }

  if (type === "usageMetrics") {
    return {
      type: "assistant_patch",
      seq: content.seq,
      uuid,
      patch: { metrics: content.metrics || {} },
    };
  }

  if (type === "citations") {
    return {
      type: "assistant_patch",
      seq: content.seq,
      uuid,
      patch: { sources: content.citations || [] },
      appendSources: true,
    };
  }

  if (type === "chatId") {
    return {
      type: "assistant_patch",
      seq: content.seq,
      uuid,
      patch: {
        chatId: content.chatId,
        publicChatId: content.publicChatId || null,
        sources: content.sources || [],
        metrics: content.metrics || {},
      },
      closed: !!content.close,
    };
  }

  if (type === "toolCallInvocation") {
    return {
      type: "timeline_event",
      seq: content.seq,
      event: {
        type: "tool_call",
        seq: content.seq,
        uuid,
        content: truncateText(content.content || ""),
        toolName: content.toolName,
      },
    };
  }

  if (type === "toolCallResult") {
    return { ...toolResultEvent(content), seq: content.seq };
  }

  if (type === "statusResponse") {
    return {
      type: "timeline_event",
      seq: content.seq,
      event: {
        type: "thought",
        seq: content.seq,
        uuid,
        content: truncateText(content.content || ""),
      },
    };
  }

  if (type === "removeStatusResponse") {
    return {
      type: "timeline_event",
      seq: content.seq,
      event: {
        type: "remove_agent_event",
        uuid,
        targetUuid: uuid,
      },
    };
  }

  return {
    type: "timeline_event",
    seq: content.seq,
    event: {
      type: "thought",
      seq: content.seq,
      uuid,
      content: content.content || "",
      payload: content,
    },
  };
}

export function parseAgentWebSocketMessage(event) {
  const data = safeJsonParse(event?.data, null);
  if (data !== null) return data;
  return {
    type: "unparseable",
    content: typeof event?.data === "string" ? event.data : "",
  };
}

export function normalizeAgentWebSocketEvent(raw = {}) {
  let normalized = null;

  if (raw.type === "rename_thread") {
    dispatchThreadRename(raw.content);
    normalized = { type: "thread_rename", content: raw.content };
    return withProtocol(normalized, raw, "thread_rename");
  }

  if (raw.type === "unparseable") {
    return withProtocol(null, raw, "unparseable");
  }

  if (!Object.prototype.hasOwnProperty.call(raw, "type")) {
    normalized = {
      type: "assistant_final",
      seq: raw.seq,
      content: raw.content || "",
    };
    return withProtocol(normalized, raw, "assistant_final");
  }

  if (raw.type === "chatId") {
    const content =
      raw.content && typeof raw.content === "object" ? raw.content : raw;
    normalized = {
      type: "assistant_patch",
      seq: raw.seq || content.seq,
      uuid: content.uuid,
      patch: {
        chatId: content.chatId,
        publicChatId: content.publicChatId || null,
        sources: content.sources || [],
        metrics: content.metrics || {},
      },
      closed: !!content.close,
    };
    return withProtocol(normalized, raw, "assistant_patch");
  }

  if (raw.type === "statusResponse") {
    normalized = {
      type: "timeline_event",
      seq: raw.seq,
      event: {
        type: "thought",
        seq: raw.seq,
        content: raw.content || "",
        animate: raw.animate,
      },
    };
    return withProtocol(normalized, raw, "status");
  }

  if (raw.type === "WAITING_ON_INPUT") {
    normalized = {
      type: "agent_waiting_on_input",
      seq: raw.seq,
      question: raw.question || "",
    };
    return withProtocol(normalized, raw, "waiting_on_input");
  }

  if (raw.type === "response.completed") {
    normalized = {
      type: "assistant_final",
      seq: raw.seq || raw.sequence_number,
      content: "",
      chatId: raw.response?.metadata?.chatId || null,
      publicChatId: raw.response?.metadata?.publicChatId || null,
      metrics: raw.response?.usage || {},
      responseId: raw.response?.id || null,
      responseStatus: raw.response?.status || "completed",
      responseCompleted: true,
    };
    return withProtocol(normalized, raw, "response.completed");
  }

  if (raw.type === "toolApprovalRequest") {
    if (!raw.requestId || !raw.skillName) return null;
    normalized = {
      type: "timeline_event",
      seq: raw.seq,
      event: {
        type: "approval_request",
        seq: raw.seq,
        requestId: raw.requestId,
        skillName: raw.skillName,
        payload: compactApprovalPayload(raw.payload),
        description: truncateText(raw.description || ""),
        allowAlwaysAllow: raw.allowAlwaysAllow !== false,
        timeoutMs: raw.timeoutMs,
        requestedAt: Date.now(),
        content: `Approval requested for ${raw.skillName}`,
      },
    };
    return withProtocol(normalized, raw, "approval_request");
  }

  if (raw.type === "clarificationRequest") {
    if (!raw.requestId || !Array.isArray(raw.questions)) return null;
    normalized = {
      type: "timeline_event",
      seq: raw.seq,
      event: {
        type: "clarification_request",
        seq: raw.seq,
        requestId: raw.requestId,
        questions: compactClarifyingQuestions(raw.questions),
        allowSkip: raw.allowSkip !== false,
        timeoutMs: raw.timeoutMs,
        requestedAt: Date.now(),
        content: "Clarification requested",
      },
    };
    return withProtocol(normalized, raw, "clarification_request");
  }

  if (raw.type === "wssFailure") {
    normalized = {
      type: "assistant_error",
      seq: raw.seq,
      content: raw.content || "Agent websocket connection failed.",
      error: raw.content || "Agent websocket connection failed.",
    };
    return withProtocol(normalized, raw, "error");
  }

  if (raw.type === "fileDownloadCard") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "tool_result",
        content: "File generated.",
        summary: "File generated.",
      },
    };
    return withProtocol(normalized, raw, "tool_result");
  }

  if (raw.type === "rechartVisualize") {
    normalized = {
      type: "timeline_event",
      event: {
        type: "tool_result",
        content: "Chart generated.",
        summary: "Chart generated.",
      },
    };
    return withProtocol(normalized, raw, "tool_result");
  }

  if (raw.type === "reportStreamEvent") {
    normalized = reportStreamEvent(raw.content || {});
    return withProtocol(normalized, raw, normalized?.type || "report_event");
  }

  if (raw.type === "agentReplayStart") {
    normalized = {
      type: "agent_replay_start",
      latestSeq: raw.latestSeq || 0,
    };
    return withProtocol(normalized, raw, "agent_replay_start");
  }

  if (raw.type === "agentReplayEnd") {
    normalized = {
      type: "agent_replay_end",
      latestSeq: raw.latestSeq || 0,
    };
    return withProtocol(normalized, raw, "agent_replay_end");
  }

  normalized = {
    type: "timeline_event",
    seq: raw.seq,
    event: {
      type: "thought",
      content: truncateText(raw.content || ""),
    },
  };
  return withProtocol(normalized, raw, "unknown");
}

export function debugAgentProtocolEvent(raw, normalized) {
  debugChatTurn("normalize:event", {
    source: "WebSocket",
    rawType: raw?.type || null,
    normalizedType: normalized?.type || null,
    seq: normalized?.seq || raw?.seq || null,
    chatId: normalized?.chatId || raw?.chatId || null,
    publicChatId: normalized?.publicChatId || raw?.publicChatId || null,
    contentLength: String(raw?.content || normalized?.content || "").length,
  });
}
