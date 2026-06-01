import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Workspace from "@/models/workspace";
import handleChat, { ABORT_STREAM_EVENT } from "@/utils/chat";
import handleSocketResponse, {
  AGENT_SESSION_END,
  AGENT_SESSION_START,
  setAgentSessionActive,
  websocketURI,
} from "@/utils/chat/agent";
import { debugChatTurn } from "@/utils/chat/debug";
import { emitAssistantMessageCompleteEvent } from "@/components/contexts/TTSProvider";
import { safeJsonParse } from "@/utils/request";
import {
  TURN_STATUSES,
  appendTimelineEventToItems,
  createTurn,
  createTurnId,
  findAssistantTurn,
  isAssistantTurn,
  isUserItem,
  mergeServerHistoryIntoTurns as mergeServerHistoryIntoTurnItems,
  normalizeTimelineEvent,
  normalizeTurnItems,
  updateAssistantTurnInItems,
} from "@/utils/chat/turns";
import {
  estimatePayloadBytes,
  setDraftMemoryStatsProvider,
} from "@/utils/chat/memoryDiagnostics";

const ChatThreadDraftContext = createContext(null);
const STORAGE_PREFIX = "chat-thread-draft";
const ACTIVE_RUNNING_STORAGE_KEY = "chat-thread-active-running";
const RUNNING_STALE_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_DRAFT_STORAGE_CHARS = 450_000;
const MAX_FINAL_CONTENT_STORAGE_CHARS = 5_000;
const MAX_TIMELINE_EVENT_CHARS = 500;
const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 500;
const MAX_STORED_TIMELINE_EVENTS = 20;
const MAX_STORED_SOURCE_COUNT = 8;
const MAX_SOURCE_FIELD_CHARS = 300;
const MAX_RETAINED_INACTIVE_DRAFTS = 4;
const MAX_COMPACT_INACTIVE_ITEMS = 40;
const MAX_COMPACT_FINAL_CONTENT_CHARS = 2_000;
const WORKSPACE_THREADS_REFRESH_EVENT = "workspaceThreadsRefresh";
const MAX_AGENT_RECONNECT_ATTEMPTS = 5;
const AGENT_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 12_000];
const DEFAULT_AGENT_SILENCE_TIMEOUT_MS = 90_000;

function agentReconnectKey(chatKey, turnId) {
  return `${chatKey}:${turnId}`;
}

function isMeaningfulAgentEvent(event = {}) {
  if (!event) return false;
  if (
    [
      "assistant_delta",
      "assistant_final",
      "assistant_patch",
      "assistant_error",
    ].includes(event.type)
  )
    return true;
  if (event.type !== "timeline_event") return false;
  return [
    "thought",
    "tool_call",
    "tool_result",
    "approval_request",
    "approval_result",
  ].includes(event.event?.type);
}

function reconnectBackoff(attempt = 1) {
  const index = Math.max(
    0,
    Math.min(attempt - 1, AGENT_RECONNECT_BACKOFF_MS.length - 1)
  );
  return AGENT_RECONNECT_BACKOFF_MS[index] + Math.floor(Math.random() * 250);
}

export function getChatThreadKey(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) return null;
  return `${workspaceSlug}:${threadSlug || "default"}`;
}

function getStorageKey(workspaceSlug, threadSlug = null) {
  return `${STORAGE_PREFIX}:${workspaceSlug}:${threadSlug || "default"}`;
}

function parseChatKey(chatKey) {
  if (!chatKey) return { workspaceSlug: null, threadSlug: null };
  const [workspaceSlug, ...threadParts] = chatKey.split(":");
  const threadPart = threadParts.join(":") || "default";
  return {
    workspaceSlug,
    threadSlug: threadPart === "default" ? null : threadPart,
  };
}

function getThreadPath(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) return "/";
  return threadSlug
    ? `/workspace/${workspaceSlug}/t/${threadSlug}`
    : `/workspace/${workspaceSlug}`;
}

function createDraft({ workspaceSlug, threadSlug = null, items = [] }) {
  return {
    workspaceSlug,
    threadSlug,
    items: normalizeTurnItems(items),
    activeTurnId: null,
    pendingApproval: null,
    activeToolCall: null,
    isStreaming: false,
    isAgentRunning: false,
    updatedAt: Date.now(),
    persistError: null,
  };
}

function draftFromStorageValue(value) {
  if (!value || !value.workspaceSlug) return null;
  const updatedAt = value.updatedAt || Date.now();
  const staleRuntime =
    (value.isStreaming || value.isAgentRunning) &&
    Date.now() - updatedAt > RUNNING_STALE_TIMEOUT_MS;
  const draft = {
    workspaceSlug: value.workspaceSlug,
    threadSlug: value.threadSlug ?? null,
    items: normalizeTurnItems(Array.isArray(value.items) ? value.items : []),
    activeTurnId: staleRuntime ? null : value.activeTurnId || null,
    pendingApproval: staleRuntime ? null : value.pendingApproval || null,
    activeToolCall: staleRuntime ? null : value.activeToolCall || null,
    isStreaming: staleRuntime ? false : !!value.isStreaming,
    isAgentRunning: staleRuntime ? false : !!value.isAgentRunning,
    updatedAt,
    persistError: staleRuntime
      ? "This agent session timed out locally because no response was received."
      : value.persistError || null,
  };

  if (staleRuntime && value.activeTurnId) {
    draft.items = failTurnItems(
      draft.items,
      value.activeTurnId,
      draft.persistError
    );
  }
  return draft;
}

