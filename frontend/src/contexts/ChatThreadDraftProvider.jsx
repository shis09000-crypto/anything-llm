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
import { ABORT_STREAM_EVENT } from "@/utils/chat";
import {
  buildChatStreamBody,
  streamWorkspaceChat,
  streamWorkspaceThreadChat,
} from "@/lib/communication/chatStreamClient";
import { respondToChatToolApproval } from "@/lib/communication/chatControlClient";
import {
  AgentSessionState,
  canReuseAgentSessionForInvocation,
  createAgentWebSocketSession,
  respondToClarificationViaHttp,
} from "@/lib/communication/agentWebSocketClient";
import { debugChatTurn } from "@/utils/chat/debug";
import { emitAssistantMessageCompleteEvent } from "@/components/contexts/TTSProvider";
import { safeJsonParse } from "@/utils/request";
import {
  TURN_STATUSES,
  appendTimelineEventToItems,
  cleanupTransientDraftItems,
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
import {
  fetchPersistedChatHydration,
  persistedHydratedChatHistory,
} from "@/utils/chat/persistedTurn";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { storageKeys } from "@/utils/appEnvironment";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import {
  decryptLocalCachePayload,
  encryptLocalCachePayload,
} from "@/utils/security/localCacheCrypto";

const ChatThreadDraftContext = createContext(null);
const STORAGE_PREFIX = "chat-thread-draft";
const ACTIVE_RUNNING_STORAGE_KEY = "chat-thread-active-running";
const SEALED_SESSION_STORAGE_VERSION = "athena-chat-thread-runtime:v1";
const RUNNING_STALE_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_DRAFT_STORAGE_CHARS = 450_000;
const MAX_FINAL_CONTENT_STORAGE_CHARS = 5_000;
const MAX_TIMELINE_EVENT_CHARS = 500;
const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 500;
const MAX_CLARIFYING_QUESTIONS = 3;
const MAX_CLARIFYING_CHOICE_OPTIONS = 3;
const MAX_STORED_TIMELINE_EVENTS = 20;
const MAX_STORED_SOURCE_COUNT = 8;
const MAX_SOURCE_FIELD_CHARS = 300;
const MAX_RETAINED_INACTIVE_DRAFTS = 4;
const MAX_COMPACT_INACTIVE_ITEMS = 40;
const MAX_COMPACT_FINAL_CONTENT_CHARS = 2_000;
const MAX_AGENT_RECONNECT_ATTEMPTS = 5;
const DEFAULT_AGENT_SILENCE_TIMEOUT_MS = 90_000;
const AGENT_SOCKET_STARTUP_TIMEOUT_MS = 15_000;
const RUNNING_DRAFT_STORAGE_GRACE_MS = 10 * 60 * 1000;
const LATEST_HISTORY_REFRESH_LIMIT = 30;
const AGENT_RECONNECT_TURN_FIELDS = [
  "websocketUUID",
  "agentProvider",
  "agentModel",
  "agentModelTier",
  "silenceTimeoutMs",
  "reconnectAttemptStartedAt",
  "reconnectDueAt",
  "lastEventSeq",
  "interruptedContext",
];
const encryptedSessionWriteVersions = new Map();

function agentReconnectKey(chatKey, turnId) {
  return `${chatKey}:${turnId}`;
}

function compactClarifyingQuestions(questions = []) {
  if (!Array.isArray(questions)) return [];
  return questions.slice(0, MAX_CLARIFYING_QUESTIONS).map((question) => {
    const compacted = { ...question };
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

function clarificationPayloadFromText(clarification, text = "") {
  const answer = String(text || "").trim();
  const questions = Array.isArray(clarification?.questions)
    ? clarification.questions
    : [];
  return {
    skipped: false,
    answers: (questions.length ? questions : [null]).map(() => ({
      skipped: false,
      answer,
    })),
  };
}

export function getChatThreadKey(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) return null;
  return `${workspaceSlug}:${threadSlug || "default"}`;
}

function getStorageKey(workspaceSlug, threadSlug = null) {
  return `${STORAGE_PREFIX}:${workspaceSlug}:${threadSlug || "default"}`;
}

function storageCryptoNamespace(key) {
  return `chat-runtime:${String(key || "").slice(0, 512)}`;
}

function isSealedSessionStorageValue(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.sealed === true &&
      value.cryptoVersion === SEALED_SESSION_STORAGE_VERSION &&
      value.encryptedPayload?.encrypted
  );
}

function readSessionJson(key, fallback = null) {
  if (typeof window === "undefined" || !key) return fallback;
  try {
    return safeJsonParse(sessionStorage.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

async function readSealedSessionValue(key, fallback = null) {
  const value = readSessionJson(key, fallback);
  if (!isSealedSessionStorageValue(value)) return value;
  try {
    return await decryptLocalCachePayload({
      namespace: storageCryptoNamespace(key),
      encryptedPayload: value.encryptedPayload,
    });
  } catch (error) {
    debugChatTurn("secureStorage:decryptFailed", {
      key,
      error: error?.message || String(error),
    });
    return fallback;
  }
}

function persistSealedSessionValue(key, payload, { maxLength = null } = {}) {
  if (typeof window === "undefined" || !key) return;

  let serialized = "";
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    debugChatTurn("secureStorage:serializeFailed", {
      key,
      error: error?.message || String(error),
    });
    sessionStorage.removeItem(key);
    return;
  }

  if (maxLength && serialized.length > maxLength) {
    const sizeError = new Error("Secure storage payload exceeded limit.");
    sizeError.name = "QuotaExceededError";
    sizeError.serializedLength = serialized.length;
    throw sizeError;
  }

  const version = (encryptedSessionWriteVersions.get(key) || 0) + 1;
  encryptedSessionWriteVersions.set(key, version);
  sessionStorage.removeItem(key);
  encryptLocalCachePayload({
    namespace: storageCryptoNamespace(key),
    payload,
  })
    .then((encryptedPayload) => {
      if (encryptedSessionWriteVersions.get(key) !== version) return;
      if (!encryptedPayload?.encrypted) {
        throw new Error("secure_storage_encryption_unavailable");
      }
      sessionStorage.setItem(
        key,
        JSON.stringify({
          sealed: true,
          cryptoVersion: SEALED_SESSION_STORAGE_VERSION,
          encryptedPayload,
        })
      );
    })
    .catch((error) => {
      if (encryptedSessionWriteVersions.get(key) !== version) return;
      debugChatTurn("secureStorage:writeFailed", {
        key,
        error: error?.message || String(error),
      });
      sessionStorage.removeItem(key);
    });
}

function removeSealedSessionValue(key) {
  if (typeof window === "undefined" || !key) return;
  encryptedSessionWriteVersions.set(
    key,
    (encryptedSessionWriteVersions.get(key) || 0) + 1
  );
  sessionStorage.removeItem(key);
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
    pendingClarification: null,
    activeToolCall: null,
    isStreaming: false,
    isAgentRunning: false,
    updatedAt: Date.now(),
    persistError: null,
    tailHydration: null,
    tailCleanup: null,
  };
}

function draftFromStorageValue(value) {
  if (!value || !value.workspaceSlug) return null;
  const now = Date.now();
  const updatedAt = value.updatedAt || now;
  const storedItems = normalizeTurnItems(
    Array.isArray(value.items) ? value.items : []
  );
  const { items, removedTurnIds } = cleanupTransientDraftItems(storedItems, {
    now,
    runningMaxAgeMs: RUNNING_DRAFT_STORAGE_GRACE_MS,
  });
  const removedTurnIdSet = new Set(removedTurnIds);
  const storedTail = storedItems[storedItems.length - 1] || null;
  const removedTail =
    storedTail?.turnId && removedTurnIdSet.has(storedTail.turnId);
  const activeTurnId =
    value.activeTurnId && !removedTurnIdSet.has(value.activeTurnId)
      ? value.activeTurnId
      : null;
  const activeTurn = findAssistantTurn(items, activeTurnId);
  const hasRunningTurn = items.some(
    (item) => isAssistantTurn(item) && item.status === TURN_STATUSES.running
  );
  const keepActiveRuntime =
    activeTurn?.status === TURN_STATUSES.running && hasRunningTurn;
  const draft = {
    workspaceSlug: value.workspaceSlug,
    threadSlug: value.threadSlug ?? null,
    items,
    activeTurnId: keepActiveRuntime ? activeTurnId : null,
    pendingApproval: keepActiveRuntime ? value.pendingApproval || null : null,
    pendingClarification: keepActiveRuntime
      ? value.pendingClarification || null
      : null,
    activeToolCall: keepActiveRuntime ? value.activeToolCall || null : null,
    isStreaming:
      keepActiveRuntime && activeTurn?.reconnectState !== "retrying"
        ? !!value.isStreaming
        : false,
    isAgentRunning:
      keepActiveRuntime &&
      (value.isAgentRunning || !!activeTurn?.websocketUUID),
    updatedAt,
    persistError: removedTurnIds.length > 0 ? null : value.persistError || null,
    tailHydration: null,
    tailCleanup: removedTail
      ? {
          seq: 1,
          turnIds: removedTurnIds,
          removedItemIds: storedItems
            .filter((item) => removedTurnIdSet.has(item.turnId))
            .map((item) => item.id)
            .filter(Boolean),
          reason: "storage-restore",
          updatedAt: now,
        }
      : null,
  };
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

  if (event.type === "clarification_request") {
    return {
      ...base,
      requestId: event.requestId,
      questions: compactClarifyingQuestions(event.questions),
      allowSkip: event.allowSkip,
      timeoutMs: event.timeoutMs,
      requestedAt: event.requestedAt,
    };
  }

  if (event.type === "clarification_result") {
    return {
      ...base,
      requestId: event.requestId,
      skipped: event.skipped,
      timedOut: event.timedOut,
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
      publicChatId: item.publicChatId || null,
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
      publicChatId: item.publicChatId || null,
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
      websocketUUID: item.websocketUUID || null,
      agentProvider: item.agentProvider || null,
      agentModel: item.agentModel || null,
      agentModelTier: item.agentModelTier || null,
      silenceTimeoutMs: item.silenceTimeoutMs || null,
      reconnectAttemptStartedAt: item.reconnectAttemptStartedAt || null,
      reconnectDueAt: item.reconnectDueAt || null,
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
    pendingClarification: minimal
      ? null
      : sanitizeTimelineEventForStorage(draft.pendingClarification),
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
  return (
    draftHistoryIntegrity(draft).blankServerBackedUserItemCount > 0 ||
    (draft.items || []).some(
      (item) =>
        isAssistantTurn(item) &&
        item.status === TURN_STATUSES.completed &&
        !item.chatId
    )
  );
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
    draft.pendingClarification ||
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
    draft.pendingClarification ||
    draft.activeToolCall
  );

  if (
    !hasRuntimeState ||
    draft.pendingApproval ||
    draft.pendingClarification ||
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
    pendingClarification: null,
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
    pendingClarification: null,
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
    removeSealedSessionValue(key);
    return;
  }

  try {
    const payload = serializeDraftForStorage(draft);
    const serialized = JSON.stringify(payload);
    debugChatTurn("persistDraft:storageSize", {
      key,
      serializedLength: serialized.length,
      maxLength: MAX_DRAFT_STORAGE_CHARS,
      minimal: false,
      ...draftHistoryIntegrity(draft),
    });
    persistSealedSessionValue(key, payload, {
      maxLength: MAX_DRAFT_STORAGE_CHARS,
    });
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
      const minimalPayload = serializeDraftForStorage(draft, { minimal: true });
      const minimalSerialized = JSON.stringify(minimalPayload);
      debugChatTurn("persistDraft:storageSize", {
        key,
        serializedLength: minimalSerialized.length,
        maxLength: MAX_DRAFT_STORAGE_CHARS,
        minimal: true,
        ...draftHistoryIntegrity(draft),
      });
      persistSealedSessionValue(key, minimalPayload, {
        maxLength: MAX_DRAFT_STORAGE_CHARS,
      });
    } catch (minimalError) {
      debugChatTurn("persistDraft:storageDropped", {
        key,
        error: minimalError?.message || String(minimalError),
      });
      removeSealedSessionValue(key);
    }
  }
}

function removeStoredDraft(workspaceSlug, threadSlug = null) {
  if (typeof window === "undefined" || !workspaceSlug) return;
  removeSealedSessionValue(getStorageKey(workspaceSlug, threadSlug));
}

function restoreStoredDrafts() {
  if (typeof window === "undefined") return {};
  const drafts = {};
  for (const key of storageKeys(sessionStorage)) {
    if (!key?.startsWith(`${STORAGE_PREFIX}:`)) continue;
    const value = safeJsonParse(sessionStorage.getItem(key));
    if (isSealedSessionStorageValue(value)) continue;
    const draft = draftFromStorageValue(value);
    if (!draft) continue;
    const chatKey = getChatThreadKey(draft.workspaceSlug, draft.threadSlug);
    drafts[chatKey] = draft;
  }
  return drafts;
}

async function restoreEncryptedStoredDrafts() {
  if (typeof window === "undefined") return {};
  const drafts = {};
  for (const key of storageKeys(sessionStorage)) {
    if (!key?.startsWith(`${STORAGE_PREFIX}:`)) continue;
    const value = readSessionJson(key);
    if (!isSealedSessionStorageValue(value)) continue;
    const draft = draftFromStorageValue(await readSealedSessionValue(key));
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

function compactActivityAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((attachment) => ({
    ...attachment,
    base64: undefined,
    content: undefined,
  }));
}

function activityHasRecoverableTurn(activity = {}) {
  return !!(
    activity?.chatKey &&
    activity?.turnId &&
    activity.status === TURN_STATUSES.running &&
    (activity.prompt || activity.displayPrompt || activity.clientTurnId)
  );
}

function runningActivityMetadata({
  prompt = "",
  displayPrompt = null,
  attachments = [],
  fileAccessMode = null,
  nodeContext = null,
  clientTurnId = null,
  acceptedByServer = false,
} = {}) {
  return {
    prompt: String(prompt || ""),
    displayPrompt: displayPrompt || prompt || "",
    attachments: compactActivityAttachments(attachments),
    fileAccessMode: fileAccessMode || null,
    nodeContext: nodeContext || null,
    clientTurnId: clientTurnId || null,
    acceptedByServer: !!acceptedByServer,
  };
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
  const stored = readSessionJson(ACTIVE_RUNNING_STORAGE_KEY, {});
  if (isSealedSessionStorageValue(stored)) {
    return { activeRunningThread: null, threadActivityByKey: {} };
  }
  const restored = normalizeRunningState(stored);
  const threadActivityByKey = {};

  Object.entries(restored.threadActivityByKey || {}).forEach(
    ([chatKey, activity]) => {
      const draft = draftFromStorageValue(
        readSessionJson(
          getStorageKey(activity.workspaceSlug, activity.threadSlug)
        )
      );
      const turn = findAssistantTurn(draft?.items || [], activity.turnId);
      if (
        turn?.status === TURN_STATUSES.running ||
        activityHasRecoverableTurn(activity)
      ) {
        threadActivityByKey[chatKey] = activity;
      }
    }
  );

  const activeRunningThread =
    restored.activeRunningThread &&
    threadActivityByKey[restored.activeRunningThread.chatKey]
      ? restored.activeRunningThread
      : null;

  return { activeRunningThread, threadActivityByKey };
}

async function restoreEncryptedActiveRunningState() {
  if (typeof window === "undefined") {
    return { activeRunningThread: null, threadActivityByKey: {} };
  }
  const stored = readSessionJson(ACTIVE_RUNNING_STORAGE_KEY, {});
  if (!isSealedSessionStorageValue(stored)) return restoreActiveRunningState();
  const restored = normalizeRunningState(
    await readSealedSessionValue(ACTIVE_RUNNING_STORAGE_KEY, {})
  );
  const threadActivityByKey = {};

  for (const [chatKey, activity] of Object.entries(
    restored.threadActivityByKey || {}
  )) {
    const draft = draftFromStorageValue(
      await readSealedSessionValue(
        getStorageKey(activity.workspaceSlug, activity.threadSlug)
      )
    );
    const turn = findAssistantTurn(draft?.items || [], activity.turnId);
    if (
      turn?.status === TURN_STATUSES.running ||
      activityHasRecoverableTurn(activity)
    ) {
      threadActivityByKey[chatKey] = activity;
    }
  }

  const activeRunningThread =
    restored.activeRunningThread &&
    threadActivityByKey[restored.activeRunningThread.chatKey]
      ? restored.activeRunningThread
      : null;

  return { activeRunningThread, threadActivityByKey };
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
    removeSealedSessionValue(ACTIVE_RUNNING_STORAGE_KEY);
    return;
  }
  persistSealedSessionValue(ACTIVE_RUNNING_STORAGE_KEY, normalized, {
    maxLength: MAX_DRAFT_STORAGE_CHARS,
  });
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

function restoreDraftFromRunningActivity(draft = {}, activity = null) {
  if (!activityHasRecoverableTurn(activity)) return draft;
  const items = normalizeTurnItems(draft.items || []);
  const existingTurn = findAssistantTurn(items, activity.turnId);
  const base = {
    ...draft,
    items,
    activeTurnId: activity.turnId,
    isStreaming: !activity.isAgentRunning,
    isAgentRunning: !!activity.isAgentRunning,
    persistError: null,
  };

  if (existingTurn) {
    if (existingTurn.status !== TURN_STATUSES.running) return draft;
    return base;
  }

  const { items: turnItems } = createTurn({
    prompt: activity.displayPrompt || activity.prompt || "",
    attachments: activity.attachments || [],
    chatKey: activity.chatKey,
    turnId: activity.turnId,
    createdAt: activity.startedAt || Date.now(),
  });

  return {
    ...base,
    items: normalizeTurnItems([...items, ...turnItems]),
    tailCleanup: null,
  };
}

function cleanupTransientDraftState(
  draft = {},
  { chatKey = null, reason = "updateDraft" } = {}
) {
  const beforeItems = normalizeTurnItems(draft.items || []);
  const beforeTail = beforeItems[beforeItems.length - 1] || null;
  const { items, removedTurnIds, removedTurns } = cleanupTransientDraftItems(
    beforeItems,
    { now: Date.now(), removeRunning: false }
  );
  if (removedTurnIds.length === 0) return { ...draft, items };

  const removedTurnIdSet = new Set(removedTurnIds);
  const removedItemIds = beforeItems
    .filter((item) => removedTurnIdSet.has(item.turnId))
    .map((item) => item.id)
    .filter(Boolean);
  const activeRemoved =
    draft.activeTurnId && removedTurnIdSet.has(draft.activeTurnId);
  const tailRemoved =
    beforeTail?.turnId && removedTurnIdSet.has(beforeTail.turnId);
  const next = {
    ...draft,
    items,
    activeTurnId: activeRemoved ? null : draft.activeTurnId,
    pendingApproval: activeRemoved ? null : draft.pendingApproval,
    pendingClarification: activeRemoved ? null : draft.pendingClarification,
    activeToolCall: activeRemoved ? null : draft.activeToolCall,
    isStreaming: activeRemoved ? false : draft.isStreaming,
    isAgentRunning: activeRemoved ? false : draft.isAgentRunning,
    persistError: activeRemoved || tailRemoved ? null : draft.persistError,
    tailCleanup: tailRemoved
      ? {
          seq: Number(draft.tailCleanup?.seq || 0) + 1,
          turnIds: removedTurnIds,
          removedItemIds,
          reason,
          updatedAt: Date.now(),
        }
      : draft.tailCleanup || null,
  };

  debugChatTurn("draftTransientCleanup", {
    chatKey:
      chatKey ||
      getChatThreadKey(draft.workspaceSlug, draft.threadSlug) ||
      null,
    reason,
    removedTurnIds,
    removedTurns,
    tailRemoved,
    activeRemoved,
    beforeTailTurnId: beforeTail?.turnId || null,
    afterTailTurnId: items[items.length - 1]?.turnId || null,
  });

  return next;
}

function withoutTransientAgentReconnectEvents(timeline = []) {
  return (timeline || []).filter((event) => {
    if (event?.type !== "thought") return true;
    const content = String(event?.content || "");
    return !content.startsWith("Agent connection interrupted. Reconnecting");
  });
}

function definedPatch(source = {}, fields = []) {
  return fields.reduce((patch, field) => {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      patch[field] = source[field];
    }
    return patch;
  }, {});
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
    publicChatId: patch.publicChatId || turn.publicChatId || null,
    finalContent: nextFinalContent,
    sources: patch.sources || turn.sources || [],
    metrics: patch.metrics || turn.metrics || {},
    timeline: withoutTransientAgentReconnectEvents(turn.timeline || []),
    status: TURN_STATUSES.completed,
    error: null,
    reconnectState: null,
    retryCount: 0,
    maxRetries: MAX_AGENT_RECONNECT_ATTEMPTS,
    websocketUUID: null,
    agentProvider: null,
    agentModel: null,
    agentModelTier: null,
    silenceTimeoutMs: null,
    reconnectAttemptStartedAt: null,
    reconnectDueAt: null,
    lastEventSeq: 0,
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
    pendingClarification: draft?.pendingClarification?.requestId || null,
    status: turn?.status || null,
    finalContentLength: turn?.finalContent?.length || 0,
    timelineEventCount: turn?.timeline?.length || 0,
  };
}

function waitForAgentSessionOpen(agentSession, timeoutMs = 5_000) {
  if (!agentSession) return Promise.resolve(false);
  if (agentSession.isOpen?.()) return Promise.resolve(true);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (agentSession.isOpen?.()) {
        clearInterval(interval);
        resolve(true);
        return;
      }
      const state = agentSession.getState?.().state;
      if (
        [
          AgentSessionState.CLOSED,
          AgentSessionState.FAILED,
          AgentSessionState.FINALIZED,
        ].includes(state) ||
        Date.now() - startedAt >= timeoutMs
      ) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });
}

