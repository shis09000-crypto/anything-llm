import { createContext } from "react";
import { AgentSessionState } from "@/lib/communication/agentWebSocketClient";
import { debugChatTurn } from "@/utils/chat/debug";
import { safeJsonParse } from "@/utils/request";
import {
  TURN_STATUSES,
  appendTimelineEventToItems,
  cleanupTransientDraftItems,
  createTurn,
  findAssistantTurn,
  isAssistantTurn,
  isUserItem,
  normalizeTurnItems,
  updateAssistantTurnInItems,
  withoutTransientAgentReconnectEvents,
} from "@/utils/chat/turns";
import { storageKeys } from "@/utils/appEnvironment";
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

function emitListeners(listenersRef, key) {
  const listeners = listenersRef.current.get(key);
  if (listeners) listeners.forEach((listener) => listener());
  const wildcard = listenersRef.current.get("*");
  if (wildcard) wildcard.forEach((listener) => listener());
}

function subscribeListener(listenersRef, key, listener) {
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
}

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

function compactAgentProgressDetails(details = {}) {
  if (!details || typeof details !== "object") return {};
  return [
    "toolCategory",
    "toolName",
    "evidenceCount",
    "selectedToolCount",
    "approvalRequired",
    "reconnectAttempt",
    "errorCode",
    "routeKind",
  ].reduce((safe, key) => {
    if (details[key] === undefined || details[key] === null) return safe;
    safe[key] =
      typeof details[key] === "string"
        ? truncateText(details[key], 96)
        : details[key];
    return safe;
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

  if (event.type === "agent_progress") {
    return {
      ...base,
      phase: event.phase,
      sequence: event.sequence,
      details: compactAgentProgressDetails(event.details),
    };
  }

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
      persistenceStatus: item.persistenceStatus || null,
      persistenceErrorCode: item.persistenceErrorCode || null,
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
        !item.chatId &&
        !item.persistenceStatus
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

export {
  ChatThreadDraftContext,
  MAX_TOOL_OUTPUT_PREVIEW_CHARS,
  MAX_AGENT_RECONNECT_ATTEMPTS,
  DEFAULT_AGENT_SILENCE_TIMEOUT_MS,
  AGENT_SOCKET_STARTUP_TIMEOUT_MS,
  LATEST_HISTORY_REFRESH_LIMIT,
  AGENT_RECONNECT_TURN_FIELDS,
  agentReconnectKey,
  clarificationPayloadFromText,
  getStorageKey,
  isSealedSessionStorageValue,
  readSessionJson,
  parseChatKey,
  getThreadPath,
  createDraft,
  draftFromStorageValue,
  truncateText,
  hasUnfinishedDraft,
  clearSettledRuntimeState,
  pruneDraftCollection,
  persistDraft,
  removeStoredDraft,
  restoreStoredDrafts,
  restoreEncryptedStoredDrafts,
  activityHasRecoverableTurn,
  runningActivityMetadata,
  normalizeRunningState,
  restoreActiveRunningState,
  restoreEncryptedActiveRunningState,
  persistActiveRunningState,
  failTurnItems,
  restoreDraftFromRunningActivity,
  cleanupTransientDraftState,
  definedPatch,
  completeTurnPatch,
  assistantTurnByChatId,
  canApplyTurnEvent,
  turnRefKey,
  turnRuntimeSnapshot,
  waitForAgentSessionOpen,
  findClarificationTurnId,
  emitListeners,
  subscribeListener,
};