function truncateText(value = "", maxChars = MAX_TIMELINE_EVENT_CHARS) {
  const text = String(value || "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function compactSourceMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return {};

  const allowedKeys = [
    "id",
    "title",
    "name",
    "url",
    "source",
    "document",
    "file",
    "fileName",
    "filePath",
    "page",
    "score",
  ];
  return allowedKeys.reduce((acc, key) => {
    if (metadata[key] === undefined || metadata[key] === null) return acc;
    acc[key] =
      typeof metadata[key] === "string"
        ? truncateText(metadata[key], MAX_SOURCE_FIELD_CHARS)
        : metadata[key];
    return acc;
  }, {});
}

function compactSourceForStorage(source = {}) {
  if (!source) return null;
  if (typeof source === "string") {
    return { title: truncateText(source, MAX_SOURCE_FIELD_CHARS) };
  }
  if (typeof source !== "object" || Array.isArray(source)) return null;

  const compact = {};
  [
    "id",
    "title",
    "name",
    "url",
    "source",
    "document",
    "file",
    "fileName",
    "filePath",
    "chunkId",
    "score",
    "relevanceScore",
  ].forEach((key) => {
    if (source[key] === undefined || source[key] === null) return;
    compact[key] =
      typeof source[key] === "string"
        ? truncateText(source[key], MAX_SOURCE_FIELD_CHARS)
        : source[key];
  });

  const metadata = compactSourceMetadata(source.metadata);
  if (Object.keys(metadata).length > 0) compact.metadata = metadata;
  return Object.keys(compact).length > 0 ? compact : null;
}

function compactSourcesForStorage(sources = []) {
  if (!Array.isArray(sources)) return [];
  return sources
    .slice(0, MAX_STORED_SOURCE_COUNT)
    .map(compactSourceForStorage)
    .filter(Boolean);
}

function compactPayload(payload = {}) {
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

function sanitizeTimelineEventForStorage(event = {}) {
  if (!event || typeof event !== "object") return null;
  const base = {
    id: event.id,
    uuid: event.uuid,
    type: event.type,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    status: event.status,
    content: truncateText(event.summary || event.content || ""),
  };

  if (event.type === "tool_call") {
    return {
      ...base,
      toolName: event.toolName,
      content: truncateText(
        event.content || `Calling ${event.toolName || "tool"}...`
      ),
    };
  }

  if (event.type === "tool_result") {
    return {
      ...base,
      toolName: event.toolName,
      runId: event.runId,
      stored: event.stored,
      storageError: event.storageError,
      resultSize: event.resultSize,
      truncated: event.truncated,
      exitCode: event.exitCode,
      timedOut: event.timedOut,
      root: event.root,
      fileCount: event.fileCount,
      excludedCount: event.excludedCount,
      totalSize: event.totalSize,
      outputPreview: truncateText(
        event.outputPreview || "",
        MAX_TOOL_OUTPUT_PREVIEW_CHARS
      ),
    };
  }

  if (event.type === "approval_request") {
    return {
      ...base,
      requestId: event.requestId,
      skillName: event.skillName,
      description: truncateText(event.description || ""),
      allowAlwaysAllow: event.allowAlwaysAllow,
      timeoutMs: event.timeoutMs,
      requestedAt: event.requestedAt,
      payload: compactPayload(event.payload),
    };
  }

  if (event.type === "approval_result") {
    return {
      ...base,
      requestId: event.requestId,
      skillName: event.skillName,
      approved: event.approved,
      reason: event.reason,
    };
  }

  return base;
}

function serializeItemForStorage(item = {}, { minimal = false } = {}) {
  if (item.type === "user") {
    return {
      id: item.id,
      turnId: item.turnId,
      type: item.type,
      role: item.role,
      content: truncateText(item.content || "", 2_000),
      chatId: item.chatId,
      createdAt: item.createdAt,
      attachments: [],
    };
  }

  if (isAssistantTurn(item)) {
    const timeline = minimal
      ? []
      : (item.timeline || [])
          .slice(-MAX_STORED_TIMELINE_EVENTS)
          .map(sanitizeTimelineEventForStorage)
          .filter(Boolean);
    const shouldStoreFinalContent =
      item.status !== TURN_STATUSES.completed || !item.chatId;
    const shouldStoreSources =
      !minimal && (item.status !== TURN_STATUSES.completed || !item.chatId);
    return {
      id: item.id,
      turnId: item.turnId,
      type: item.type,
      role: item.role,
      userMessageId: item.userMessageId,
      status: item.status,
      chatId: item.chatId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      error: truncateText(item.error || ""),
      finalContent:
        minimal || !shouldStoreFinalContent
          ? ""
          : truncateText(
              item.finalContent || "",
              MAX_FINAL_CONTENT_STORAGE_CHARS
            ),
      sources: shouldStoreSources ? compactSourcesForStorage(item.sources) : [],
      metrics: minimal ? {} : item.metrics || {},
      timeline,
      reconnectState: item.reconnectState || null,
      retryCount: item.retryCount || 0,
      maxRetries: item.maxRetries || MAX_AGENT_RECONNECT_ATTEMPTS,
      silenceTimeoutMs: item.silenceTimeoutMs || null,
      lastEventSeq: item.lastEventSeq || 0,
      interruptedContext: minimal ? null : item.interruptedContext || null,
    };
  }

  return null;
}

function serializeDraftForStorage(draft, { minimal = false } = {}) {
  const items = (draft.items || [])
    .map((item) => serializeItemForStorage(item, { minimal }))
    .filter(Boolean);
  return {
    items,
    activeTurnId: draft.activeTurnId,
    pendingApproval: minimal
      ? null
      : sanitizeTimelineEventForStorage(draft.pendingApproval),
    activeToolCall: minimal
      ? null
      : sanitizeTimelineEventForStorage(draft.activeToolCall),
    isStreaming: draft.isStreaming,
    isAgentRunning: draft.isAgentRunning,
    updatedAt: draft.updatedAt,
    workspaceSlug: draft.workspaceSlug,
    threadSlug: draft.threadSlug,
    persistError: draft.persistError || null,
  };
}

export function draftHistoryIntegrity(draft = {}) {
  const sourceDraft = draft || {};
  const items = normalizeTurnItems(
    Array.isArray(sourceDraft.items) ? sourceDraft.items : []
  );
  const userItems = items.filter(isUserItem);
  const blankServerBackedUserItems = userItems.filter(
    (item) => item.chatId && !String(item.content || "").trim()
  );
  const completedAssistantTurns = items.filter(
    (item) => isAssistantTurn(item) && item.status === TURN_STATUSES.completed
  );

  return {
    itemCount: items.length,
    userItemCount: userItems.length,
    blankServerBackedUserItemCount: blankServerBackedUserItems.length,
    completedAssistantTurnCount: completedAssistantTurns.length,
  };
}

export function draftNeedsServerHistoryRefresh(draft = {}) {
  if (!draft) return false;
  return draftHistoryIntegrity(draft).blankServerBackedUserItemCount > 0;
}

function isStorageQuotaError(error) {
  return (
    error?.name === "QuotaExceededError" ||
    error?.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    error?.code === 22 ||
    error?.code === 1014
  );
}

function hasUnfinishedDraft(draft = {}) {
  return !!(
    draft.isStreaming ||
    draft.isAgentRunning ||
    draft.pendingApproval ||
    draft.activeToolCall ||
    draft.items?.some(
      (item) => isAssistantTurn(item) && item.status === TURN_STATUSES.running
    )
  );
}

function clearSettledRuntimeState(draft = {}) {
  const items = normalizeTurnItems(draft.items || []);
  const activeTurn = findAssistantTurn(items, draft.activeTurnId);
  const hasRunningTurn = items.some(
    (item) => isAssistantTurn(item) && item.status === TURN_STATUSES.running
  );
  const hasRuntimeState = !!(
    draft.activeTurnId ||
    draft.isStreaming ||
    draft.isAgentRunning ||
    draft.pendingApproval ||
    draft.activeToolCall
  );

  if (
    !hasRuntimeState ||
    (activeTurn && activeTurn.status === TURN_STATUSES.running) ||
    (!draft.activeTurnId && hasRunningTurn)
  ) {
    debugChatTurn("clearSettledRuntimeState:keep", {
      chatKey: getChatThreadKey(draft.workspaceSlug, draft.threadSlug),
      turnId: draft.activeTurnId || null,
      ...turnRuntimeSnapshot({ ...draft, items }, draft.activeTurnId),
      hasRuntimeState,
      hasRunningTurn,
    });
    return { ...draft, items };
  }

  const next = {
    ...draft,
    items,
    activeTurnId: null,
    pendingApproval: null,
    activeToolCall: null,
    isStreaming: false,
    isAgentRunning: false,
  };
  debugChatTurn("clearSettledRuntimeState:clear", {
    chatKey: getChatThreadKey(draft.workspaceSlug, draft.threadSlug),
    turnId: draft.activeTurnId || null,
    before: turnRuntimeSnapshot({ ...draft, items }, draft.activeTurnId),
    after: turnRuntimeSnapshot(next, draft.activeTurnId),
    hasRuntimeState,
    hasRunningTurn,
  });
  return next;
}

function hasLocalDraftItems(draft = {}) {
  return draft.items?.some(
    (item) =>
      item?.turnId?.startsWith?.("turn:") ||
      (isAssistantTurn(item) && item.status !== TURN_STATUSES.completed)
  );
}

function compactInactiveItem(item = {}) {
  if (!isAssistantTurn(item)) return item;
  if (item.status !== TURN_STATUSES.completed) return item;
  return {
    ...item,
    finalContent: truncateText(
      item.finalContent || "",
      MAX_COMPACT_FINAL_CONTENT_CHARS
    ),
    sources: [],
    outputs: [],
    metrics: {},
    timeline: [],
  };
}

function compactInactiveDraft(draft = {}) {
  return {
    ...draft,
    items: normalizeTurnItems(draft.items || [])
      .slice(-MAX_COMPACT_INACTIVE_ITEMS)
      .map(compactInactiveItem),
    pendingApproval: null,
    activeToolCall: null,
    isStreaming: false,
    isAgentRunning: false,
  };
}

function shouldRetainFullDraft(chatKey, draft, activeChatKey) {
  return (
    chatKey === activeChatKey ||
    hasUnfinishedDraft(draft) ||
    hasLocalDraftItems(draft) ||
    !!draft.persistError
  );
}

function pruneDraftCollection(drafts = {}, activeChatKey = null) {
  const next = {};
  const inactive = [];

  Object.entries(drafts).forEach(([chatKey, draft]) => {
    if (shouldRetainFullDraft(chatKey, draft, activeChatKey)) {
      next[chatKey] = draft;
      return;
    }
    inactive.push([chatKey, draft]);
  });

  inactive
    .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .forEach(([chatKey, draft], index) => {
      if (index < MAX_RETAINED_INACTIVE_DRAFTS) {
        const compacted = compactInactiveDraft(draft);
        next[chatKey] = compacted;
        persistDraft(compacted);
      } else {
        removeStoredDraft(draft.workspaceSlug, draft.threadSlug);
      }
    });

  return next;
}

function persistDraft(draft) {
  if (typeof window === "undefined" || !draft?.workspaceSlug) return;
  const key = getStorageKey(draft.workspaceSlug, draft.threadSlug);
  const hasDraft =
    hasUnfinishedDraft(draft) ||
    hasLocalDraftItems(draft) ||
    draft.persistError ||
    draft.items.length > 0;

  if (!hasDraft) {
    sessionStorage.removeItem(key);
    return;
  }

  try {
    const serialized = JSON.stringify(serializeDraftForStorage(draft));
    debugChatTurn("persistDraft:storageSize", {
      key,
      serializedLength: serialized.length,
      maxLength: MAX_DRAFT_STORAGE_CHARS,
      minimal: false,
      ...draftHistoryIntegrity(draft),
    });
    if (serialized.length > MAX_DRAFT_STORAGE_CHARS) {
      const sizeError = new Error("Draft exceeded storage limit.");
      sizeError.name = "QuotaExceededError";
      sizeError.serializedLength = serialized.length;
      throw sizeError;
    }
    sessionStorage.setItem(key, serialized);
  } catch (error) {
    debugChatTurn("persistDraft:storageFallback", {
      key,
      error: error?.message || String(error),
      quota: isStorageQuotaError(error),
      serializedLength: error?.serializedLength || null,
      maxLength: MAX_DRAFT_STORAGE_CHARS,
      ...draftHistoryIntegrity(draft),
    });
    try {
      const minimalSerialized = JSON.stringify(
        serializeDraftForStorage(draft, { minimal: true })
      );
      debugChatTurn("persistDraft:storageSize", {
        key,
        serializedLength: minimalSerialized.length,
        maxLength: MAX_DRAFT_STORAGE_CHARS,
        minimal: true,
        ...draftHistoryIntegrity(draft),
      });
      sessionStorage.setItem(key, minimalSerialized);
    } catch (minimalError) {
      debugChatTurn("persistDraft:storageDropped", {
        key,
        error: minimalError?.message || String(minimalError),
      });
      sessionStorage.removeItem(key);
    }
  }
}

function removeStoredDraft(workspaceSlug, threadSlug = null) {
  if (typeof window === "undefined" || !workspaceSlug) return;
  sessionStorage.removeItem(getStorageKey(workspaceSlug, threadSlug));
}

function restoreStoredDrafts() {
  if (typeof window === "undefined") return {};
  const drafts = {};
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key?.startsWith(`${STORAGE_PREFIX}:`)) continue;
    const draft = draftFromStorageValue(
      safeJsonParse(sessionStorage.getItem(key))
    );
    if (!draft) continue;
    const chatKey = getChatThreadKey(draft.workspaceSlug, draft.threadSlug);
    drafts[chatKey] = draft;
  }
  return drafts;
}

function isRunningActivityStale(activity = {}, now = Date.now()) {
  if (activity.status !== TURN_STATUSES.running) return false;
  const lastSeen = activity.updatedAt || activity.startedAt || now;
  return now - lastSeen > RUNNING_STALE_TIMEOUT_MS;
}

function normalizeRunningState(stored = {}) {
  const now = Date.now();
  const threadActivityByKey = {};
  Object.entries(stored?.threadActivityByKey || {}).forEach(
    ([chatKey, activity]) => {
      if (!activity?.chatKey) return;
      if (activity.status !== TURN_STATUSES.running) return;
      if (isRunningActivityStale(activity, now)) return;
      threadActivityByKey[chatKey] = activity;
    }
  );

  const activeRunningThread = stored?.activeRunningThread;
  const normalizedActive =
    activeRunningThread?.status === TURN_STATUSES.running &&
    !isRunningActivityStale(activeRunningThread, now)
      ? activeRunningThread
      : null;

  return {
    activeRunningThread:
      normalizedActive?.status === TURN_STATUSES.running
        ? normalizedActive
        : null,
    threadActivityByKey,
  };
}