function findClarificationTurnId(draft = {}, requestId = null) {
  if (!requestId) return null;
  return [...(draft.items || [])]
    .reverse()
    .find(
      (item) =>
        isAssistantTurn(item) &&
        (item.timeline || []).some(
          (event) =>
            event?.type === "clarification_request" &&
            event.requestId === requestId
        )
    )?.turnId;
}

export function ChatThreadDraftProvider({ children }) {
  const [drafts, setDrafts] = useState(() => restoreStoredDrafts());
  const [runningState, setRunningState] = useState(() =>
    restoreActiveRunningState()
  );
  const draftsRef = useRef(drafts);
  const runningStateRef = useRef(runningState);
  const agentSessionRefs = useRef({});
  const agentStartupTimeoutRefs = useRef({});
  const openAgentSocketRef = useRef(null);
  const approvalTimeoutRefs = useRef({});
  const clarificationTimeoutRefs = useRef({});
  const stoppedThreadRefs = useRef({});
  const erroredThreadRefs = useRef({});
  const resumedAgentTurnRefs = useRef(new Set());
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
    let cancelled = false;

    async function restoreEncryptedRuntimeState() {
      const [encryptedDrafts, encryptedRunningState] = await Promise.all([
        restoreEncryptedStoredDrafts(),
        restoreEncryptedActiveRunningState(),
      ]);
      if (cancelled) return;

      const restoredDraftEntries = Object.entries(encryptedDrafts || {});
      if (restoredDraftEntries.length) {
        setDrafts((prev) => {
          const next = { ...prev };
          const changedKeys = [];
          for (const [chatKey, draft] of restoredDraftEntries) {
            const current = next[chatKey];
            if (
              !current ||
              Number(draft.updatedAt || 0) > Number(current.updatedAt || 0)
            ) {
              next[chatKey] = draft;
              changedKeys.push(chatKey);
            }
          }
          if (!changedKeys.length) return prev;
          draftsRef.current = next;
          queueMicrotask(() => {
            changedKeys.forEach((chatKey) =>
              emitListeners(draftListenersRef, chatKey)
            );
          });
          return next;
        });
      }

      if (
        encryptedRunningState?.activeRunningThread ||
        Object.keys(encryptedRunningState?.threadActivityByKey || {}).length
      ) {
        setRunningState((prev) => {
          const next = normalizeRunningState({
            activeRunningThread:
              prev.activeRunningThread ||
              encryptedRunningState.activeRunningThread,
            threadActivityByKey: {
              ...(encryptedRunningState.threadActivityByKey || {}),
              ...(prev.threadActivityByKey || {}),
            },
          });
          runningStateRef.current = next;
          activityVersionRef.current += 1;
          queueMicrotask(() => emitListeners(activityListenersRef, "*"));
          return next;
        });
      }
    }

    restoreEncryptedRuntimeState().catch((error) => {
      debugChatTurn("secureStorage:restoreFailed", {
        error: error?.message || String(error),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [emitListeners]);

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
    (chatKey, updater, options = {}) => {
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
        next = cleanupTransientDraftState(next, {
          chatKey,
          reason: options.cleanupReason || "updateDraft",
        });
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
    (chatKey, turnId, metadata = {}) => {
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
          ...(existing || {}),
          workspaceSlug,
          threadSlug,
          chatKey,
          turnId,
          status: TURN_STATUSES.running,
          startedAt: existing?.turnId === turnId ? existing.startedAt : now,
          updatedAt: now,
          ...(metadata || {}),
          acceptedByServer:
            metadata.acceptedByServer ?? existing?.acceptedByServer ?? false,
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
          snapshotPersisted: activityHasRecoverableTurn(activity),
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
        debugRuntime("runtime-snapshot:clear", {
          chatKey,
          turnId,
          reason: "completed",
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
        debugRuntime("runtime-snapshot:clear", {
          chatKey,
          turnId,
          reason: "failed",
        });
        return next;
      });
      updateDraft(
        chatKey,
        (draft) => {
          const next = {
            ...draft,
            items: failTurnItems(draft.items, turnId, failureReason),
            activeTurnId:
              draft.activeTurnId === turnId ? null : draft.activeTurnId,
            pendingApproval: null,
            pendingClarification: null,
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
        },
        { cleanupReason: "markThreadFailed" }
      );
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
        debugRuntime("runtime-snapshot:clear", {
          chatKey,
          turnId,
          reason: "clear-running",
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
        const clearedTurnId = nextActivity[chatKey]?.turnId || null;
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
        debugRuntime("runtime-snapshot:clear", {
          chatKey,
          turnId: clearedTurnId,
          reason: "clear-activity",
        });
        return next;
      });
    },
    [debugRuntime, updateRunningState]
  );

  const clearConfirmedLocalTurn = useCallback(
    ({ workspaceSlug, threadSlug = null, turnId = null }) => {
      if (!workspaceSlug || !turnId) return false;
      const chatKey = getChatThreadKey(workspaceSlug, threadSlug);
      const cleared = normalizeTurnItems(
        draftsRef.current[chatKey]?.items || []
      ).some((item) => item.turnId === turnId);

      clearThreadRunning(chatKey, turnId);
      updateDraft(
        chatKey,
        (draft) => {
          const items = normalizeTurnItems(draft.items || []);
          const nextItems = items.filter((item) => item.turnId !== turnId);
          const next = {
            ...draft,
            items: nextItems,
            activeTurnId:
              draft.activeTurnId === turnId ? null : draft.activeTurnId,
            pendingApproval:
              draft.activeTurnId === turnId ? null : draft.pendingApproval,
            pendingClarification:
              draft.activeTurnId === turnId ? null : draft.pendingClarification,
            activeToolCall:
              draft.activeTurnId === turnId ? null : draft.activeToolCall,
            isStreaming:
              draft.activeTurnId === turnId ? false : draft.isStreaming,
            isAgentRunning:
              draft.activeTurnId === turnId ? false : draft.isAgentRunning,
            persistError: null,
          };
          debugRuntime("clearConfirmedLocalTurn:after", {
            chatKey,
            turnId,
            cleared,
            draft: next,
          });
          return next;
        },
        { cleanupReason: "clearConfirmedLocalTurn" }
      );

      return cleared;
    },
    [clearThreadRunning, debugRuntime, updateDraft]
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
          pendingClarification: null,
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
        const storedValue = readSessionJson(
          getStorageKey(workspaceSlug, threadSlug)
        );
        const restored = isSealedSessionStorageValue(storedValue)
          ? null
          : draftFromStorageValue(storedValue);
        const existing = prev[chatKey] || restored;
        const runningActivity =
          runningStateRef.current.threadActivityByKey?.[chatKey] || null;
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
        let next = existing
          ? {
              ...existing,
              items:
                seedItems.length > 0
                  ? mergeServerHistoryIntoTurnItems([], seedItems)
                  : existing.items,
              updatedAt: Date.now(),
            }
          : createDraft({ workspaceSlug, threadSlug, items: seedItems });
        const beforeRecoveryTurnId = next.activeTurnId || null;
        next = restoreDraftFromRunningActivity(next, runningActivity);
        if (next.activeTurnId && next.activeTurnId !== beforeRecoveryTurnId) {
          debugRuntime("runtime-snapshot:restore", {
            chatKey,
            turnId: next.activeTurnId,
            reason: "ensureDraft",
            acceptedByServer: !!runningActivity?.acceptedByServer,
          });
        }
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
        publicChatId: null,
        frame: null,
      };
      pending.content += event.content || "";
      pending.sources =
        event.sources?.length > 0 ? event.sources : pending.sources;
      pending.metrics = event.metrics || pending.metrics;
      pending.chatId = event.chatId || pending.chatId;
      pending.publicChatId = event.publicChatId || pending.publicChatId;

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
                publicChatId: nextPending.publicChatId || turn.publicChatId,
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
        if (event.type === "clarification_request")
          next.pendingClarification = event;
        if (event.type === "clarification_result")
          next.pendingClarification = null;
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
      let completedPublicChatId = patch.publicChatId || null;
      settledTurnRefs.current[turnRefKey(chatKey, turnId)] =
        TURN_STATUSES.completed;
      debugChatTurn("assistant_final:before", {
        chatKey,
        turnId,
        eventChatId: patch.chatId || null,
        eventPublicChatId: patch.publicChatId || null,
        ...turnRuntimeSnapshot(draft, turnId),
      });
      updateDraft(chatKey, (current) => {
        const currentTurn =
          findAssistantTurn(current.items || [], turnId) || turn;
        const pendingKey = `${chatKey}:${turnId}`;
        const pendingDelta = deltaFlushRefs.current[pendingKey];
        if (pendingDelta?.frame) cancelAnimationFrame(pendingDelta.frame);
        delete deltaFlushRefs.current[pendingKey];
        const patchHasFinalContent =
          (typeof patch.finalContent === "string" &&
            patch.finalContent.length > 0) ||
          (typeof patch.content === "string" && patch.content.length > 0);
        const finalPatch =
          pendingDelta?.content && !patchHasFinalContent
            ? {
                ...patch,
                finalContent: `${currentTurn.finalContent || ""}${pendingDelta.content}`,
                sources:
                  pendingDelta.sources?.length > 0
                    ? pendingDelta.sources
                    : patch.sources,
                metrics: pendingDelta.metrics || patch.metrics,
                chatId: pendingDelta.chatId || patch.chatId,
                publicChatId: pendingDelta.publicChatId || patch.publicChatId,
              }
            : patch;
        completedChatId = finalPatch.chatId || completedChatId;
        completedPublicChatId =
          finalPatch.publicChatId || completedPublicChatId;
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
          pendingClarification: null,
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
      debugChatTurn("assistant_final:public_id", {
        chatKey,
        turnId,
        chatId: completedChatId || null,
        publicChatId: completedPublicChatId || null,
      });
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

  const mergeLatestPersistedHistory = useCallback(
    async ({
      chatKey,
      turnId = null,
      workspaceSlug,
      threadSlug = null,
      reason = "latest-history-refresh",
      limit = LATEST_HISTORY_REFRESH_LIMIT,
    } = {}) => {
      if (!chatKey || !workspaceSlug) return false;
      debugRuntime("mergeLatestPersistedHistory:before", {
        chatKey,
        turnId,
        workspaceSlug,
        threadSlug,
        reason,
        limit,
      });

      try {
        const result = await requestPriorityQueue.schedule(
          ({ signal }) =>
            threadSlug
              ? Workspace.threads.chatHistoryPage(workspaceSlug, threadSlug, {
                  limit,
                  detail: "full",
                  priorityWindow: limit,
                  signal,
                })
              : Workspace.chatHistoryPage(workspaceSlug, {
                  limit,
                  detail: "full",
                  priorityWindow: limit,
                  signal,
                }),
          {
            priority: "P3",
            label: "chat:stream-refresh-fallback",
            kind: "chat",
            scope: {
              route: "workspace-chat",
              workspaceSlug,
              threadSlug: threadSlug || null,
              turnId,
              reason,
            },
            policy: "prefetch",
            dedupeKey: `chat:stream-refresh:${chatKey}:${reason}`,
          }
        );
        if (!result) return false;
        const history = Array.isArray(result?.history) ? result.history : [];
        if (history.length === 0) {
          debugRuntime("mergeLatestPersistedHistory:empty", {
            chatKey,
            turnId,
            reason,
          });
          return false;
        }

        updateDraft(
          chatKey,
          (current) => {
            const restoredCurrent = restoreDraftFromRunningActivity(
              current,
              runningStateRef.current.threadActivityByKey?.[chatKey] || null
            );
            const items = mergeServerHistoryIntoTurnItems(
              history,
              restoredCurrent.items,
              {
                chatKey,
                preserveTurnIds: [restoredCurrent.activeTurnId, turnId].filter(
                  Boolean
                ),
              }
            );
            const patchedTurn = turnId
              ? findAssistantTurn(items, turnId)
              : null;
            const next = {
              ...restoredCurrent,
              items,
              persistError: null,
              tailHydration: {
                seq: Number(restoredCurrent.tailHydration?.seq || 0) + 1,
                chatId: patchedTurn?.chatId || null,
                publicChatId: patchedTurn?.publicChatId || null,
                turnId,
                reason,
                updatedAt: Date.now(),
              },
            };
            debugRuntime("mergeLatestPersistedHistory:after", {
              chatKey,
              turnId,
              reason,
              historyLength: history.length,
              patchedChatId: patchedTurn?.chatId || null,
              patchedPublicChatId: patchedTurn?.publicChatId || null,
              beforeItemCount: current.items?.length || 0,
              restoredItemCount: restoredCurrent.items?.length || 0,
              afterItemCount: items.length,
            });
            return next;
          },
          { cleanupReason: reason }
        );
        return true;
      } catch (error) {
        debugRuntime("mergeLatestPersistedHistory:error", {
          chatKey,
          turnId,
          reason,
          error: error.message,
        });
        return false;
      }
    },
    [debugRuntime, updateDraft]
  );

  const applyTurnEvent = useCallback(
    (chatKey, turnId, event) => {
      if (!event || !turnId) return;
      debugRuntime("applyTurnEvent:entry", {
        chatKey,
        turnId,
        eventType: event.type,
        timelineType: event.event?.type || null,
        requestId: event.event?.requestId || null,
        eventChatId: event.chatId || event.patch?.chatId || null,
        eventPublicChatId:
          event.publicChatId || event.patch?.publicChatId || null,
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
        if (event.event?.type === "thought" && event.event?.animate) {
          debugRuntime("stream:status-response-visible", {
            chatKey,
            turnId,
            contentLength: String(event.event.content || "").length,
          });
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
          const hasPatchSources =
            Array.isArray(patch.sources) && patch.sources.length > 0;
          const hasPatchMetrics =
            patch.metrics &&
            typeof patch.metrics === "object" &&
            Object.keys(patch.metrics).length > 0;
          return {
            ...draft,
            items: updateAssistantTurnInItems(draft.items, turnId, {
              ...patch,
              sources: event.appendSources
                ? [...(turn.sources || []), ...(patch.sources || [])]
                : hasPatchSources
                  ? patch.sources
                  : turn.sources || [],
              metrics: hasPatchMetrics ? patch.metrics : turn.metrics || {},
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
          eventPublicChatId: event.publicChatId || null,
          eventContentLength: event.content?.length || 0,
          ...turnRuntimeSnapshot(draft, turnId),
        });
        const completionPatch = {
          chatId: event.chatId || turn?.chatId,
          publicChatId: event.publicChatId || turn?.publicChatId,
          sources:
            event.sources?.length > 0 ? event.sources : turn?.sources || [],
          metrics: event.metrics || turn?.metrics || {},
        };
        if (event.content && event.content.length > 0) {
          completionPatch.finalContent = event.content;
        }
        completeAssistantTurn(chatKey, turnId, completionPatch);
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
      if (!draft || !turnId) return false;
      const turn = findAssistantTurn(draft.items, turnId);
      const chatId = expectedChatId || turn?.chatId;
      if (!chatId) return false;
      debugRuntime("confirmPersisted:before", {
        chatKey,
        turnId,
        expectedChatId,
        chatId,
        attempt,
      });

      try {
        const hydration = await fetchPersistedChatHydration({
          workspaceModel: Workspace,
          workspaceSlug: draft.workspaceSlug,
          threadSlug: draft.threadSlug,
          chatId,
        });
        const history = persistedHydratedChatHistory(hydration, chatId);
        if (history.length > 0) {
          debugRuntime("confirmPersisted:found", {
            chatKey,
            turnId,
            chatId,
            attempt,
            historyLength: history.length,
            hydratedChatIds: hydration?.hydratedChatIds || [],
          });
          updateDraft(
            chatKey,
            (current) => {
              const items = mergeServerHistoryIntoTurnItems(
                history,
                current.items,
                { chatKey, preserveTurnIds: [turnId].filter(Boolean) }
              );
              const shouldKeepDraft = hasUnfinishedDraft({ ...current, items });
              if (!shouldKeepDraft) {
                removeStoredDraft(current.workspaceSlug, current.threadSlug);
              }
              return {
                ...current,
                items,
                persistError: null,
                tailHydration: {
                  seq: Number(current.tailHydration?.seq || 0) + 1,
                  chatId,
                  turnId,
                  updatedAt: Date.now(),
                },
              };
            },
            { cleanupReason: "confirmPersisted" }
          );
          debugRuntime("confirmPersisted:hydrate-first-applied", {
            chatKey,
            turnId,
            chatId,
            attempt,
            historyLength: history.length,
            hydratedChatIds: hydration?.hydratedChatIds || [],
          });
          return true;
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
          return null;
        }

        debugRuntime("confirmPersisted:missing", {
          chatKey,
          turnId,
          chatId,
          attempt,
        });
        const recovered = await mergeLatestPersistedHistory({
          chatKey,
          turnId,
          workspaceSlug: draft.workspaceSlug,
          threadSlug: draft.threadSlug,
          reason: "confirmPersisted-missing",
        });
        if (recovered) return true;
        updateDraft(chatKey, (current) => ({
          ...current,
          persistError:
            "Message completed locally, but server history has not returned the final assistant message yet.",
        }));
        return false;
      } catch (error) {
        debugRuntime("confirmPersisted:error", {
          chatKey,
          turnId,
          chatId,
          attempt,
          error: error.message,
        });
        const recovered = await mergeLatestPersistedHistory({
          chatKey,
          turnId,
          workspaceSlug: draft.workspaceSlug,
          threadSlug: draft.threadSlug,
          reason: "confirmPersisted-error",
        });
        if (recovered) return true;
        updateDraft(chatKey, (current) => ({
          ...current,
          persistError: error.message,
        }));
        return false;
      }
    },
    [debugRuntime, mergeLatestPersistedHistory, updateDraft]
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

  const scheduleClarificationTimeout = useCallback(
    (chatKey, turnId, clarification) => {
      if (!clarification?.requestId || !clarification.timeoutMs) return;
      const timeoutKey = `${chatKey}:${turnId}:${clarification.requestId}`;
      clearTimeout(clarificationTimeoutRefs.current[timeoutKey]);
      const elapsed =
        Date.now() -
        (clarification.requestedAt || clarification.createdAt || Date.now());
      const remaining = Math.max(0, clarification.timeoutMs - elapsed);
      clarificationTimeoutRefs.current[timeoutKey] = setTimeout(() => {
        const draft = draftsRef.current[chatKey];
        if (
          draft?.pendingClarification?.requestId !== clarification.requestId ||
          draft?.activeTurnId !== turnId
        ) {
          return;
        }
        appendTimelineEvent(chatKey, turnId, {
          type: "clarification_result",
          requestId: clarification.requestId,
          skipped: false,
          timedOut: true,
          reason: "timeout",
        });
      }, remaining);
    },
    [appendTimelineEvent]
  );

  useEffect(() => {
    Object.entries(drafts).forEach(([chatKey, draft]) => {
      if (draft.pendingClarification && draft.activeTurnId) {
        scheduleClarificationTimeout(
          chatKey,
          draft.activeTurnId,
          draft.pendingClarification
        );
      }
    });
  }, [drafts, scheduleClarificationTimeout]);

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

      const agentSession = agentSessionRefs.current[chatKey];
      const sendResult = await agentSession?.respondToApproval?.(
        requestId,
        !!approved
      );
      if (sendResult?.ok) {
        return;
      }

      const result = await respondToChatToolApproval({
        workspaceSlug: draft.workspaceSlug,
        requestId,
        approved: !!approved,
      });
      if (!result?.success) {
        appendTimelineEvent(chatKey, turnId, {
          type: "tool_result",
          uuid: `approval-response:${requestId}`,
          toolName: approval.skillName,
          result: { success: false, error: result?.error || "not_found" },
          content: "工具确认响应失败，请重试。",
        });
      }
    },
    [appendTimelineEvent]
  );

  const respondToClarification = useCallback(
    async (chatKey, requestId, payload = {}) => {
      const draft = draftsRef.current[chatKey];
      const clarification = draft?.pendingClarification;
      const turnId =
        draft?.activeTurnId || findClarificationTurnId(draft, requestId);
      if (!clarification || clarification.requestId !== requestId || !turnId) {
        if (import.meta.env.DEV) {
          const debugPayload = {
            chatKey,
            requestId,
            reason: "clarification_not_pending",
            hasClarification: !!clarification,
            pendingRequestId: clarification?.requestId || null,
            activeTurnId: turnId || null,
          };
          console.warn(
            `[clarification] response skipped ${JSON.stringify(debugPayload)}`
          );
          window.__lastClarificationSendFailure = debugPayload;
        }
        return { ok: false, reason: "clarification_not_pending" };
      }

      let sendResult = { ok: true, transport: "local" };
      let websocketResult = null;
      let websocketFallbackAttempted = false;

      if (!payload.timedOut) {
        const turn = findAssistantTurn(draft.items || [], turnId);
        const userMessage = draft.items?.find(
          (item) => item.id === turn?.userMessageId
        );
        let agentSession = agentSessionRefs.current[chatKey];
        if (
          !canReuseAgentSessionForInvocation(agentSession, turn?.websocketUUID)
        ) {
          agentSession = null;
        }
        if (
          !agentSession &&
          turn?.websocketUUID &&
          openAgentSocketRef.current
        ) {
          agentSession = openAgentSocketRef.current(
            chatKey,
            turnId,
            turn.websocketUUID,
            {
              workspaceSlug: draft.workspaceSlug,
              threadSlug: draft.threadSlug,
              prompt: userMessage?.content || "",
              displayPrompt: userMessage?.content || "",
              attachments: userMessage?.attachments || [],
              forceReconnect: true,
              agentProvider: turn.agentProvider || null,
              agentModel: turn.agentModel || null,
              agentModelTier: turn.agentModelTier || null,
              silenceTimeoutMs:
                turn.silenceTimeoutMs || DEFAULT_AGENT_SILENCE_TIMEOUT_MS,
              reconnectAttemptStartedAt: turn.reconnectAttemptStartedAt || null,
              reconnectDueAt: turn.reconnectDueAt || null,
              lastEventSeq: turn.lastEventSeq || 0,
              retryCount: turn.retryCount || 0,
            }
          );
          await waitForAgentSessionOpen(agentSession);
        }

        sendResult = await respondToClarificationViaHttp(
          turn?.websocketUUID,
          requestId,
          payload
        );

        if (sendResult?.ok) {
          agentSession?.markClientInputSent?.("clarification_http_sent");
        } else {
          websocketFallbackAttempted = true;
          if (typeof agentSession?.respondToClarification !== "function") {
            websocketResult = {
              ok: false,
              reason: "agent_session_missing",
              transport: "websocket",
            };
          } else if (!agentSession.isOpen?.()) {
            await waitForAgentSessionOpen(agentSession);
          }

          if (!websocketResult) {
            websocketResult = await agentSession.respondToClarification(
              requestId,
              payload
            );
            if (
              !websocketResult?.ok &&
              ["not_open", "sign_or_send_failed"].includes(
                websocketResult?.reason
              )
            ) {
              const reopened = await waitForAgentSessionOpen(
                agentSession,
                8_000
              );
              if (reopened) {
                websocketResult = await agentSession.respondToClarification(
                  requestId,
                  payload
                );
              }
            }
          }

          sendResult = websocketResult?.ok
            ? {
                ...websocketResult,
                transport: "websocket",
                httpReason: sendResult?.reason || null,
              }
            : {
                ...sendResult,
                websocketReason: websocketResult?.reason || null,
              };
          if (websocketResult?.ok) {
            agentSession?.markClientInputSent?.("clarification_ws_sent");
          }
        }

        if (!sendResult?.ok) {
          if (import.meta.env.DEV) {
            const debugPayload = {
              chatKey,
              requestId,
              reason: sendResult?.reason || "clarification_send_failed",
              websocketReason: websocketResult?.reason || null,
              websocketFallbackAttempted,
              error: sendResult?.error?.message || null,
              state: agentSession?.getState?.() || null,
            };
            console.warn(
              `[clarification] response send failed ${JSON.stringify(debugPayload)}`
            );
            window.__lastClarificationSendFailure = debugPayload;
          }
          return {
            ok: false,
            reason: sendResult?.reason || "clarification_send_failed",
            websocketReason: websocketResult?.reason || null,
            fallbackAttempted: websocketFallbackAttempted,
            error: sendResult?.error,
          };
        }
      }

      appendTimelineEvent(chatKey, turnId, {
        type: "clarification_result",
        requestId,
        skipped: !!payload.skipped,
        timedOut: !!payload.timedOut,
      });

      return {
        ok: true,
        transport: sendResult?.transport || "http_fallback",
        fallbackAttempted: websocketFallbackAttempted,
        websocketReason: websocketResult?.reason || null,
      };
    },
    [appendTimelineEvent]
  );

  const updateAgentReconnectTurn = useCallback(
    (chatKey, turnId, patch = {}) => {
      const turnPatch = {
        ...definedPatch(patch, [
          "reconnectState",
          "retryCount",
          ...AGENT_RECONNECT_TURN_FIELDS,
        ]),
        maxRetries: MAX_AGENT_RECONNECT_ATTEMPTS,
        updatedAt: Date.now(),
      };
      updateDraft(chatKey, (draft) => ({
        ...draft,
        items: updateAssistantTurnInItems(draft.items, turnId, turnPatch),
      }));
    },
    [updateDraft]
  );

  const reconnectStateFromAgentState = useCallback((stateSnapshot = {}) => {
    const retryCount = Number(stateSnapshot.retryCount || 0);
    if (stateSnapshot.state === AgentSessionState.FAILED) return "failed";
    if (stateSnapshot.state === AgentSessionState.RECONNECTING)
      return "retrying";
    if (stateSnapshot.state === AgentSessionState.CONNECTING && retryCount > 0)
      return "retrying";
    if (
      [
        AgentSessionState.FINALIZED,
        AgentSessionState.CLOSED,
        AgentSessionState.STOPPING,
      ].includes(stateSnapshot.state)
    ) {
      return null;
    }
    return "idle";
  }, []);

  const agentTurnPatchFromState = useCallback(
    (stateSnapshot = {}, extra = {}) => {
      const reconnectState = reconnectStateFromAgentState(stateSnapshot);
      return {
        ...(reconnectState ? { reconnectState } : {}),
        retryCount: stateSnapshot.retryCount || 0,
        websocketUUID: stateSnapshot.websocketUUID || null,
        agentProvider: stateSnapshot.agentProvider || null,
        agentModel: stateSnapshot.agentModel || null,
        agentModelTier: stateSnapshot.agentModelTier || null,
        silenceTimeoutMs:
          stateSnapshot.silenceTimeoutMs || DEFAULT_AGENT_SILENCE_TIMEOUT_MS,
        reconnectAttemptStartedAt:
          stateSnapshot.reconnectAttemptStartedAt || null,
        reconnectDueAt: stateSnapshot.reconnectDueAt || null,
        lastEventSeq: stateSnapshot.lastEventSeq || 0,
        ...extra,
      };
    },
    [reconnectStateFromAgentState]
  );

  const buildInterruptedAgentContext = useCallback(
    (chatKey, turnId, reason, stateSnapshot = {}) => {
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

      return {
        reason,
        originalPrompt:
          stateSnapshot.originalPrompt || userMessage?.content || "",
        displayPrompt:
          stateSnapshot.displayPrompt || userMessage?.content || "",
        partialAnswer: turn?.finalContent || "",
        toolEvents,
        attachments: stateSnapshot.attachments || [],
        fileAccessMode: stateSnapshot.fileAccessMode || null,
        nodeContext: stateSnapshot.nodeContext || null,
        lastEventSeq: stateSnapshot.lastEventSeq || 0,
        retryCount: stateSnapshot.retryCount || 0,
        websocketUUID: stateSnapshot.websocketUUID || null,
      };
    },
    []
  );

  const offerAgentReconnect = useCallback(
    (chatKey, turnId, reason, interruptedContext, stateSnapshot = {}) => {
      updateDraft(
        chatKey,
        (current) => ({
          ...current,
          items: updateAssistantTurnInItems(current.items, turnId, {
            status: TURN_STATUSES.interrupted,
            reconnectState: "offer",
            ...agentTurnPatchFromState(stateSnapshot, {
              interruptedContext,
              reconnectAttemptStartedAt: null,
              reconnectDueAt: null,
            }),
            error: null,
            updatedAt: Date.now(),
          }),
          activeTurnId:
            current.activeTurnId === turnId ? null : current.activeTurnId,
          pendingApproval: null,
          pendingClarification: null,
          activeToolCall: null,
          isStreaming: false,
          isAgentRunning: false,
          persistError: null,
        }),
        { cleanupReason: "offerReconnect" }
      );
      clearThreadRunning(chatKey, turnId);
      debugRuntime("websocket:reconnect-offer", {
        chatKey,
        turnId,
        reason,
        retryCount: stateSnapshot.retryCount || 0,
        lastEventSeq: stateSnapshot.lastEventSeq || 0,
      });
    },
    [agentTurnPatchFromState, clearThreadRunning, debugRuntime, updateDraft]
  );

  const handleAgentSessionState = useCallback(
    (chatKey, turnId, stateSnapshot = {}) => {
      const terminal = [
        AgentSessionState.FINALIZED,
        AgentSessionState.CLOSED,
        AgentSessionState.FAILED,
        AgentSessionState.STOPPING,
      ].includes(stateSnapshot.state);

      updateDraft(chatKey, (draft) => ({
        ...draft,
        activeTurnId: terminal
          ? draft.activeTurnId === turnId
            ? null
            : draft.activeTurnId
          : turnId,
        isAgentRunning: !terminal,
        isStreaming: false,
        persistError: null,
      }));

      updateAgentReconnectTurn(
        chatKey,
        turnId,
        agentTurnPatchFromState(stateSnapshot)
      );
      debugChatTurn("websocket:state", {
        chatKey,
        turnId,
        state: stateSnapshot.state,
        previousState: stateSnapshot.previousState,
        reason: stateSnapshot.reason,
        retryCount: stateSnapshot.retryCount || 0,
        lastEventSeq: stateSnapshot.lastEventSeq || 0,
      });
    },
    [agentTurnPatchFromState, updateAgentReconnectTurn, updateDraft]
  );

  const handleAgentSessionEvent = useCallback(
    (chatKey, turnId, event) => {
      debugChatTurn("websocket:event", {
        chatKey,
        turnId,
        eventType: event?.type || null,
        timelineType: event?.event?.type || null,
        requestId: event?.event?.requestId || null,
        protocolType: event?.protocolEvent?.type || null,
      });
      const applied = applyTurnEvent(chatKey, turnId, event);
      if (applied?.type === "timeline_event") {
        const timelineEvent = normalizeTimelineEvent(applied.event || {});
        if (timelineEvent.type === "approval_request") {
          scheduleApprovalTimeout(chatKey, turnId, timelineEvent);
        }
        if (timelineEvent.type === "clarification_request") {
          scheduleClarificationTimeout(chatKey, turnId, timelineEvent);
        }
      }
      return applied;
    },
    [applyTurnEvent, scheduleApprovalTimeout, scheduleClarificationTimeout]
  );

  const clearAgentStartupTimeout = useCallback((chatKey, turnId) => {
    if (!chatKey || !turnId) return;
    const key = turnRefKey(chatKey, turnId);
    const timeout = agentStartupTimeoutRefs.current[key];
    if (timeout) clearTimeout(timeout);
    delete agentStartupTimeoutRefs.current[key];
  }, []);

  const openAgentSocket = useCallback(
    (chatKey, turnId, websocketUUID, options = {}) => {
      if (!websocketUUID) return null;
      const existingSession = agentSessionRefs.current[chatKey];
      if (
        existingSession &&
        !options.forceReconnect &&
        canReuseAgentSessionForInvocation(existingSession, websocketUUID)
      ) {
        return existingSession;
      }

      if (existingSession) {
        const existingState = existingSession.getState?.() || {};
        debugRuntime("websocket:discard-session", {
          chatKey,
          turnId,
          websocketUUID,
          existingWebsocketUUID: existingState.websocketUUID || null,
          existingTurnId: existingState.turnId || null,
          existingState: existingState.state || null,
          forceReconnect: !!options.forceReconnect,
        });
        if (existingState.turnId) {
          clearAgentStartupTimeout(chatKey, existingState.turnId);
        }
        existingSession.close?.(
          existingState.websocketUUID === websocketUUID
            ? "force_reconnect"
            : "superseded"
        );
        if (agentSessionRefs.current[chatKey] === existingSession) {
          delete agentSessionRefs.current[chatKey];
        }
      }

      clearAgentStartupTimeout(chatKey, turnId);
      const startupTimeoutKey = turnRefKey(chatKey, turnId);
      const controller = createAgentWebSocketSession({
        websocketUUID,
        chatKey,
        turnId,
        initialLastEventSeq:
          options.lastEventSeq || options.initialLastEventSeq || 0,
        initialRetryCount: options.retryCount || 0,
        workspaceSlug: options.workspaceSlug,
        threadSlug: options.threadSlug,
        prompt: options.prompt,
        displayPrompt: options.displayPrompt,
        attachments: options.attachments || [],
        fileAccessMode: options.fileAccessMode,
        nodeContext: options.nodeContext,
        agentProvider: options.agentProvider,
        agentModel: options.agentModel,
        agentModelTier: options.agentModelTier,
        silenceTimeoutMs:
          options.silenceTimeoutMs || DEFAULT_AGENT_SILENCE_TIMEOUT_MS,
        reconnectAttemptStartedAt: options.reconnectAttemptStartedAt || null,
        reconnectDueAt: options.reconnectDueAt || null,
        getInterruptedContext: (reason, stateSnapshot) =>
          buildInterruptedAgentContext(chatKey, turnId, reason, stateSnapshot),
        onState: (stateSnapshot) => {
          if (
            [
              AgentSessionState.OPEN,
              AgentSessionState.WAITING_ON_INPUT,
              AgentSessionState.FINALIZED,
              AgentSessionState.CLOSED,
              AgentSessionState.FAILED,
              AgentSessionState.STOPPING,
            ].includes(stateSnapshot?.state)
          ) {
            clearAgentStartupTimeout(chatKey, turnId);
          }
          handleAgentSessionState(chatKey, turnId, stateSnapshot);
        },
        onReconnectOffer: (reason, interruptedContext, stateSnapshot) =>
          offerAgentReconnect(
            chatKey,
            turnId,
            reason,
            interruptedContext,
            stateSnapshot
          ),
        onEvent: (event) => handleAgentSessionEvent(chatKey, turnId, event),
        onProtocolEvent: (protocolEvent) => {
          debugChatTurn("websocket:protocol", {
            chatKey,
            turnId,
            protocolType: protocolEvent?.type || null,
            rawType: protocolEvent?.rawType || null,
            seq: protocolEvent?.seq || null,
          });
        },
        onFinal: (chatId) => {
          clearAgentStartupTimeout(chatKey, turnId);
          markThreadCompleted(chatKey, turnId);
          setTimeout(() => {
            if (chatId) confirmPersisted(chatKey, turnId, chatId);
            const parsedChatKey = parseChatKey(chatKey);
            mergeLatestPersistedHistory({
              chatKey,
              turnId,
              workspaceSlug:
                options.workspaceSlug || parsedChatKey.workspaceSlug,
              threadSlug: options.threadSlug ?? parsedChatKey.threadSlug,
              reason: chatId
                ? "agent-final-refresh"
                : "agent-final-missing-chat-id",
            });
          }, 500);
        },
        onError: (error, stateSnapshot) => {
          debugRuntime("websocket:error", {
            chatKey,
            turnId,
            error: error?.message || String(error || "unknown"),
            state: stateSnapshot?.state || null,
          });
        },
        onClose: (stateSnapshot) => {
          clearAgentStartupTimeout(chatKey, turnId);
          debugChatTurn("websocket:close", {
            chatKey,
            turnId,
            state: stateSnapshot?.state || null,
            reason: stateSnapshot?.reason || null,
            stopped: !!stoppedThreadRefs.current[chatKey],
            ...turnRuntimeSnapshot(draftsRef.current[chatKey], turnId),
          });
          if (agentSessionRefs.current[chatKey] === controller) {
            delete agentSessionRefs.current[chatKey];
          }
          if (stoppedThreadRefs.current[chatKey]) {
            clearThreadRunning(chatKey, turnId);
          }
          stoppedThreadRefs.current[chatKey] = false;
          erroredThreadRefs.current[chatKey] = false;
        },
      });

      agentSessionRefs.current[chatKey] = controller;
      agentStartupTimeoutRefs.current[startupTimeoutKey] = setTimeout(() => {
        if (agentSessionRefs.current[chatKey] !== controller) return;
        const state = controller.getState?.() || {};
        if (
          [
            AgentSessionState.OPEN,
            AgentSessionState.WAITING_ON_INPUT,
            AgentSessionState.FINALIZED,
            AgentSessionState.CLOSED,
            AgentSessionState.FAILED,
          ].includes(state.state)
        ) {
          clearAgentStartupTimeout(chatKey, turnId);
          return;
        }

        const reason =
          "Agent websocket did not connect for this request. Please retry.";
        debugRuntime("websocket:startup-timeout", {
          chatKey,
          turnId,
          websocketUUID,
          state: state.state || null,
          retryCount: state.retryCount || 0,
        });
        applyTurnEvent(chatKey, turnId, {
          type: "assistant_error",
          content: reason,
          error: reason,
        });
        controller.close?.("startup_timeout");
        if (agentSessionRefs.current[chatKey] === controller) {
          delete agentSessionRefs.current[chatKey];
        }
        clearAgentStartupTimeout(chatKey, turnId);
      }, options.startupTimeoutMs || AGENT_SOCKET_STARTUP_TIMEOUT_MS);
      markThreadRunning(chatKey, turnId);
      return controller;
    },
    [
      applyTurnEvent,
      buildInterruptedAgentContext,
      clearAgentStartupTimeout,
      clearThreadRunning,
      confirmPersisted,
      debugRuntime,
      handleAgentSessionEvent,
      handleAgentSessionState,
      markThreadCompleted,
      markThreadRunning,
      mergeLatestPersistedHistory,
      offerAgentReconnect,
    ]
  );
  openAgentSocketRef.current = openAgentSocket;

  useEffect(() => {
    Object.entries(draftsRef.current || {}).forEach(([chatKey, draft]) => {
      const turn = (draft.items || []).find(
        (item) =>
          isAssistantTurn(item) &&
          item.status === TURN_STATUSES.running &&
          item.reconnectState === "retrying" &&
          item.websocketUUID
      );
      if (!turn) return;

      const resumeKey = agentReconnectKey(chatKey, turn.turnId);
      if (resumedAgentTurnRefs.current.has(resumeKey)) return;
      if (
        canReuseAgentSessionForInvocation(
          agentSessionRefs.current[chatKey],
          turn.websocketUUID
        )
      ) {
        return;
      }

      const userMessage = draft.items?.find(
        (item) => item.id === turn.userMessageId
      );
      resumedAgentTurnRefs.current.add(resumeKey);
      openAgentSocket(chatKey, turn.turnId, turn.websocketUUID, {
        workspaceSlug: draft.workspaceSlug,
        threadSlug: draft.threadSlug,
        prompt: userMessage?.content || "",
        displayPrompt: userMessage?.content || "",
        attachments: userMessage?.attachments || [],
        forceReconnect: true,
        agentProvider: turn.agentProvider || null,
        agentModel: turn.agentModel || null,
        agentModelTier: turn.agentModelTier || null,
        silenceTimeoutMs:
          turn.silenceTimeoutMs || DEFAULT_AGENT_SILENCE_TIMEOUT_MS,
        reconnectAttemptStartedAt: turn.reconnectAttemptStartedAt || null,
        reconnectDueAt: turn.reconnectDueAt || null,
        lastEventSeq: turn.lastEventSeq || 0,
        retryCount: turn.retryCount || 0,
      });
    });
  }, [openAgentSocket]);

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
      const agentSession = agentSessionRefs.current[chatKey];
      const preparedAttachments = attachments || parseAttachments();
      const activeDraft = draftsRef.current[chatKey];
      if (sendToExistingAgent && activeDraft?.pendingClarification) {
        const answer = String(displayPrompt || prompt || "").trim();
        if (!answer) {
          return { ok: false, reason: "pending_clarification_requires_answer" };
        }
        return respondToClarification(
          chatKey,
          activeDraft.pendingClarification.requestId,
          clarificationPayloadFromText(activeDraft.pendingClarification, answer)
        );
      }

      const activeTurn = activeDraft?.activeTurnId
        ? findAssistantTurn(activeDraft.items || [], activeDraft.activeTurnId)
        : null;
      const activeAgentSession = canReuseAgentSessionForInvocation(
        agentSession,
        activeTurn?.websocketUUID
      )
        ? agentSession
        : null;
      let routeToExistingAgent = false;
      if (sendToExistingAgent && activeAgentSession) {
        if (!activeAgentSession.isOpen?.()) {
          await waitForAgentSessionOpen(activeAgentSession, 8_000);
        }
        routeToExistingAgent = !!activeAgentSession.isOpen?.();
      }
      if (sendToExistingAgent && !routeToExistingAgent) {
        debugRuntime("startStream:existingAgentUnavailable", {
          chatKey,
          activeTurnId: activeTurn?.turnId || null,
          activeWebsocketUUID: activeTurn?.websocketUUID || null,
          sessionWebsocketUUID:
            agentSession?.getState?.()?.websocketUUID || null,
          sessionState: agentSession?.getState?.()?.state || null,
        });
      }

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
        pendingClarification: null,
        activeToolCall: null,
        isStreaming: !routeToExistingAgent,
        isAgentRunning: routeToExistingAgent,
        persistError: null,
      }));
      debugRuntime("startStream:turnScheduled", {
        chatKey,
        turnId,
        sendToExistingAgent: routeToExistingAgent,
      });
      const runningSnapshot = runningActivityMetadata({
        prompt,
        displayPrompt: displayPrompt || prompt,
        attachments: preparedAttachments,
        fileAccessMode,
        nodeContext,
        clientTurnId: turnId,
      });
      markThreadRunning(chatKey, turnId, runningSnapshot);
      debugRuntime("runtime-snapshot:persist", {
        chatKey,
        turnId,
        source: "startStream",
        acceptedByServer: false,
      });
      window.dispatchEvent(
        new CustomEvent("anythingllm-document-reader-associate-selection", {
          detail: { chatKey, clientGeneratedTurnId: turnId, turnId },
        })
      );

      if (routeToExistingAgent && activeAgentSession?.isOpen?.()) {
        debugRuntime("startStream:sendToExistingAgent", {
          chatKey,
          turnId,
        });
        const sendResult = await activeAgentSession.sendFeedback({
          feedback: prompt,
          attachments: preparedAttachments,
          fileAccessMode,
          nodeContext,
        });
        if (!sendResult?.ok) {
          debugRuntime("startStream:sendToExistingAgentFailed", {
            chatKey,
            turnId,
            reason: sendResult?.reason || "unknown",
          });
          applyTurnEvent(chatKey, turnId, {
            type: "assistant_error",
            content: "Agent session is no longer accepting input.",
            error: "Agent session is no longer accepting input.",
          });
          return {
            ok: false,
            chatKey,
            turnId,
            turnScheduled: true,
            routedToExistingAgent: true,
            reason: sendResult?.reason || "existing_agent_feedback_failed",
          };
        }
        appendTimelineEvent(chatKey, turnId, {
          type: "thought",
          content: "Sent follow-up input to the active agent session.",
        });
        return {
          ok: true,
          chatKey,
          turnId,
          turnScheduled: true,
          routedToExistingAgent: true,
        };
      }

      try {
        let completedChatId = null;
        const streamChat = threadSlug
          ? streamWorkspaceThreadChat
          : streamWorkspaceChat;
        let streamTask = null;
        streamTask = requestPriorityQueue.handle(
          () =>
            streamChat({
              workspaceSlug,
              threadSlug,
              body: buildChatStreamBody({
                message: prompt,
                displayPrompt: displayPrompt || prompt,
                attachments: preparedAttachments,
                fileAccessMode,
                nodeContext,
                clientTurnId: turnId,
              }),
              onOpen: () => {
                streamTask?.completeExclusive?.("chat-stream-open");
                markThreadRunning(chatKey, turnId, {
                  ...runningSnapshot,
                  acceptedByServer: true,
                });
                debugRuntime("pending:server-accepted", {
                  chatKey,
                  turnId,
                });
              },
              onEvent: (event, protocolEvent, rawEvent) => {
                debugChatTurn("sse:event", {
                  chatKey,
                  turnId,
                  rawType: protocolEvent?.rawType || rawEvent?.type || null,
                  protocolType: protocolEvent?.type || null,
                  eventType: event?.type || null,
                  close: !!rawEvent?.close,
                });
                const applied = applyTurnEvent(chatKey, turnId, event);
                if (applied?.type === "timeline_event") {
                  const timelineEvent = normalizeTimelineEvent(
                    applied.event || {}
                  );
                  if (timelineEvent.type === "approval_request") {
                    scheduleApprovalTimeout(chatKey, turnId, timelineEvent);
                  }
                  if (timelineEvent.type === "clarification_request") {
                    scheduleClarificationTimeout(
                      chatKey,
                      turnId,
                      timelineEvent
                    );
                  }
                }
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
            }),
          {
            priority: "P0",
            label: "chat:stream",
            kind: "chat",
            scope: {
              route: "workspace-chat",
              workspaceSlug,
              threadSlug: threadSlug || null,
              turnId,
            },
            policy: "foreground",
            emergency: true,
            protected: true,
            dedupeKey: `chat:stream:${chatKey}:${turnId}`,
          }
        );
        await streamTask.promise;
        setTimeout(() => {
          void (async () => {
            if (completedChatId) {
              const hydrated = await confirmPersisted(
                chatKey,
                turnId,
                completedChatId
              );
              if (hydrated !== false) return;
            }
            mergeLatestPersistedHistory({
              chatKey,
              turnId,
              workspaceSlug,
              threadSlug,
              reason: completedChatId
                ? "stream-complete-refresh-fallback"
                : "stream-missing-chat-id",
            });
          })();
        }, 500);
        if (threadSlug) {
          [1_000, 3_000, 7_000, 15_000].forEach((delay) => {
            setTimeout(() => {
              workspaceNavigationCache.markThreadsStale(
                workspaceSlug,
                "chat-stream-complete-soft-stale"
              );
            }, delay);
          });
        }
        debugRuntime("startStream:streamResolved", {
          chatKey,
          turnId,
          completedChatId,
        });
        return {
          ok: true,
          chatKey,
          turnId,
          turnScheduled: true,
          routedToExistingAgent: false,
          completedChatId,
        };
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
        return {
          ok: false,
          chatKey,
          turnId,
          turnScheduled: true,
          routedToExistingAgent: false,
          reason: "stream_error",
          error,
        };
      }
    },
    [
      appendTimelineEvent,
      applyTurnEvent,
      confirmPersisted,
      debugRuntime,
      ensureDraft,
      markThreadRunning,
      mergeLatestPersistedHistory,
      openAgentSocket,
      respondToClarification,
      scheduleApprovalTimeout,
      scheduleClarificationTimeout,
      updateDraft,
    ]
  );

  const startLocalTurn = useCallback(
    ({
      workspaceSlug,
      threadSlug = null,
      prompt,
      history = [],
      turnId: clientGeneratedTurnId = null,
    }) => {
      const chatKey = ensureDraft({
        workspaceSlug,
        threadSlug,
        history,
      });
      const { turnId, items: turnItems } = createTurn({
        prompt,
        chatKey,
        turnId: clientGeneratedTurnId || undefined,
      });
      delete settledTurnRefs.current[turnRefKey(chatKey, turnId)];
      updateDraft(chatKey, (draft) => ({
        ...draft,
        items: [...(draft.items || []), ...turnItems],
        activeTurnId: turnId,
        pendingApproval: null,
        pendingClarification: null,
        activeToolCall: null,
        isStreaming: true,
        isAgentRunning: false,
        persistError: null,
      }));
      markThreadRunning(
        chatKey,
        turnId,
        runningActivityMetadata({
          prompt,
          displayPrompt: prompt,
          clientTurnId: turnId,
          acceptedByServer: true,
        })
      );
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
        updateDraft(
          chatKey,
          (current) => ({
            ...current,
            items: updateAssistantTurnInItems(current.items, turnId, {
              reconnectState: "failed",
              updatedAt: Date.now(),
            }),
          }),
          { cleanupReason: "declineInterruptedReconnect" }
        );
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
        const agentSession = agentSessionRefs.current[key];
        Promise.resolve(agentSession?.stop?.("user_stop"))
          .then((stopResult) => {
            if (!stopResult?.ok) {
              applyTurnEvent(key, turnId, {
                type: "stop_generation",
                content: "Generation stopped by user.",
              });
            }
          })
          .catch(() => {
            applyTurnEvent(key, turnId, {
              type: "stop_generation",
              content: "Generation stopped by user.",
            });
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
      Object.values(agentSessionRefs.current).forEach((session) =>
        session?.close?.("provider_unmount")
      );
      Object.values(agentStartupTimeoutRefs.current).forEach((timeout) =>
        clearTimeout(timeout)
      );
      Object.values(approvalTimeoutRefs.current).forEach((timeout) =>
        clearTimeout(timeout)
      );
      Object.values(clarificationTimeoutRefs.current).forEach((timeout) =>
        clearTimeout(timeout)
      );
    };
  }, []);

  const mergeServerHistory = useCallback(
    ({
      workspaceSlug,
      threadSlug = null,
      history = [],
      pruneServerBackedItemsOutsideHistory = false,
      preserveTurnIds = [],
    }) => {
      const chatKey = ensureDraft({ workspaceSlug, threadSlug });
      debugRuntime("mergeServerHistory:before", {
        chatKey,
        historyLength: history.length,
        pruneServerBackedItemsOutsideHistory,
        preserveTurnIds,
        ...draftHistoryIntegrity(draftsRef.current[chatKey]),
      });
      updateDraft(
        chatKey,
        (draft) => {
          const restoredDraft = restoreDraftFromRunningActivity(
            draft,
            runningStateRef.current.threadActivityByKey?.[chatKey] || null
          );
          const beforeIntegrity = draftHistoryIntegrity(restoredDraft);
          const items = mergeServerHistoryIntoTurnItems(
            history,
            restoredDraft.items,
            {
              chatKey,
              pruneServerBackedItemsOutsideHistory,
              preserveTurnIds: [
                restoredDraft.activeTurnId,
                ...preserveTurnIds,
              ].filter(Boolean),
            }
          );
          const next = {
            ...restoredDraft,
            items,
          };
          const afterIntegrity = draftHistoryIntegrity(next);
          debugRuntime("mergeServerHistory:after", {
            chatKey,
            turnId: next.activeTurnId || null,
            draft: next,
            historyLength: history.length,
            pruneServerBackedItemsOutsideHistory,
            preserveTurnIds,
            beforeBlankServerBackedUserItemCount:
              beforeIntegrity.blankServerBackedUserItemCount,
            beforeUserItemCount: beforeIntegrity.userItemCount,
            ...afterIntegrity,
          });
          return next;
        },
        { cleanupReason: "mergeServerHistory" }
      );
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

  const restoreRunningTurnSnapshot = useCallback(
    ({ workspaceSlug, threadSlug = null, turnId = null } = {}) => {
      const chatKey = getChatThreadKey(workspaceSlug, threadSlug);
      const activity = runningStateRef.current.threadActivityByKey?.[chatKey];
      if (!activityHasRecoverableTurn(activity)) return false;
      if (turnId && activity.turnId !== turnId) return false;

      updateDraft(
        chatKey,
        (draft) => {
          const next = restoreDraftFromRunningActivity(draft, activity);
          debugRuntime("runtime-snapshot:restore", {
            chatKey,
            turnId: activity.turnId,
            reason: "explicit-restore",
            acceptedByServer: !!activity.acceptedByServer,
          });
          return next;
        },
        { cleanupReason: "runtime-snapshot-restore" }
      );
      return true;
    },
    [debugRuntime, updateDraft]
  );

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
      refreshLatestHistory: mergeLatestPersistedHistory,
      createTurn,
      appendTimelineEvent,
      updateAssistantTurn,
      completeAssistantTurn,
      failAssistantTurn,
      startStream,
      startLocalTurn,
      continueInterruptedAgentTurn,
      respondToApproval,
      respondToClarification,
      stopStream,
      hasWorkspaceActivity,
      hasThreadActivity,
      getThreadActivity,
      getThreadActivityByKey,
      getActivityVersion,
      subscribeThreadActivity,
      getRunningThreads,
      getRunningThread,
      restoreRunningTurnSnapshot,
      getAssistantTurnByChatId,
      updateUserItem,
      clearThreadActivity,
      clearConfirmedLocalTurn,
      getThreadPath,
      getChatKey: getChatThreadKey,
    }),
    [
      appendTimelineEvent,
      clearConfirmedLocalTurn,
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
      restoreRunningTurnSnapshot,
      getThreadActivity,
      getThreadActivityByKey,
      getActivityVersion,
      hasThreadActivity,
      hasWorkspaceActivity,
      mergeServerHistory,
      mergeLatestPersistedHistory,
      respondToApproval,
      respondToClarification,
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

export function ChatThreadDraftProviderBoundary({ children }) {
  const context = useContext(ChatThreadDraftContext);
  if (context) return children;
  return <ChatThreadDraftProvider>{children}</ChatThreadDraftProvider>;
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