function restoreActiveRunningState() {
  if (typeof window === "undefined") {
    return { activeRunningThread: null, threadActivityByKey: {} };
  }
  const stored = safeJsonParse(
    sessionStorage.getItem(ACTIVE_RUNNING_STORAGE_KEY),
    {}
  );
  return normalizeRunningState(stored);
}

function persistActiveRunningState(activeRunningThread, threadActivityByKey) {
  if (typeof window === "undefined") return;
  const normalized = normalizeRunningState({
    activeRunningThread,
    threadActivityByKey,
  });
  const hasActivity =
    normalized.activeRunningThread ||
    Object.keys(normalized.threadActivityByKey || {}).length > 0;
  if (!hasActivity) {
    sessionStorage.removeItem(ACTIVE_RUNNING_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(
    ACTIVE_RUNNING_STORAGE_KEY,
    JSON.stringify(normalized)
  );
}

function failTurnItems(items = [], turnId, reason) {
  return updateAssistantTurnInItems(
    appendTimelineEventToItems(items, turnId, {
      type: "error",
      content: reason,
    }),
    turnId,
    {
      status: TURN_STATUSES.failed,
      error: reason,
    }
  );
}

function completeTurnPatch(turn, patch = {}) {
  const nextFinalContent =
    patch.finalContent !== undefined
      ? patch.finalContent
      : patch.content !== undefined && patch.content !== ""
        ? patch.content
        : turn.finalContent || "";

  return {
    ...patch,
    chatId: patch.chatId || turn.chatId || null,
    finalContent: nextFinalContent,
    sources: patch.sources || turn.sources || [],
    metrics: patch.metrics || turn.metrics || {},
    status: TURN_STATUSES.completed,
    error: null,
  };
}

function assistantTurnByChatId(items = [], chatId = null) {
  if (!chatId) return null;
  return items.find((item) => isAssistantTurn(item) && item.chatId === chatId);
}

function canApplyTurnEvent(draft, turnId) {
  if (!draft || !turnId) return null;
  const turn = findAssistantTurn(draft.items || [], turnId);
  return turn?.turnId === turnId ? turn : null;
}

function turnRefKey(chatKey, turnId) {
  return `${chatKey}:${turnId}`;
}

function turnRuntimeSnapshot(draft = {}, turnId = null) {
  const turn = findAssistantTurn(draft?.items || [], turnId);
  return {
    activeTurnId: draft?.activeTurnId || null,
    isStreaming: !!draft?.isStreaming,
    isAgentRunning: !!draft?.isAgentRunning,
    activeToolCall: draft?.activeToolCall?.id || null,
    pendingApproval: draft?.pendingApproval?.requestId || null,
    status: turn?.status || null,
    finalContentLength: turn?.finalContent?.length || 0,
    timelineEventCount: turn?.timeline?.length || 0,
  };
}

export function ChatThreadDraftProvider({ children }) {
  const [drafts, setDrafts] = useState(() => restoreStoredDrafts());
  const [runningState, setRunningState] = useState(() =>
    restoreActiveRunningState()
  );
  const draftsRef = useRef(drafts);
  const runningStateRef = useRef(runningState);
  const websocketRefs = useRef({});
  const approvalTimeoutRefs = useRef({});
  const stoppedThreadRefs = useRef({});
  const erroredThreadRefs = useRef({});
  const agentReconnectRefs = useRef({});
  const confirmPersistedRef = useRef(null);
  const settledTurnRefs = useRef({});
  const deltaFlushRefs = useRef({});
  const draftListenersRef = useRef(new Map());
  const activityListenersRef = useRef(new Map());
  const activityVersionRef = useRef(0);
  const activeChatKeyRef = useRef(null);

  const emitListeners = useCallback((listenersRef, key) => {
    const listeners = listenersRef.current.get(key);
    if (listeners) listeners.forEach((listener) => listener());
    const wildcard = listenersRef.current.get("*");
    if (wildcard) wildcard.forEach((listener) => listener());
  }, []);

  const subscribeListener = useCallback((listenersRef, key, listener) => {
    const listenerKey = key || "*";
    const listeners = listenersRef.current.get(listenerKey) || new Set();
    listeners.add(listener);
    listenersRef.current.set(listenerKey, listeners);
    return () => {
      const current = listenersRef.current.get(listenerKey);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) listenersRef.current.delete(listenerKey);
    };
  }, []);

  const debugRuntime = useCallback(
    (
      label,
      { chatKey, turnId = null, draft = null, running = null, ...extra }
    ) => {
      const currentDraft = draft || draftsRef.current[chatKey] || {};
      const currentRunning = running || runningStateRef.current || {};
      debugChatTurn(label, {
        chatKey,
        turnId,
        ...turnRuntimeSnapshot(currentDraft, turnId),
        runningActivity: currentRunning.threadActivityByKey?.[chatKey] || null,
        activeRunningThread: currentRunning.activeRunningThread || null,
        ...extra,
      });
    },
    []
  );

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    runningStateRef.current = runningState;
  }, [runningState]);

  useEffect(() => {
    setDraftMemoryStatsProvider(() => {
      const drafts = draftsRef.current || {};
      const values = Object.values(drafts);
      return {
        activeChatKey: activeChatKeyRef.current,
        draftCount: values.length,
        itemCount: values.reduce(
          (sum, draft) => sum + (draft.items?.length || 0),
          0
        ),
        runningDraftCount: values.filter(hasUnfinishedDraft).length,
        retainedBytes: estimatePayloadBytes(drafts),
        listenerKeys: draftListenersRef.current.size,
        activityListenerKeys: activityListenersRef.current.size,
      };
    });
    return () => setDraftMemoryStatsProvider(null);
  }, []);

  const updateRunningState = useCallback(
    (updater) => {
      setRunningState((prev) => {
        const next = normalizeRunningState(
          updater(normalizeRunningState(prev))
        );
        persistActiveRunningState(
          next.activeRunningThread,
          next.threadActivityByKey
        );
        runningStateRef.current = next;
        activityVersionRef.current += 1;
        queueMicrotask(() => emitListeners(activityListenersRef, "*"));
        return next;
      });
    },
    [emitListeners]
  );

  const updateDraft = useCallback(
    (chatKey, updater) => {
      setDrafts((prev) => {
        let current = prev[chatKey];
        if (!current) {
          const { workspaceSlug, threadSlug } = parseChatKey(chatKey);
          current = createDraft({ workspaceSlug, threadSlug });
        }

        debugRuntime("updateDraft:before", {
          chatKey,
          turnId: current.activeTurnId || null,
          draft: current,
        });
        let next = {
          ...updater({
            ...current,
            items: normalizeTurnItems(current.items || []),
          }),
          updatedAt: Date.now(),
        };
        next.items = normalizeTurnItems(next.items || []);
        next = clearSettledRuntimeState(next);
        debugRuntime("updateDraft:after", {
          chatKey,
          turnId: next.activeTurnId || current.activeTurnId || null,
          draft: next,
        });
        persistDraft(next);
        const nextDrafts = pruneDraftCollection(
          { ...prev, [chatKey]: next },
          activeChatKeyRef.current || chatKey
        );
        draftsRef.current = nextDrafts;
        queueMicrotask(() => emitListeners(draftListenersRef, chatKey));
        return nextDrafts;
      });
    },
    [debugRuntime, emitListeners]
  );

  const markThreadRunning = useCallback(
    (chatKey, turnId) => {
      const { workspaceSlug, threadSlug } = parseChatKey(chatKey);
      if (!workspaceSlug || !turnId) return;
      const now = Date.now();
      updateRunningState((prev) => {
        const existing = prev.threadActivityByKey?.[chatKey];
        debugRuntime("markThreadRunning:before", {
          chatKey,
          turnId,
          running: prev,
          activity: existing || null,
        });
        const activity = {
          workspaceSlug,
          threadSlug,
          chatKey,
          turnId,
          status: TURN_STATUSES.running,
          startedAt: existing?.turnId === turnId ? existing.startedAt : now,
          updatedAt: now,
        };
        const next = {
          activeRunningThread: activity,
          threadActivityByKey: {
            ...(prev.threadActivityByKey || {}),
            [chatKey]: activity,
          },
        };
        debugRuntime("markThreadRunning:after", {
          chatKey,
          turnId,
          running: next,
          activity,
        });
        return next;
      });
    },
    [debugRuntime, updateRunningState]
  );

  const markThreadCompleted = useCallback(
    (chatKey, turnId) => {
      const { workspaceSlug } = parseChatKey(chatKey);
      if (!workspaceSlug || !turnId) return;
      updateRunningState((prev) => {
        const nextActivity = { ...(prev.threadActivityByKey || {}) };
        debugRuntime("markThreadCompleted:before", {
          chatKey,
          turnId,
          running: prev,
          activity: nextActivity[chatKey] || null,
        });
        delete nextActivity[chatKey];
        const next = {
          activeRunningThread:
            prev.activeRunningThread?.chatKey === chatKey &&
            prev.activeRunningThread?.turnId === turnId
              ? null
              : prev.activeRunningThread,
          threadActivityByKey: nextActivity,
        };
        debugRuntime("markThreadCompleted:after", {
          chatKey,
          turnId,
          running: next,
          activity: next.threadActivityByKey?.[chatKey] || null,
        });
        return next;
      });
    },
    [debugRuntime, updateRunningState]
  );

  const markThreadFailed = useCallback(
    (chatKey, turnId, reason = null) => {
      const { workspaceSlug } = parseChatKey(chatKey);
      if (!workspaceSlug || !turnId) return;
      const failureReason =
        reason ||
        "The agent session ended before a final response was received.";
      updateRunningState((prev) => {
        const nextActivity = { ...(prev.threadActivityByKey || {}) };
        debugRuntime("markThreadFailed:before", {
          chatKey,
          turnId,
          running: prev,
          reason: failureReason,
          activity: nextActivity[chatKey] || null,
        });
        delete nextActivity[chatKey];
        const next = {
          activeRunningThread:
            prev.activeRunningThread?.chatKey === chatKey &&
            prev.activeRunningThread?.turnId === turnId
              ? null
              : prev.activeRunningThread,
          threadActivityByKey: nextActivity,
        };
        debugRuntime("markThreadFailed:after", {
          chatKey,
          turnId,
          running: next,
          reason: failureReason,
          activity: next.threadActivityByKey?.[chatKey] || null,
        });
        return next;
      });
      updateDraft(chatKey, (draft) => {
        const next = {
          ...draft,
          items: failTurnItems(draft.items, turnId, failureReason),
          activeTurnId:
            draft.activeTurnId === turnId ? null : draft.activeTurnId,
          pendingApproval: null,
          activeToolCall: null,
          isStreaming: false,
          isAgentRunning: false,
          persistError: failureReason,
        };
        debugChatTurn("assistant_error:after", {
          chatKey,
          turnId,
          reason: failureReason,
          ...turnRuntimeSnapshot(next, turnId),
        });
        return next;
      });
    },
    [debugRuntime, updateDraft, updateRunningState]
  );

  const clearThreadRunning = useCallback(
    (chatKey, turnId = null) => {
      updateRunningState((prev) => {
        const nextActivity = { ...(prev.threadActivityByKey || {}) };
        const existing = nextActivity[chatKey];
        debugRuntime("clearThreadRunning:before", {
          chatKey,
          turnId,
          running: prev,
          activity: existing || null,
        });
        if (
          existing?.status === TURN_STATUSES.running &&
          (!turnId || existing.turnId === turnId)
        ) {
          delete nextActivity[chatKey];
        }
        const next = {
          activeRunningThread:
            prev.activeRunningThread?.chatKey === chatKey &&
            (!turnId || prev.activeRunningThread?.turnId === turnId)
              ? null
              : prev.activeRunningThread,
          threadActivityByKey: nextActivity,
        };
        debugRuntime("clearThreadRunning:after", {
          chatKey,
          turnId,
          running: next,
          activity: next.threadActivityByKey?.[chatKey] || null,
        });
        return next;
      });
    },
    [debugRuntime, updateRunningState]
  );

  const clearThreadActivity = useCallback(
    (workspaceSlug, threadSlug = null) => {
      const chatKey = getChatThreadKey(workspaceSlug, threadSlug);
      updateRunningState((prev) => {
        const nextActivity = { ...(prev.threadActivityByKey || {}) };
        debugRuntime("clearThreadActivity:before", {
          chatKey,
          running: prev,
          activity: nextActivity[chatKey] || null,
        });
        delete nextActivity[chatKey];
        const next = {
          activeRunningThread:
            prev.activeRunningThread?.chatKey === chatKey
              ? null
              : prev.activeRunningThread,
          threadActivityByKey: nextActivity,
        };
        debugRuntime("clearThreadActivity:after", {
          chatKey,
          running: next,
          activity: next.threadActivityByKey?.[chatKey] || null,
        });
        return next;
      });
    },
    [debugRuntime, updateRunningState]
  );

  useEffect(() => {
    const interval = setInterval(() => {
      updateRunningState((state) => state);
    }, 30 * 1000);
    return () => clearInterval(interval);
  }, [updateRunningState]);

  useEffect(() => {
    Object.entries(runningState.threadActivityByKey || {}).forEach(
      ([chatKey, activity]) => {
        if (activity.status !== TURN_STATUSES.failed || !activity.turnId)
          return;
        const draft = draftsRef.current[chatKey];
        const turn = findAssistantTurn(draft?.items || [], activity.turnId);
        if (!turn || turn.status === TURN_STATUSES.failed) return;
        updateDraft(chatKey, (current) => ({
          ...current,
          items: failTurnItems(
            current.items,
            activity.turnId,
            activity.reason ||
              "The agent session ended before a final response was received."
          ),
          activeTurnId:
            current.activeTurnId === activity.turnId
              ? null
              : current.activeTurnId,
          pendingApproval: null,
          activeToolCall: null,
          isStreaming: false,
          isAgentRunning: false,
          persistError: activity.reason,
        }));
      }
    );
  }, [runningState.threadActivityByKey, updateDraft]);

  const ensureDraft = useCallback(
    ({ workspaceSlug, threadSlug = null, items = [], history = [] }) => {
      const chatKey = getChatThreadKey(workspaceSlug, threadSlug);
      activeChatKeyRef.current = chatKey;
      setDrafts((prev) => {
        const restored = draftFromStorageValue(
          safeJsonParse(
            sessionStorage.getItem(getStorageKey(workspaceSlug, threadSlug))
          )
        );
        const existing = prev[chatKey] || restored;
        const integrity = draftHistoryIntegrity(existing);
        if (draftNeedsServerHistoryRefresh(existing)) {
          debugChatTurn("ensureDraft:needsServerHistoryRefresh", {
            chatKey,
            ...integrity,
          });
        }
        debugRuntime("ensureDraft:before", {
          chatKey,
          turnId: existing?.activeTurnId || null,
          draft: existing || null,
          historyLength: history.length,
          seedItemCount: items.length,
          ...integrity,
        });
        const seedItems =
          history.length > 0
            ? mergeServerHistoryIntoTurnItems(history, existing?.items || [], {
                chatKey,
              })
            : normalizeTurnItems(items);
        const next = existing
          ? {
              ...existing,
              items:
                seedItems.length > 0
                  ? mergeServerHistoryIntoTurnItems([], seedItems)
                  : existing.items,
              updatedAt: Date.now(),
            }
          : createDraft({ workspaceSlug, threadSlug, items: seedItems });
        debugRuntime("ensureDraft:after", {
          chatKey,
          turnId: next.activeTurnId || null,
          draft: next,
          historyLength: history.length,
          itemCount: next.items.length,
          ...draftHistoryIntegrity(next),
        });
        persistDraft(next);
        const nextDrafts = pruneDraftCollection(
          { ...prev, [chatKey]: next },
          chatKey
        );
        draftsRef.current = nextDrafts;
        queueMicrotask(() => emitListeners(draftListenersRef, chatKey));
        return nextDrafts;
      });
      return chatKey;
    },
    [debugRuntime, emitListeners]
  );

  const updateAssistantTurn = useCallback(
    (chatKey, turnId, patch = {}) => {
      debugRuntime("updateAssistantTurn:before", {
        chatKey,
        turnId,
        patchKeys: Object.keys(patch || {}),
      });
      updateDraft(chatKey, (draft) => ({
        ...draft,
        items: updateAssistantTurnInItems(draft.items, turnId, patch),
      }));
      debugRuntime("updateAssistantTurn:scheduled", {
        chatKey,
        turnId,
        patchKeys: Object.keys(patch || {}),
      });
    },
    [debugRuntime, updateDraft]
  );

  const enqueueAssistantDelta = useCallback(
    (chatKey, turnId, event = {}) => {
      const key = `${chatKey}:${turnId}`;
      const pending = deltaFlushRefs.current[key] || {
        content: "",
        sources: [],
        metrics: null,
        chatId: null,
        frame: null,
      };
      pending.content += event.content || "";
      pending.sources =
        event.sources?.length > 0 ? event.sources : pending.sources;
      pending.metrics = event.metrics || pending.metrics;
      pending.chatId = event.chatId || pending.chatId;

      if (!pending.frame) {
        pending.frame = requestAnimationFrame(() => {
          const nextPending = deltaFlushRefs.current[key];
          delete deltaFlushRefs.current[key];
          if (!nextPending) return;
          updateDraft(chatKey, (draft) => {
            const turn = canApplyTurnEvent(draft, turnId);
            if (!turn || turn.status !== TURN_STATUSES.running) return draft;
            return {
              ...draft,
              items: updateAssistantTurnInItems(draft.items, turnId, {
                finalContent: `${turn.finalContent || ""}${nextPending.content}`,
                sources:
                  nextPending.sources?.length > 0
                    ? nextPending.sources
                    : turn.sources || [],
                metrics: nextPending.metrics || turn.metrics || {},
                chatId: nextPending.chatId || turn.chatId,
                status: TURN_STATUSES.running,
              }),
              isStreaming: true,
              activeTurnId: turnId,
            };
          });
        });
      }

      deltaFlushRefs.current[key] = pending;
    },
    [updateDraft]
  );

  const appendTimelineEvent = useCallback(
    (chatKey, turnId, rawEvent) => {
      if (!rawEvent) return;
      const event =
        rawEvent.type === "remove_agent_event"
          ? rawEvent
          : normalizeTimelineEvent(rawEvent);

      debugRuntime("appendTimelineEvent:before", {
        chatKey,
        turnId,
        eventType: event.type,
        eventId: event.id || event.uuid || event.requestId || null,
      });
      updateDraft(chatKey, (draft) => {
        const next = {
          ...draft,
          items: appendTimelineEventToItems(draft.items, turnId, event),
        };

        if (event.type === "tool_call") next.activeToolCall = event;
        if (event.type === "tool_result") next.activeToolCall = null;
        if (event.type === "approval_request") next.pendingApproval = event;
        if (event.type === "approval_result") next.pendingApproval = null;
        debugRuntime("appendTimelineEvent:after", {
          chatKey,
          turnId,
          draft: next,
          eventType: event.type,
          eventId: event.id || event.uuid || event.requestId || null,
        });
        return next;
      });
    },
    [debugRuntime, updateDraft]
  );

  const completeAssistantTurn = useCallback(
    (chatKey, turnId, patch = {}) => {
      const draft = draftsRef.current[chatKey];
      const turn = findAssistantTurn(draft?.items || [], turnId);
      if (!turn) return;
      let completedChatId = patch.chatId || null;
      settledTurnRefs.current[turnRefKey(chatKey, turnId)] =
        TURN_STATUSES.completed;
      debugChatTurn("assistant_final:before", {
        chatKey,
        turnId,
        eventChatId: patch.chatId || null,
        ...turnRuntimeSnapshot(draft, turnId),
      });
      updateDraft(chatKey, (current) => {
        const currentTurn =
          findAssistantTurn(current.items || [], turnId) || turn;
        const pendingKey = `${chatKey}:${turnId}`;
        const pendingDelta = deltaFlushRefs.current[pendingKey];
        if (pendingDelta?.frame) cancelAnimationFrame(pendingDelta.frame);
        delete deltaFlushRefs.current[pendingKey];
        const finalPatch =
          pendingDelta?.content && patch.finalContent === undefined
            ? {
                ...patch,
                finalContent: `${currentTurn.finalContent || ""}${pendingDelta.content}`,
                sources:
                  pendingDelta.sources?.length > 0
                    ? pendingDelta.sources
                    : patch.sources,
                metrics: pendingDelta.metrics || patch.metrics,
                chatId: pendingDelta.chatId || patch.chatId,
              }
            : patch;
        completedChatId = finalPatch.chatId || completedChatId;
        const nextItems = updateAssistantTurnInItems(
          current.items,
          turnId,
          completeTurnPatch(currentTurn, finalPatch)
        );
        const next = {
          ...current,
          items: nextItems,
          activeTurnId:
            current.activeTurnId === turnId ? null : current.activeTurnId,
          pendingApproval: null,
          activeToolCall: null,
          isStreaming: false,
          isAgentRunning: false,
          persistError: null,
        };
        debugChatTurn("assistant_final:after", {
          chatKey,
          turnId,
          ...turnRuntimeSnapshot(next, turnId),
        });
        debugRuntime("completeAssistantTurn:after", {
          chatKey,
          turnId,
          draft: next,
          patchKeys: Object.keys(patch || {}),
        });
        return next;
      });
      markThreadCompleted(chatKey, turnId);
      if (completedChatId) {
        window.dispatchEvent(
          new CustomEvent("anythingllm-document-reader-turn-completed", {
            detail: { chatKey, turnId, chatId: completedChatId },
          })
        );
      }
      if (completedChatId) emitAssistantMessageCompleteEvent(completedChatId);
    },
    [debugRuntime, markThreadCompleted, updateDraft]
  );

  const failAssistantTurn = useCallback(
    (chatKey, turnId, reason) => {
      settledTurnRefs.current[turnRefKey(chatKey, turnId)] =
        TURN_STATUSES.failed;
      debugRuntime("failAssistantTurn:entry", {
        chatKey,
        turnId,
        reason,
      });
      markThreadFailed(chatKey, turnId, reason);
    },
    [debugRuntime, markThreadFailed]
  );

  const applyTurnEvent = useCallback(
    (chatKey, turnId, event) => {
      if (!event || !turnId) return;
      debugRuntime("applyTurnEvent:entry", {
        chatKey,
        turnId,
        eventType: event.type,
        eventChatId: event.chatId || event.patch?.chatId || null,
        eventContentLength:
          event.content?.length || event.event?.content?.length || 0,
      });
      const settledStatus =
        settledTurnRefs.current[turnRefKey(chatKey, turnId)] || null;
      if (
        settledStatus &&
        !["assistant_final", "assistant_patch"].includes(event.type)
      ) {
        debugRuntime("applyTurnEvent:ignored", {
          chatKey,
          turnId,
          eventType: event.type,
          reason: `turn-already-${settledStatus}`,
        });
        return null;
      }
      if (settledStatus === TURN_STATUSES.failed) {
        debugRuntime("applyTurnEvent:ignored", {
          chatKey,
          turnId,
          eventType: event.type,
          reason: "turn-already-failed",
        });
        return null;
      }
      if (event.type === "agent_socket_start") return event;

      if (event.type === "timeline_event") {
        const turn = canApplyTurnEvent(draftsRef.current[chatKey], turnId);
        if (!turn) {
          debugRuntime("applyTurnEvent:ignored", {
            chatKey,
            turnId,
            eventType: event.type,
            reason: "missing-target-turn",
          });
          return null;
        }
        appendTimelineEvent(chatKey, turnId, event.event);
        return event;
      }

      if (event.type === "assistant_delta") {
        const currentTurn = canApplyTurnEvent(
          draftsRef.current[chatKey],
          turnId
        );
        if (!currentTurn || currentTurn.status !== TURN_STATUSES.running) {
          debugRuntime("applyTurnEvent:ignored", {
            chatKey,
            turnId,
            eventType: event.type,
            reason: currentTurn ? "target-not-running" : "missing-target-turn",
          });
          return null;
        }
        enqueueAssistantDelta(chatKey, turnId, event);
        markThreadRunning(chatKey, turnId);
        return event;
      }

      if (event.type === "assistant_patch") {
        const currentTurn = canApplyTurnEvent(
          draftsRef.current[chatKey],
          turnId
        );
        if (!currentTurn) {
          debugRuntime("applyTurnEvent:ignored", {
            chatKey,
            turnId,
            eventType: event.type,
            reason: "missing-target-turn",
          });
          return null;
        }
        updateDraft(chatKey, (draft) => {
          const turn = canApplyTurnEvent(draft, turnId);
          if (!turn) return draft;
          const patch = event.patch || {};
          return {
            ...draft,
            items: updateAssistantTurnInItems(draft.items, turnId, {
              ...patch,
              sources: event.appendSources
                ? [...(turn.sources || []), ...(patch.sources || [])]
                : patch.sources || turn.sources || [],
              metrics: patch.metrics || turn.metrics || {},
            }),
          };
        });
        return event;
      }

      if (event.type === "assistant_final") {
        const draft = draftsRef.current[chatKey];
        const turn = canApplyTurnEvent(draft, turnId);
        if (!turn) {
          debugRuntime("applyTurnEvent:ignored", {
            chatKey,
            turnId,
            eventType: event.type,
            reason: "missing-target-turn",
          });
          return null;
        }
        if (turn.status === TURN_STATUSES.failed) {
          debugRuntime("applyTurnEvent:ignored", {
            chatKey,
            turnId,
            eventType: event.type,
            reason: "target-failed",
          });
          return null;
        }
        debugChatTurn("assistant_final:event", {
          chatKey,
          turnId,
          eventChatId: event.chatId || null,
          eventContentLength: event.content?.length || 0,
          ...turnRuntimeSnapshot(draft, turnId),
        });
        const finalContent =
          event.content && event.content.length > 0
            ? event.content
            : turn?.finalContent || "";
        completeAssistantTurn(chatKey, turnId, {
          finalContent,
          chatId: event.chatId || turn?.chatId,
          sources:
            event.sources?.length > 0 ? event.sources : turn?.sources || [],
          metrics: event.metrics || turn?.metrics || {},
        });
        return event;
      }

      if (event.type === "assistant_error") {
        const turn = canApplyTurnEvent(draftsRef.current[chatKey], turnId);
        if (!turn) {
          debugRuntime("applyTurnEvent:ignored", {
            chatKey,
            turnId,
            eventType: event.type,
            reason: "missing-target-turn",
          });
          return null;
        }
        const reason =
          event.error ||
          event.content ||
          "Chat stream failed before completion.";
        debugChatTurn("assistant_error:event", {
          chatKey,
          turnId,
          reason,
          ...turnRuntimeSnapshot(draftsRef.current[chatKey], turnId),
        });
        appendTimelineEvent(chatKey, turnId, {
          type: "error",
          content: reason,
        });
        failAssistantTurn(chatKey, turnId, reason);
        return event;
      }

      if (event.type === "stop_generation") {
        const turn = canApplyTurnEvent(draftsRef.current[chatKey], turnId);
        if (!turn) {
          debugRuntime("applyTurnEvent:ignored", {
            chatKey,
            turnId,
            eventType: event.type,
            reason: "missing-target-turn",
          });
          return null;
        }
        const reason = event.content || "Generation stopped by user.";
        appendTimelineEvent(chatKey, turnId, {
          type: "error",
          content: reason,
        });
        failAssistantTurn(chatKey, turnId, reason);
        return event;
      }

      return event;
    },
    [
      appendTimelineEvent,
      completeAssistantTurn,
      debugRuntime,
      enqueueAssistantDelta,
      failAssistantTurn,
      markThreadRunning,
      updateDraft,
    ]
  );

  const confirmPersisted = useCallback(
    async (chatKey, turnId, expectedChatId = null, attempt = 0) => {
      const draft = draftsRef.current[chatKey];
      if (!draft || !turnId) return;
      const turn = findAssistantTurn(draft.items, turnId);
      const chatId = expectedChatId || turn?.chatId;
      if (!chatId) return;
      debugRuntime("confirmPersisted:before", {
        chatKey,
        turnId,
        expectedChatId,
        chatId,
        attempt,
      });

      try {
        const history = draft.threadSlug
          ? await Workspace.threads.chatHistory(
              draft.workspaceSlug,
              draft.threadSlug
            )
          : await Workspace.chatHistory(draft.workspaceSlug);
        const persisted = history.find(
          (msg) => msg.role === "assistant" && msg.chatId === chatId
        );
        if (persisted) {
          debugRuntime("confirmPersisted:found", {
            chatKey,
            turnId,
            chatId,
            attempt,
            historyLength: history.length,
          });
          updateDraft(chatKey, (current) => {
            const items = mergeServerHistoryIntoTurnItems(
              history,
              current.items,
              { chatKey }
            );
            const shouldKeepDraft = hasUnfinishedDraft({ ...current, items });
            if (!shouldKeepDraft) {
              removeStoredDraft(current.workspaceSlug, current.threadSlug);
            }
            return {
              ...current,
              items,
              persistError: null,
            };
          });
          return;
        }

        if (attempt < 3) {
          debugRuntime("confirmPersisted:retry", {
            chatKey,
            turnId,
            chatId,
            attempt,
          });
          setTimeout(
            () =>
              confirmPersistedRef.current?.(
                chatKey,
                turnId,
                chatId,
                attempt + 1
              ),
            750 * (attempt + 1)
          );
          return;
        }

        debugRuntime("confirmPersisted:missing", {
          chatKey,
          turnId,
          chatId,
          attempt,
        });
        updateDraft(chatKey, (current) => ({
          ...current,
          persistError:
            "Message completed locally, but server history has not returned the final assistant message yet.",
        }));
      } catch (error) {
        debugRuntime("confirmPersisted:error", {
          chatKey,
          turnId,
          chatId,
          attempt,
          error: error.message,
        });
        updateDraft(chatKey, (current) => ({
          ...current,
          persistError: error.message,
        }));
      }
    },
    [debugRuntime, updateDraft]
  );

  useEffect(() => {
    confirmPersistedRef.current = confirmPersisted;
  }, [confirmPersisted]);

  const scheduleApprovalTimeout = useCallback(
    (chatKey, turnId, approval) => {
      if (!approval?.requestId || !approval.timeoutMs) return;
      const timeoutKey = `${chatKey}:${turnId}:${approval.requestId}`;
      clearTimeout(approvalTimeoutRefs.current[timeoutKey]);
      const elapsed =
        Date.now() - (approval.requestedAt || approval.createdAt || Date.now());
      const remaining = Math.max(0, approval.timeoutMs - elapsed);
      approvalTimeoutRefs.current[timeoutKey] = setTimeout(() => {
        const draft = draftsRef.current[chatKey];
        if (
          draft?.pendingApproval?.requestId !== approval.requestId ||
          draft?.activeTurnId !== turnId
        ) {
          return;
        }
        appendTimelineEvent(chatKey, turnId, {
          type: "approval_result",
          requestId: approval.requestId,
          skillName: approval.skillName,
          approved: false,
          reason: "timeout",
        });
      }, remaining);
    },
    [appendTimelineEvent]
  );

  useEffect(() => {
    Object.entries(drafts).forEach(([chatKey, draft]) => {
      if (draft.pendingApproval && draft.activeTurnId) {
        scheduleApprovalTimeout(
          chatKey,
          draft.activeTurnId,
          draft.pendingApproval
        );
      }
    });
  }, [drafts, scheduleApprovalTimeout]);

  const respondToApproval = useCallback(
    async (chatKey, requestId, approved) => {
      const draft = draftsRef.current[chatKey];
      const approval = draft?.pendingApproval;
      const turnId = draft?.activeTurnId;
      if (!approval || approval.requestId !== requestId || !turnId) return;

      appendTimelineEvent(chatKey, turnId, {
        type: "approval_result",
        requestId,
        skillName: approval.skillName,
        approved: !!approved,
      });

      const socket = websocketRefs.current[chatKey];
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "toolApprovalResponse",
            requestId,
            approved: !!approved,
          })
        );
      }
    },
    [appendTimelineEvent]
  );

  const clearAgentReconnectTimers = useCallback((chatKey, turnId) => {
    const key = agentReconnectKey(chatKey, turnId);
    const session = agentReconnectRefs.current[key];
    if (!session) return;
    if (session.silenceTimer) clearTimeout(session.silenceTimer);
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.silenceTimer = null;
    session.reconnectTimer = null;
  }, []);

  const updateAgentReconnectTurn = useCallback(
    (chatKey, turnId, patch = {}) => {
      updateDraft(chatKey, (draft) => ({
        ...draft,
        items: updateAssistantTurnInItems(draft.items, turnId, {
          reconnectState: patch.reconnectState,
          retryCount: patch.retryCount,
          maxRetries: MAX_AGENT_RECONNECT_ATTEMPTS,
          silenceTimeoutMs: patch.silenceTimeoutMs,
          lastEventSeq: patch.lastEventSeq,
          interruptedContext: patch.interruptedContext,
          updatedAt: Date.now(),
        }),
      }));
    },
    [updateDraft]
  );

  const getOrCreateAgentReconnectSession = useCallback(
    (chatKey, turnId, websocketUUID, options = {}) => {
      const key = agentReconnectKey(chatKey, turnId);
      const existing = agentReconnectRefs.current[key] || {};
      const session = {
        chatKey,
        turnId,
        websocketUUID,
        retryCount: existing.retryCount || 0,
        lastEventSeq: existing.lastEventSeq || 0,
        lastMeaningfulOutputAt: existing.lastMeaningfulOutputAt || Date.now(),
        silenceTimeoutMs:
          existing.silenceTimeoutMs || DEFAULT_AGENT_SILENCE_TIMEOUT_MS,
        originalPrompt: options.prompt || existing.originalPrompt || "",
        displayPrompt:
          options.displayPrompt ||
          existing.displayPrompt ||
          options.prompt ||
          "",
        attachments: options.attachments || existing.attachments || [],
        fileAccessMode:
          options.fileAccessMode ?? existing.fileAccessMode ?? null,
        nodeContext: options.nodeContext ?? existing.nodeContext ?? null,
        threadSlug: options.threadSlug ?? existing.threadSlug ?? null,
        workspaceSlug: options.workspaceSlug ?? existing.workspaceSlug ?? null,
        silenceTimer: existing.silenceTimer || null,
        reconnectTimer: existing.reconnectTimer || null,
      };
      agentReconnectRefs.current[key] = session;
      return session;
    },
    []
  );

  const releaseAgentSocket = useCallback(
    (chatKey, turnId, socket, reason = "assistant_final") => {
      if (!socket || socket.releasedAfterFinal) return;
      socket.releasedAfterFinal = true;
      if (websocketRefs.current[chatKey] === socket) {
        delete websocketRefs.current[chatKey];
      }
      clearAgentReconnectTimers(chatKey, turnId);
      delete agentReconnectRefs.current[agentReconnectKey(chatKey, turnId)];
      setAgentSessionActive(false);
      window.dispatchEvent(new CustomEvent(AGENT_SESSION_END));
      debugRuntime("websocket:released", {
        chatKey,
        turnId,
        reason,
        readyState: socket.readyState,
      });
    },
    [clearAgentReconnectTimers, debugRuntime]
  );

  const openAgentSocket = useCallback(
    (chatKey, turnId, websocketUUID, options = {}) => {
      if (!websocketUUID) return;
      if (websocketRefs.current[chatKey] && !options.forceReconnect) return;
      const session = getOrCreateAgentReconnectSession(
        chatKey,
        turnId,
        websocketUUID,
        options
      );
      const query = new URLSearchParams();
      if (session.lastEventSeq > 0 || session.retryCount > 0) {
        query.set("resume", "1");
        query.set("lastEventSeq", String(session.lastEventSeq || 0));
      }
      const socket = new WebSocket(
        `${websocketURI()}/api/agent-invocation/${websocketUUID}${
          query.toString() ? `?${query.toString()}` : ""
        }`
      );
      socket.supportsAgentStreaming = false;
      websocketRefs.current[chatKey] = socket;

      setAgentSessionActive(true);
      window.dispatchEvent(new CustomEvent(AGENT_SESSION_START));
      updateDraft(chatKey, (draft) => ({
        ...draft,
        activeTurnId: turnId,
        isAgentRunning: true,
        isStreaming: false,
        persistError: null,
      }));
      updateAgentReconnectTurn(chatKey, turnId, {
        reconnectState: session.retryCount > 0 ? "retrying" : "idle",
        retryCount: session.retryCount,
        silenceTimeoutMs: session.silenceTimeoutMs,
        lastEventSeq: session.lastEventSeq,
      });
      markThreadRunning(chatKey, turnId);

      Workspace.agentInvocationState(websocketUUID).then((result) => {
        const timeoutMs = Number(result?.state?.silenceTimeoutMs);
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          session.silenceTimeoutMs = timeoutMs;
          updateAgentReconnectTurn(chatKey, turnId, {
            reconnectState: session.retryCount > 0 ? "retrying" : "idle",
            retryCount: session.retryCount,
            silenceTimeoutMs: timeoutMs,
            lastEventSeq: session.lastEventSeq,
          });
        }
      });

      const offerReconnect = (reason) => {
        clearAgentReconnectTimers(chatKey, turnId);
        const draft = draftsRef.current[chatKey];
        const turn = findAssistantTurn(draft?.items || [], turnId);
        const userMessage = draft?.items?.find(
          (item) => item.id === turn?.userMessageId
        );
        const toolEvents = (turn?.timeline || [])
          .filter((event) => ["tool_call", "tool_result"].includes(event.type))
          .slice(-12)
          .map((event) => ({
            type: event.type,
            toolName: event.toolName,
            content: truncateText(
              event.summary || event.content || event.outputPreview || "",
              MAX_TOOL_OUTPUT_PREVIEW_CHARS
            ),
            runId: event.runId,
          }));
        const interruptedContext = {
          reason,
          originalPrompt: session.originalPrompt || userMessage?.content || "",
          displayPrompt: session.displayPrompt || userMessage?.content || "",
          partialAnswer: turn?.finalContent || "",
          toolEvents,
          attachments: session.attachments || [],
          fileAccessMode: session.fileAccessMode || null,
          nodeContext: session.nodeContext || null,
          lastEventSeq: session.lastEventSeq || 0,
          retryCount: session.retryCount,
          websocketUUID,
        };
        updateDraft(chatKey, (current) => ({
          ...current,
          items: updateAssistantTurnInItems(current.items, turnId, {
            status: TURN_STATUSES.interrupted,
            reconnectState: "offer",
            retryCount: session.retryCount,
            maxRetries: MAX_AGENT_RECONNECT_ATTEMPTS,
            silenceTimeoutMs: session.silenceTimeoutMs,
            lastEventSeq: session.lastEventSeq || 0,
            interruptedContext,
            error: null,
            updatedAt: Date.now(),
          }),
          activeTurnId:
            current.activeTurnId === turnId ? null : current.activeTurnId,
          pendingApproval: null,
          activeToolCall: null,
          isStreaming: false,
          isAgentRunning: false,
          persistError: null,
        }));
        clearThreadRunning(chatKey, turnId);
        setAgentSessionActive(false);
        window.dispatchEvent(new CustomEvent(AGENT_SESSION_END));
      };

      const scheduleReconnect = (reason) => {
        if (socket.sawFinalMessage || socket.lastFinalChatId) return false;
        if (stoppedThreadRefs.current[chatKey]) return false;
        if (session.retryCount >= MAX_AGENT_RECONNECT_ATTEMPTS) {
          offerReconnect(reason);
          return true;
        }

        session.retryCount += 1;
        const delay = reconnectBackoff(session.retryCount);
        updateAgentReconnectTurn(chatKey, turnId, {
          reconnectState: "retrying",
          retryCount: session.retryCount,
          silenceTimeoutMs: session.silenceTimeoutMs,
          lastEventSeq: session.lastEventSeq || 0,
        });
        appendTimelineEvent(chatKey, turnId, {
          type: "thought",
          content: `Agent connection interrupted. Reconnecting ${session.retryCount}/${MAX_AGENT_RECONNECT_ATTEMPTS}...`,
        });
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = setTimeout(() => {
          openAgentSocket(chatKey, turnId, websocketUUID, {
            ...options,
            forceReconnect: true,
          });
        }, delay);
        return true;
      };

      const scheduleSilenceTimer = () => {
        clearTimeout(session.silenceTimer);
        session.silenceTimer = setTimeout(() => {
          socket.silenceTimedOut = true;
          debugChatTurn("websocket:silence-timeout", {
            chatKey,
            turnId,
            timeoutMs: session.silenceTimeoutMs,
            lastEventSeq: session.lastEventSeq || 0,
          });
          if (websocketRefs.current[chatKey] === socket) socket.close();
        }, session.silenceTimeoutMs || DEFAULT_AGENT_SILENCE_TIMEOUT_MS);
      };
      scheduleSilenceTimer();

      socket.addEventListener("message", (event) => {
        const normalizedEvent = handleSocketResponse(socket, event);
        if (
          ["agent_replay_start", "agent_replay_end"].includes(
            normalizedEvent?.type
          )
        ) {
          return;
        }
        if (
          normalizedEvent?.seq &&
          normalizedEvent.seq <= (session.lastEventSeq || 0)
        ) {
          return;
        }
        if (normalizedEvent?.seq) {
          session.lastEventSeq = normalizedEvent.seq;
          updateAgentReconnectTurn(chatKey, turnId, {
            reconnectState: session.retryCount > 0 ? "retrying" : "idle",
            retryCount: session.retryCount,
            silenceTimeoutMs: session.silenceTimeoutMs,
            lastEventSeq: session.lastEventSeq,
          });
        }
        if (isMeaningfulAgentEvent(normalizedEvent)) {
          session.lastMeaningfulOutputAt = Date.now();
          scheduleSilenceTimer();
        }
        debugChatTurn("websocket:event", {
          chatKey,
          turnId,
          eventType: normalizedEvent?.type || null,
        });
        const applied = applyTurnEvent(chatKey, turnId, normalizedEvent);
        if (applied?.type === "timeline_event") {
          const timelineEvent = normalizeTimelineEvent(applied.event || {});
          if (timelineEvent.type === "approval_request") {
            scheduleApprovalTimeout(chatKey, turnId, timelineEvent);
          }
        }
        if (applied?.type === "assistant_final" && applied.chatId) {
          socket.lastFinalChatId = applied.chatId;
        }
        if (applied?.type === "assistant_final") {
          socket.sawFinalMessage = true;
          releaseAgentSocket(chatKey, turnId, socket, "assistant_final");
          setTimeout(() => {
            if (socket.readyState === WebSocket.OPEN) socket.close();
          }, 250);
        }
        if (applied?.type === "assistant_error") {
          erroredThreadRefs.current[chatKey] = true;
          socket.close();
        }
      });

      socket.addEventListener("close", () => {
        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        session.silenceTimer = null;
        if (websocketRefs.current[chatKey] === socket) {
          delete websocketRefs.current[chatKey];
        }
        if (!socket.releasedAfterFinal) {
          setAgentSessionActive(false);
          window.dispatchEvent(new CustomEvent(AGENT_SESSION_END));
        }
        debugChatTurn("websocket:close", {
          chatKey,
          turnId,
          sawFinalMessage: !!socket.sawFinalMessage,
          lastFinalChatId: socket.lastFinalChatId || null,
          stopped: !!stoppedThreadRefs.current[chatKey],
          errored: !!erroredThreadRefs.current[chatKey],
          ...turnRuntimeSnapshot(draftsRef.current[chatKey], turnId),
        });
        if (stoppedThreadRefs.current[chatKey]) {
          clearThreadRunning(chatKey, turnId);
        } else if (erroredThreadRefs.current[chatKey]) {
          scheduleReconnect("Agent websocket connection failed.");
        } else if (socket.sawFinalMessage || socket.lastFinalChatId) {
          markThreadCompleted(chatKey, turnId);
        } else {
          scheduleReconnect(
            socket.silenceTimedOut
              ? "Agent response timed out because no output was received."
              : "Agent websocket closed before a final response."
          );
        }
        stoppedThreadRefs.current[chatKey] = false;
        erroredThreadRefs.current[chatKey] = false;
        if (socket.sawFinalMessage || socket.lastFinalChatId) {
          setTimeout(
            () =>
              confirmPersisted(chatKey, turnId, socket.lastFinalChatId || null),
            500
          );
        }
      });

      socket.addEventListener("error", () => {
        erroredThreadRefs.current[chatKey] = true;
        if (websocketRefs.current[chatKey] === socket) socket.close();
      });
    },
    [
      applyTurnEvent,
      appendTimelineEvent,
      clearThreadRunning,
      clearAgentReconnectTimers,
      confirmPersisted,
      getOrCreateAgentReconnectSession,
      releaseAgentSocket,
      markThreadCompleted,
      markThreadRunning,
      scheduleApprovalTimeout,
      updateAgentReconnectTurn,
      updateDraft,
    ]
  );

  const startStream = useCallback(
    async ({
      workspaceSlug,
      threadSlug = null,
      prompt,
      displayPrompt = null,
      readerTextSources = [],
      attachments = [],
      fileAccessMode = null,
      nodeContext = null,
      history = [],
      parseAttachments = () => [],
      sendToExistingAgent = false,
      clientGeneratedTurnId = null,
    }) => {
      const chatKey = ensureDraft({
        workspaceSlug,
        threadSlug,
        history,
      });
      debugRuntime("startStream:entry", {
        chatKey,
        workspaceSlug,
        threadSlug,
        sendToExistingAgent,
        fileAccessMode,
        historyLength: history.length,
      });
      const socket = websocketRefs.current[chatKey];
      const preparedAttachments = attachments || parseAttachments();
      const { turnId, items: turnItems } = createTurn({
        prompt: displayPrompt || prompt,
        attachments: preparedAttachments,
        readerTextSources,
        chatKey,
        turnId: clientGeneratedTurnId || undefined,
      });
      delete settledTurnRefs.current[turnRefKey(chatKey, turnId)];
      debugRuntime("createTurn:created", {
        chatKey,
        turnId,
        promptLength: prompt?.length || 0,
        attachmentCount: preparedAttachments.length,
      });

      updateDraft(chatKey, (draft) => ({
        ...draft,
        items: [...(draft.items || []), ...turnItems],
        activeTurnId: turnId,
        pendingApproval: null,
        activeToolCall: null,
        isStreaming: !sendToExistingAgent,
        isAgentRunning: !!sendToExistingAgent,
        persistError: null,
      }));
      debugRuntime("startStream:turnScheduled", {
        chatKey,
        turnId,
        sendToExistingAgent,
      });
      markThreadRunning(chatKey, turnId);
      window.dispatchEvent(
        new CustomEvent("anythingllm-document-reader-associate-selection", {
          detail: { chatKey, clientGeneratedTurnId: turnId, turnId },
        })
      );

      if (sendToExistingAgent && socket?.readyState === WebSocket.OPEN) {
        debugRuntime("startStream:sendToExistingAgent", {
          chatKey,
          turnId,
        });
        socket.send(
          JSON.stringify({
            type: "awaitingFeedback",
            feedback: prompt,
            attachments: preparedAttachments,
            fileAccess: { mode: fileAccessMode },
            nodeContext,
          })
        );
        appendTimelineEvent(chatKey, turnId, {
          type: "thought",
          content: "Sent follow-up input to the active agent session.",
        });
        return;
      }

      try {
        let completedChatId = null;
        await Workspace.multiplexStream({
          workspaceSlug,
          threadSlug,
          prompt,
          chatHandler: (chatResult) => {
            const event = handleChat(chatResult);
            debugChatTurn("sse:event", {
              chatKey,
              turnId,
              rawType: chatResult?.type || null,
              eventType: event?.type || null,
              close: !!chatResult?.close,
            });
            const applied = applyTurnEvent(chatKey, turnId, event);
            if (applied?.type === "agent_socket_start") {
              openAgentSocket(chatKey, turnId, applied.websocketUUID, {
                workspaceSlug,
                threadSlug,
                prompt,
                displayPrompt: displayPrompt || prompt,
                attachments: preparedAttachments,
                fileAccessMode,
                nodeContext,
              });
            }
            if (applied?.type === "assistant_final") {
              completedChatId = applied.chatId || completedChatId;
            }
          },
          attachments: preparedAttachments,
          fileAccessMode,
          nodeContext,
        });
        setTimeout(
          () => confirmPersisted(chatKey, turnId, completedChatId),
          500
        );
        if (threadSlug) {
          [1_000, 3_000, 7_000, 15_000].forEach((delay) => {
            setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent(WORKSPACE_THREADS_REFRESH_EVENT, {
                  detail: { workspaceSlug },
                })
              );
            }, delay);
          });
        }
        debugRuntime("startStream:streamResolved", {
          chatKey,
          turnId,
          completedChatId,
        });
      } catch (error) {
        debugRuntime("startStream:error", {
          chatKey,
          turnId,
          error: error.message,
        });
        applyTurnEvent(chatKey, turnId, {
          type: "assistant_error",
          content: error.message || "Chat stream failed.",
          error: error.message || "Chat stream failed.",
        });
      }
    },
    [
      appendTimelineEvent,
      applyTurnEvent,
      confirmPersisted,
      debugRuntime,
      ensureDraft,
      markThreadRunning,
      openAgentSocket,
      updateDraft,
    ]
  );

  const startLocalTurn = useCallback(
    ({ workspaceSlug, threadSlug = null, prompt, history = [] }) => {
      const chatKey = ensureDraft({
        workspaceSlug,
        threadSlug,
        history,
      });
      const { turnId, items: turnItems } = createTurn({
        prompt,
        chatKey,
      });
      delete settledTurnRefs.current[turnRefKey(chatKey, turnId)];
      updateDraft(chatKey, (draft) => ({
        ...draft,
        items: [...(draft.items || []), ...turnItems],
        activeTurnId: turnId,
        pendingApproval: null,
        activeToolCall: null,
        isStreaming: true,
        isAgentRunning: false,
        persistError: null,
      }));
      markThreadRunning(chatKey, turnId);
      return { chatKey, turnId };
    },
    [ensureDraft, markThreadRunning, updateDraft]
  );

  const continueInterruptedAgentTurn = useCallback(
    (chatKey, turnId, shouldReconnect) => {
      const draft = draftsRef.current[chatKey];
      const turn = findAssistantTurn(draft?.items || [], turnId);
      if (!draft || !turn?.interruptedContext) return;

      if (!shouldReconnect) {
        updateDraft(chatKey, (current) => ({
          ...current,
          items: updateAssistantTurnInItems(current.items, turnId, {
            reconnectState: "failed",
            updatedAt: Date.now(),
          }),
        }));
        return;
      }

      const context = turn.interruptedContext;
      const toolSummary = (context.toolEvents || [])
        .map((event, index) => {
          const label =
            event.type === "tool_result" ? "tool result" : "tool call";
          return `${index + 1}. ${label}: ${event.toolName || "unknown"}${
            event.runId ? ` runId=${event.runId}` : ""
          }\n${event.content || ""}`;
        })
        .join("\n\n");
      const continuationPrompt = `@agent Continue the interrupted agent response below. Do not repeat completed tool calls unless the existing tool result is insufficient. Prefer the provided tool results and partial answer, then finish the user's answer.\n\n<interrupted_agent_context>\nreason: ${context.reason || "connection interrupted"}\nlastEventSeq: ${context.lastEventSeq || 0}\nretryCount: ${context.retryCount || 0}\n\n<original_user_prompt>\n${context.originalPrompt || ""}\n</original_user_prompt>\n\n<partial_answer>\n${context.partialAnswer || ""}\n</partial_answer>\n\n<completed_tool_events>\n${toolSummary || "No completed tool events were recorded."}\n</completed_tool_events>\n</interrupted_agent_context>`;

      updateDraft(chatKey, (current) => ({
        ...current,
        items: updateAssistantTurnInItems(current.items, turnId, {
          reconnectState: "continuing",
          updatedAt: Date.now(),
        }),
      }));

      startStream({
        workspaceSlug: draft.workspaceSlug,
        threadSlug: draft.threadSlug,
        prompt: continuationPrompt,
        displayPrompt: "继续断开的代理会话",
        attachments: context.attachments || [],
        fileAccessMode: context.fileAccessMode || null,
        nodeContext: context.nodeContext || null,
        history: [],
        clientGeneratedTurnId: createTurnId(),
      });
    },
    [startStream, updateDraft]
  );

  const stopStream = useCallback(
    (chatKey = null) => {
      const keys = chatKey ? [chatKey] : Object.keys(draftsRef.current);
      keys.forEach((key) => {
        const draft = draftsRef.current[key];
        const turnId = draft?.activeTurnId;
        if (!turnId) return;
        stoppedThreadRefs.current[key] = true;
        const socket = websocketRefs.current[key];
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({ type: "awaitingFeedback", feedback: "/exit" })
          );
        }
        socket?.close();
        applyTurnEvent(key, turnId, {
          type: "stop_generation",
          content: "Generation stopped by user.",
        });
      });
    },
    [applyTurnEvent]
  );

  useEffect(() => {
    const stopAll = () => stopStream();
    window.addEventListener(ABORT_STREAM_EVENT, stopAll);
    return () => window.removeEventListener(ABORT_STREAM_EVENT, stopAll);
  }, [stopStream]);

  useEffect(() => {
    return () => {
      Object.values(websocketRefs.current).forEach((socket) => socket?.close());
      Object.values(approvalTimeoutRefs.current).forEach((timeout) =>
        clearTimeout(timeout)
      );
      Object.values(agentReconnectRefs.current).forEach((session) => {
        if (session?.silenceTimer) clearTimeout(session.silenceTimer);
        if (session?.reconnectTimer) clearTimeout(session.reconnectTimer);
      });
    };
  }, []);

  const mergeServerHistory = useCallback(
    ({ workspaceSlug, threadSlug = null, history = [] }) => {
      const chatKey = ensureDraft({ workspaceSlug, threadSlug });
      debugRuntime("mergeServerHistory:before", {
        chatKey,
        historyLength: history.length,
        ...draftHistoryIntegrity(draftsRef.current[chatKey]),
      });
      updateDraft(chatKey, (draft) => {
        const beforeIntegrity = draftHistoryIntegrity(draft);
        const items = mergeServerHistoryIntoTurnItems(history, draft.items, {
          chatKey,
        });
        const next = {
          ...draft,
          items,
        };
        const afterIntegrity = draftHistoryIntegrity(next);
        debugRuntime("mergeServerHistory:after", {
          chatKey,
          turnId: next.activeTurnId || null,
          draft: next,
          historyLength: history.length,
          beforeBlankServerBackedUserItemCount:
            beforeIntegrity.blankServerBackedUserItemCount,
          beforeUserItemCount: beforeIntegrity.userItemCount,
          ...afterIntegrity,
        });
        return next;
      });
      return chatKey;
    },
    [debugRuntime, ensureDraft, updateDraft]
  );

  const getDraft = useCallback(
    (workspaceSlug, threadSlug = null) =>
      draftsRef.current[getChatThreadKey(workspaceSlug, threadSlug)] || null,
    []
  );

  const getDraftByKey = useCallback(
    (chatKey) => draftsRef.current[chatKey] || null,
    []
  );

  const subscribeDraft = useCallback(
    (chatKey, listener) =>
      subscribeListener(draftListenersRef, chatKey, listener),
    [subscribeListener]
  );

  const hasWorkspaceActivity = useCallback(
    (workspaceSlug) =>
      Object.values(draftsRef.current).some(
        (draft) =>
          draft.workspaceSlug === workspaceSlug && hasUnfinishedDraft(draft)
      ) ||
      Object.values(runningStateRef.current.threadActivityByKey || {}).some(
        (activity) =>
          activity.workspaceSlug === workspaceSlug &&
          activity.status === TURN_STATUSES.running
      ),
    []
  );

  const getThreadActivity = useCallback((workspaceSlug, threadSlug = null) => {
    const chatKey = getChatThreadKey(workspaceSlug, threadSlug);
    return runningStateRef.current.threadActivityByKey?.[chatKey] || null;
  }, []);

  const getThreadActivityByKey = useCallback(
    (chatKey) => runningStateRef.current.threadActivityByKey?.[chatKey] || null,
    []
  );

  const subscribeThreadActivity = useCallback(
    (chatKey, listener) =>
      subscribeListener(activityListenersRef, chatKey || "*", listener),
    [subscribeListener]
  );

  const getActivityVersion = useCallback(() => activityVersionRef.current, []);

  const hasThreadActivity = useCallback(
    (workspaceSlug, threadSlug = null) => {
      const activity = getThreadActivity(workspaceSlug, threadSlug);
      return activity?.status === TURN_STATUSES.running ? activity : null;
    },
    [getThreadActivity]
  );

  const getRunningThreads = useCallback(
    () =>
      Object.values(runningStateRef.current.threadActivityByKey || {}).filter(
        (activity) => activity.status === TURN_STATUSES.running
      ),
    []
  );

  const getRunningThread = useCallback((workspaceSlug) => {
    const runningThreads = Object.values(
      runningStateRef.current.threadActivityByKey || {}
    ).filter(
      (activity) =>
        activity.workspaceSlug === workspaceSlug &&
        activity.status === TURN_STATUSES.running
    );
    return runningThreads.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  }, []);

  const getAssistantTurnByChatId = useCallback((chatKey, chatId) => {
    return assistantTurnByChatId(
      draftsRef.current[chatKey]?.items || [],
      chatId
    );
  }, []);

  const updateUserItem = useCallback(
    (chatKey, chatId, patch = {}) => {
      updateDraft(chatKey, (draft) => ({
        ...draft,
        items: draft.items.map((item) =>
          item.type === "user" && item.chatId === chatId
            ? { ...item, ...patch, updatedAt: Date.now() }
            : item
        ),
      }));
    },
    [updateDraft]
  );

  const value = useMemo(
    () => ({
      getDraft,
      getDraftByKey,
      subscribeDraft,
      ensureDraft,
      mergeServerHistory,
      createTurn,
      appendTimelineEvent,
      updateAssistantTurn,
      completeAssistantTurn,
      failAssistantTurn,
      startStream,
      startLocalTurn,
      continueInterruptedAgentTurn,
      respondToApproval,
      stopStream,
      hasWorkspaceActivity,
      hasThreadActivity,
      getThreadActivity,
      getThreadActivityByKey,
      getActivityVersion,
      subscribeThreadActivity,
      getRunningThreads,
      getRunningThread,
      getAssistantTurnByChatId,
      updateUserItem,
      clearThreadActivity,
      getThreadPath,
      getChatKey: getChatThreadKey,
    }),
    [
      appendTimelineEvent,
      clearThreadActivity,
      completeAssistantTurn,
      continueInterruptedAgentTurn,
      ensureDraft,
      failAssistantTurn,
      getAssistantTurnByChatId,
      getDraft,
      getDraftByKey,
      getRunningThread,
      getRunningThreads,
      getThreadActivity,
      getThreadActivityByKey,
      getActivityVersion,
      hasThreadActivity,
      hasWorkspaceActivity,
      mergeServerHistory,
      respondToApproval,
      startStream,
      startLocalTurn,
      stopStream,
      subscribeDraft,
      subscribeThreadActivity,
      updateAssistantTurn,
      updateUserItem,
    ]
  );

  return (
    <ChatThreadDraftContext.Provider value={value}>
      {children}
    </ChatThreadDraftContext.Provider>
  );
}

export function useChatThreadDrafts() {
  const context = useContext(ChatThreadDraftContext);
  if (!context)
    throw new Error(
      "useChatThreadDrafts must be used within ChatThreadDraftProvider"
    );
  return context;
}

export function useChatDraft(workspaceSlug, threadSlug = null) {
  const context = useChatThreadDrafts();
  const chatKey = getChatThreadKey(workspaceSlug, threadSlug);
  return useSyncExternalStore(
    (listener) => context.subscribeDraft(chatKey, listener),
    () => context.getDraftByKey(chatKey),
    () => context.getDraftByKey(chatKey)
  );
}

export function useThreadActivity(workspaceSlug, threadSlug = null) {
  const context = useChatThreadDrafts();
  const chatKey = getChatThreadKey(workspaceSlug, threadSlug);
  return useSyncExternalStore(
    (listener) => context.subscribeThreadActivity(chatKey, listener),
    () => context.getThreadActivityByKey(chatKey),
    () => context.getThreadActivityByKey(chatKey)
  );
}

export function useThreadActivitySnapshot() {
  const context = useChatThreadDrafts();
  useSyncExternalStore(
    (listener) => context.subscribeThreadActivity("*", listener),
    () => context.getActivityVersion(),
    () => context.getActivityVersion()
  );
  return context.getRunningThreads();
}
