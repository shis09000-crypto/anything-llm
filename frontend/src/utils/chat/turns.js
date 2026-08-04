import { v4 } from "uuid";
import { normalizeTurnItemsOrder } from "./historyOrder.js";
import { dedupeReaderTextSources } from "./readerTextSources.js";
import { displayPrompt } from "./displayPrompt.js";

export const TURN_STATUSES = {
  running: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
};

export const AGENT_RECONNECT_TIER_TIMEOUT_MS = {
  rough: 50_000,
  refined: 90_000,
  ultra: 120_000,
};

const DEFAULT_AGENT_RECONNECT_TIER = "refined";
const LOCAL_SERVER_TURN_MATCH_EARLY_TOLERANCE_MS = 5_000;
const LOCAL_SERVER_TURN_MATCH_LATE_TOLERANCE_MS = 2 * 60 * 1000;

const TIMELINE_TYPES = new Set([
  "thought",
  "tool_call",
  "tool_result",
  "approval_request",
  "approval_result",
  "clarification_request",
  "clarification_result",
  "markdown_delta",
  "error",
]);

function nowMs() {
  return Date.now();
}

function stableJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

export function createTurnId() {
  return `turn:${v4()}`;
}

export function userItemId(turnId) {
  return `${turnId}:user`;
}

export function assistantItemId(turnId) {
  return `${turnId}:assistant`;
}

export function createTurn({
  prompt,
  attachments = [],
  readerTextSources = [],
  chatKey = null,
  chatId = null,
  publicChatId = null,
  turnId = createTurnId(),
  createdAt = nowMs(),
} = {}) {
  const normalizedReaderTextSources =
    dedupeReaderTextSources(readerTextSources);
  const userMessage = {
    id: userItemId(turnId),
    type: "user",
    role: "user",
    turnId,
    content: prompt,
    attachments,
    readerTextSources: normalizedReaderTextSources,
    chatId,
    publicChatId,
    clientTurnId: turnId,
    createdAt,
  };
  const assistantTurn = {
    id: assistantItemId(turnId),
    type: "assistant_turn",
    role: "assistant",
    turnId,
    userMessageId: userMessage.id,
    status: TURN_STATUSES.running,
    finalContent: "",
    sources: [],
    metrics: {},
    chatId,
    publicChatId,
    clientTurnId: turnId,
    chatKey,
    error: null,
    createdAt: createdAt + 1,
    updatedAt: createdAt + 1,
    timeline: [],
  };

  return {
    turnId,
    items: [userMessage, assistantTurn],
    userMessage,
    assistantTurn,
  };
}

export function isUserItem(item = {}) {
  return item?.type === "user" && item?.role === "user";
}

export function isAssistantTurn(item = {}) {
  return item?.type === "assistant_turn" && item?.role === "assistant";
}

export function normalizeTimelineType(type) {
  if (TIMELINE_TYPES.has(type)) return type;
  if (type === "agent_thought" || type === "statusResponse") return "thought";
  if (type === "final_message" || type === "assistant_delta")
    return "markdown_delta";
  if (type === "toolCallInvocation") return "tool_call";
  if (type === "toolCallResult") return "tool_result";
  if (type === "toolApprovalRequest") return "approval_request";
  return type || "thought";
}

export function timelineEventStableId(event = {}) {
  const type = normalizeTimelineType(event.type);
  if (type === "approval_request") {
    return event.requestId ? `approval:${event.requestId}` : event.id;
  }
  if (type === "approval_result") {
    return event.requestId ? `approval-result:${event.requestId}` : event.id;
  }
  if (type === "clarification_request") {
    return event.requestId ? `clarification:${event.requestId}` : event.id;
  }
  if (type === "clarification_result") {
    return event.requestId
      ? `clarification-result:${event.requestId}`
      : event.id;
  }
  if (type === "tool_call") {
    const id = event.toolCallId || event.uuid || event.id;
    if (id) return `tool-call:${id}`;
    return `tool-call:${event.toolName || "unknown"}:${stableJson(event.args || event.arguments)}`;
  }
  if (type === "tool_result") {
    const id = event.toolCallId || event.uuid || event.id;
    if (id) return `tool-result:${id}`;
    return `tool-result:${event.toolName || "unknown"}:${stableJson(event.result || event.content)}`;
  }
  if (event.uuid) return `${type}:${event.uuid}`;
  if (event.id) return String(event.id);
  if (event.requestId) return `${type}:${event.requestId}`;
  if (event.content) return `${type}:${event.content}`;
  return null;
}

export function normalizeTimelineEvent(
  event = {},
  fallbackCreatedAt = nowMs()
) {
  const type = normalizeTimelineType(event.type);
  const createdAt = event.createdAt || event.timestamp || fallbackCreatedAt;
  const normalized = {
    ...event,
    type,
    args: event.args ?? event.arguments,
    createdAt,
    updatedAt: event.updatedAt || createdAt,
  };
  delete normalized.arguments;

  const stableId = timelineEventStableId(normalized);
  return {
    ...normalized,
    id: stableId || `${type}:${createdAt}:${v4()}`,
  };
}

export function mergeTimelineEvent(timeline = [], rawEvent = {}) {
  if (!rawEvent) return timeline;
  const event = normalizeTimelineEvent(rawEvent);
  const idx = timeline.findIndex((item) => item.id === event.id);
  if (idx === -1) return [...timeline, event];

  return timeline.map((item, index) =>
    index === idx
      ? {
          ...item,
          ...event,
          createdAt: item.createdAt || event.createdAt,
          updatedAt: event.updatedAt || nowMs(),
        }
      : item
  );
}

export function removeTimelineEvent(timeline = [], rawEvent = {}) {
  const targetId =
    rawEvent.targetId || rawEvent.targetUuid || rawEvent.uuid || rawEvent.id;
  if (!targetId) return timeline;
  return timeline.filter(
    (event) =>
      event.id !== targetId &&
      event.uuid !== targetId &&
      !event.id?.endsWith?.(`:${targetId}`)
  );
}

function normalizeStoredTimeline(timeline = []) {
  return Array.isArray(timeline)
    ? timeline.filter(Boolean).reduce(mergeTimelineEvent, [])
    : [];
}

export function isTransientAgentReconnectEvent(event = {}) {
  if (event?.type !== "thought") return false;
  return String(event?.content || "").startsWith(
    "Agent connection interrupted. Reconnecting"
  );
}

export function withoutTransientAgentReconnectEvents(timeline = []) {
  return normalizeStoredTimeline(timeline).filter(
    (event) => !isTransientAgentReconnectEvent(event)
  );
}

export function normalizeTurnItem(item = {}) {
  const createdAt = item.createdAt || item.sentAt || nowMs();
  if (isUserItem(item)) {
    const turnId = item.turnId || createTurnId();
    return {
      ...item,
      id: item.id || userItemId(turnId),
      type: "user",
      role: "user",
      turnId,
      attachments: Array.isArray(item.attachments) ? item.attachments : [],
      readerTextSources: dedupeReaderTextSources(item.readerTextSources),
      createdAt,
      hydrationStatus: item.hydrationStatus || null,
      publicChatId: item.publicChatId || null,
    };
  }

  if (isAssistantTurn(item)) {
    const turnId = item.turnId || createTurnId();
    const timeline = normalizeStoredTimeline(item.timeline);
    return {
      ...item,
      id: item.id || assistantItemId(turnId),
      type: "assistant_turn",
      role: "assistant",
      turnId,
      userMessageId: item.userMessageId || userItemId(turnId),
      status: item.status || TURN_STATUSES.completed,
      finalContent: item.finalContent ?? item.content ?? "",
      sources: Array.isArray(item.sources) ? item.sources : [],
      metrics: item.metrics || {},
      error: item.error || null,
      createdAt,
      updatedAt: item.updatedAt || createdAt,
      timeline,
      hydrationStatus: item.hydrationStatus || null,
      publicChatId: item.publicChatId || null,
    };
  }

  return null;
}

export function normalizeTurnItems(items = []) {
  const normalized = [];
  const positions = new Map();

  for (const item of items) {
    const next = normalizeTurnItem(item);
    if (!next?.id) continue;

    const idx = positions.get(next.id);
    if (idx === undefined) {
      positions.set(next.id, normalized.length);
      normalized.push(next);
      continue;
    }

    const existing = normalized[idx];
    normalized[idx] = isAssistantTurn(existing)
      ? {
          ...existing,
          ...next,
          timeline: normalizeStoredTimeline([
            ...(existing.timeline || []),
            ...(next.timeline || []),
          ]),
        }
      : { ...existing, ...next };
  }

  return normalizeTurnItemsOrder(normalized);
}

function normalizeOldAgentEvent(event = {}) {
  const type = normalizeTimelineType(event.type);
  if (type === "markdown_delta") return null;
  return normalizeTimelineEvent({ ...event, type });
}

function serverTurnId(chatId) {
  return `server:${chatId}`;
}

function agentTierFromModel(model = "") {
  const normalized = String(model || "").toLowerCase();
  if (normalized.includes("flash") || normalized.includes("rough"))
    return "rough";
  if (normalized.includes("ultra") || normalized.includes("max"))
    return "ultra";
  return DEFAULT_AGENT_RECONNECT_TIER;
}

export function agentReconnectTimeoutMs(turn = {}) {
  const explicitTimeout = Number(turn.silenceTimeoutMs);
  if (Number.isFinite(explicitTimeout) && explicitTimeout > 0) {
    return explicitTimeout;
  }

  const tier = AGENT_RECONNECT_TIER_TIMEOUT_MS[turn.agentModelTier]
    ? turn.agentModelTier
    : agentTierFromModel(turn.agentModel);
  return AGENT_RECONNECT_TIER_TIMEOUT_MS[tier];
}

export function isAgentReconnectAttemptStale(turn = {}, now = nowMs()) {
  if (
    turn.status !== TURN_STATUSES.running ||
    turn.reconnectState !== "retrying" ||
    !turn.websocketUUID
  ) {
    return false;
  }

  const startedAt =
    Number(turn.reconnectAttemptStartedAt) ||
    Number(turn.updatedAt) ||
    Number(turn.createdAt) ||
    now;
  const timeoutMs = agentReconnectTimeoutMs(turn);
  return now - startedAt > timeoutMs * 2;
}

export function hasMeaningfulTransientAssistantOutput(turn = {}) {
  if (!isAssistantTurn(turn)) return false;
  if (String(turn.finalContent || "").trim().length > 0) return true;
  if (Array.isArray(turn.outputs) && turn.outputs.length > 0) return true;

  const timeline = Array.isArray(turn.timeline) ? turn.timeline : [];
  if (
    timeline.some((event) => {
      const type = normalizeTimelineType(event?.type);
      if (type === "markdown_delta") {
        return String(event?.content || event?.text || "").trim().length > 0;
      }
      if (type === "clarification_request") return true;
      if (type !== "tool_result") return false;
      return (
        String(
          event?.summary ||
            event?.content ||
            event?.outputPreview ||
            event?.result ||
            ""
        ).trim().length > 0
      );
    })
  ) {
    return true;
  }

  const interruptedContext = turn.interruptedContext || {};
  if (String(interruptedContext.partialAnswer || "").trim().length > 0) {
    return true;
  }
  if (
    Array.isArray(interruptedContext.toolEvents) &&
    interruptedContext.toolEvents.some(
      (event) =>
        event?.type === "tool_result" &&
        String(event?.content || "").trim().length > 0
    )
  ) {
    return true;
  }

  return false;
}

function shouldRemoveTransientAssistantTurn(
  turn = {},
  now = nowMs(),
  options = {}
) {
  if (!isAssistantTurn(turn) || turn.chatId) return false;
  const hasMeaningfulOutput = hasMeaningfulTransientAssistantOutput(turn);
  if (turn.status === TURN_STATUSES.failed) {
    return options.removeFailed === true && !hasMeaningfulOutput;
  }
  if (turn.reconnectState === "failed") {
    return options.removeFailed === true && !hasMeaningfulOutput;
  }
  if (
    turn.status === TURN_STATUSES.interrupted ||
    turn.reconnectState === "offer"
  ) {
    return options.removeInterrupted === true && !hasMeaningfulOutput;
  }
  if (turn.status !== TURN_STATUSES.running) return false;
  if (options.removeRunning === false) return false;

  // A restored running turn has no live transport attached yet. Once it is
  // older than the storage grace window it is an orphan even when a partial
  // answer was rendered. Checking meaningful output before age used to exempt
  // these turns forever, leaving the composer and Agent timeline stuck after
  // reloads.
  if (Number.isFinite(Number(options.runningMaxAgeMs))) {
    const timestamp = Number(turn.updatedAt || turn.createdAt || 0);
    const ageMs = timestamp > 0 ? now - timestamp : Infinity;
    if (ageMs > Number(options.runningMaxAgeMs)) return true;
  }

  if (hasMeaningfulOutput) return false;

  if (turn.reconnectState === "retrying") {
    if (!turn.websocketUUID) return true;
    return isAgentReconnectAttemptStale(turn, now);
  }

  return true;
}

export function cleanupTransientDraftItems(items = [], options = {}) {
  const now = options.now || nowMs();
  const normalized = normalizeTurnItems(items);
  const removedTurnIds = new Set();
  const removedTurns = [];

  for (const item of normalized) {
    if (shouldRemoveTransientAssistantTurn(item, now, options)) {
      removedTurnIds.add(item.turnId);
      removedTurns.push({
        turnId: item.turnId,
        status: item.status || null,
        reconnectState: item.reconnectState || null,
        hasChatId: Boolean(item.chatId),
        hasMeaningfulOutput: hasMeaningfulTransientAssistantOutput(item),
      });
    }
  }

  if (removedTurnIds.size === 0) {
    return { items: normalized, removedTurnIds: [], removedTurns: [] };
  }

  return {
    items: normalized.filter((item) => {
      if (!removedTurnIds.has(item.turnId)) return true;
      if (isAssistantTurn(item)) return false;
      if (isUserItem(item) && !item.chatId) return false;
      return true;
    }),
    removedTurnIds: Array.from(removedTurnIds),
    removedTurns,
  };
}

function groupedServerHistory(history = []) {
  const groups = [];
  const byChatId = new Map();

  for (const message of history.filter(Boolean)) {
    const chatId = message.chatId;
    if (!chatId) continue;
    if (!byChatId.has(chatId)) {
      byChatId.set(chatId, {
        chatId,
        publicChatId: message.publicChatId || null,
        clientTurnId: message.clientTurnId || null,
        user: null,
        assistant: null,
      });
      groups.push(byChatId.get(chatId));
    }

    const group = byChatId.get(chatId);
    group.publicChatId = group.publicChatId || message.publicChatId || null;
    group.clientTurnId = group.clientTurnId || message.clientTurnId || null;
    if (message.role === "user" && !group.user) group.user = message;
    if (message.role === "assistant") group.assistant = message;
  }

  return groups.filter((group) => group.user || group.assistant);
}

function serverGroupToItems(group, chatKey = null) {
  const turnId = serverTurnId(group.chatId);
  const serverSentAt = group.user?.sentAt || group.assistant?.sentAt || null;
  const createdAt = serverSentAt ? serverSentAt * 1000 : nowMs();
  const userMessage = {
    id: userItemId(turnId),
    type: "user",
    role: "user",
    turnId,
    content: displayPrompt(group.user?.content || ""),
    attachments: group.user?.attachments || [],
    readerTextSources: dedupeReaderTextSources(group.user?.readerTextSources),
    chatId: group.chatId,
    createdAt,
    sentAt: serverSentAt,
    hydrationStatus: group.user?.hydrationStatus || null,
    publicChatId: group.publicChatId,
    clientTurnId: group.clientTurnId || group.user?.clientTurnId || null,
  };

  const assistant = group.assistant || {};
  const timeline = (assistant.agentEvents || [])
    .map(normalizeOldAgentEvent)
    .filter(Boolean)
    .reduce(mergeTimelineEvent, []);

  const assistantTurn = {
    id: assistantItemId(turnId),
    type: "assistant_turn",
    role: "assistant",
    turnId,
    userMessageId: userMessage.id,
    status: isAgentHandoffPlaceholder(assistant)
      ? TURN_STATUSES.running
      : TURN_STATUSES.completed,
    finalContent: assistant.content || "",
    truncated: Boolean(assistant.truncated),
    textRef: assistant.textRef || null,
    sources: assistant.sources || [],
    metrics: assistant.metrics || {},
    chatId: group.chatId,
    publicChatId: group.publicChatId,
    clientTurnId:
      group.clientTurnId ||
      group.assistant?.clientTurnId ||
      group.user?.clientTurnId ||
      null,
    chatKey,
    error: assistant.error || null,
    createdAt: createdAt + 1,
    updatedAt: createdAt + 1,
    sentAt: serverSentAt,
    timeline,
    feedbackScore: assistant.feedbackScore,
    outputs: assistant.outputs || [],
    clarifyingQuestions: assistant.clarifyingQuestions || [],
    responseType: assistant.type,
    hydrationStatus:
      group.user?.hydrationStatus || assistant.hydrationStatus || null,
  };

  return [userMessage, assistantTurn];
}

function historyWindowSnapshot(history = []) {
  return history.reduce(
    (snapshot, message) => {
      if (!message) return snapshot;
      const chatId = Number(message.chatId);
      if (Number.isFinite(chatId) && chatId > 0) {
        snapshot.chatIds.add(String(chatId));
        snapshot.maxChatId =
          snapshot.maxChatId === null
            ? chatId
            : Math.max(snapshot.maxChatId, chatId);
      }
      if (message.publicChatId) {
        snapshot.publicChatIds.add(String(message.publicChatId));
      }
      const sentAt = Number(message.sentAt);
      if (Number.isFinite(sentAt) && sentAt > 0) {
        snapshot.maxSentAt =
          snapshot.maxSentAt === null
            ? sentAt
            : Math.max(snapshot.maxSentAt, sentAt);
      }
      return snapshot;
    },
    {
      chatIds: new Set(),
      publicChatIds: new Set(),
      maxChatId: null,
      maxSentAt: null,
    }
  );
}

function itemHasServerIdentity(item = {}) {
  return !!(item.chatId || item.publicChatId);
}

function itemInHistoryWindow(item = {}, snapshot = {}) {
  if (item.chatId && snapshot.chatIds?.has(String(item.chatId))) return true;
  if (
    item.publicChatId &&
    snapshot.publicChatIds?.has(String(item.publicChatId))
  ) {
    return true;
  }
  return false;
}

function groupTurnItems(items = []) {
  const groups = new Map();
  for (const item of items) {
    const turnId = item.turnId || item.id;
    if (!turnId) continue;
    if (!groups.has(turnId)) groups.set(turnId, []);
    groups.get(turnId).push(item);
  }
  return groups;
}

function shouldPruneServerBackedTurn(items = [], snapshot = {}, options = {}) {
  if (!items.length) return false;
  const preserveTurnIds = options.preserveTurnIds || new Set();
  const turnId = items[0]?.turnId || null;
  if (turnId && preserveTurnIds.has(turnId)) return false;
  if (!items.some(itemHasServerIdentity)) return false;
  if (items.some((item) => itemInHistoryWindow(item, snapshot))) return false;
  if (
    items.some(
      (item) => isAssistantTurn(item) && item.status !== TURN_STATUSES.completed
    )
  ) {
    return false;
  }
  return true;
}

export function pruneServerBackedTurnsOutsideHistory(
  items = [],
  history = [],
  options = {}
) {
  if (!history.length) return normalizeTurnItems(items);
  const normalized = normalizeTurnItems(items);
  const snapshot = historyWindowSnapshot(history);
  const preserveTurnIds = new Set(options.preserveTurnIds || []);
  const removedTurnIds = new Set();

  for (const [turnId, turnItems] of groupTurnItems(normalized)) {
    if (
      shouldPruneServerBackedTurn(turnItems, snapshot, {
        ...options,
        preserveTurnIds,
      })
    ) {
      removedTurnIds.add(turnId);
    }
  }

  if (!removedTurnIds.size) return normalized;
  return normalizeTurnItems(
    normalized.filter((item) => !removedTurnIds.has(item.turnId))
  );
}

const SUPERSEDED_UNPERSISTED_TURN_GRACE_MS = 60_000;

export function pruneSupersededUnpersistedTurns(
  items = [],
  history = [],
  options = {}
) {
  if (!history.length) return normalizeTurnItems(items);
  const normalized = normalizeTurnItems(items);
  const newestServerAtMs = history.reduce((latest, message) => {
    const sentAt = Number(message?.sentAt || 0);
    return Number.isFinite(sentAt) && sentAt > 0
      ? Math.max(latest, sentAt * 1000)
      : latest;
  }, 0);
  if (!newestServerAtMs) return normalized;

  const graceMs = Math.max(
    0,
    Number(options.supersededUnpersistedTurnGraceMs) ||
      SUPERSEDED_UNPERSISTED_TURN_GRACE_MS
  );
  const preserveTurnIds = new Set([
    ...(options.preserveTurnIds || []),
    ...(options.preserveRunningTurnIds || []),
  ]);
  const removedTurnIds = new Set();

  for (const [turnId, turnItems] of groupTurnItems(normalized)) {
    if (!turnId || preserveTurnIds.has(turnId)) continue;
    if (turnItems.some(itemHasServerIdentity)) continue;
    if (!turnItems.some(isAssistantTurn)) continue;

    const latestLocalAt = turnItems.reduce((latest, item) => {
      const timestamp = Number(item?.updatedAt || item?.createdAt || 0);
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
    }, 0);
    if (!latestLocalAt) continue;
    if (latestLocalAt + graceMs < newestServerAtMs) {
      removedTurnIds.add(turnId);
    }
  }

  if (!removedTurnIds.size) return normalized;
  return normalizeTurnItems(
    normalized.filter((item) => !removedTurnIds.has(item.turnId))
  );
}

function userFingerprint(item = {}) {
  if (!isUserItem(item)) return null;
  return `${String(item.content || "").trim()}:${stableJson(item.attachments || [])}`;
}

function clientTurnIdOf(item = {}) {
  return item.clientTurnId || item.turnId || null;
}

function clientTurnIdsMatch(localAssistant = {}, serverAssistant = {}) {
  const localClientTurnId = clientTurnIdOf(localAssistant);
  const serverClientTurnId = serverAssistant.clientTurnId || null;
  return !!(
    localClientTurnId &&
    serverClientTurnId &&
    localClientTurnId === serverClientTurnId
  );
}

function isAgentHandoffPlaceholder(assistant = {}) {
  return String(assistant.finalContent || assistant.content || "").includes(
    "@agent: Swapping over to agent chat"
  );
}

function localTurnTimeDistance(
  localItems = [],
  assistant = {},
  serverUser = {}
) {
  const localUser = localItems.find(
    (candidate) => candidate.id === assistant.userMessageId
  );
  const localTime = Number(localUser?.createdAt || assistant.createdAt || 0);
  const serverTime = Number(serverUser?.createdAt || 0);
  if (!localTime || !serverTime) return Number.MAX_SAFE_INTEGER;
  return Math.abs(localTime - serverTime);
}

function localTurnTimeMatchesServer(
  localItems = [],
  assistant = {},
  serverUser = {}
) {
  const localUser = localItems.find(
    (candidate) => candidate.id === assistant.userMessageId
  );
  const localTime = Number(localUser?.createdAt || assistant.createdAt || 0);
  const serverTime = Number(serverUser?.sentAt ? serverUser.sentAt * 1000 : 0);
  if (!localTime || !serverTime) return false;
  return (
    serverTime >= localTime - LOCAL_SERVER_TURN_MATCH_EARLY_TOLERANCE_MS &&
    serverTime <= localTime + LOCAL_SERVER_TURN_MATCH_LATE_TOLERANCE_MS
  );
}

function turnHasAttachments(localItems = [], assistant = {}) {
  const localUser = localItems.find(
    (candidate) => candidate.id === assistant.userMessageId
  );
  return (
    Array.isArray(localUser?.attachments) && localUser.attachments.length > 0
  );
}

function patchLocalTurnWithServer(
  localItems,
  serverUser,
  serverAssistant,
  options = {}
) {
  let localAssistantIdx = localItems.findIndex(
    (item) => isAssistantTurn(item) && clientTurnIdsMatch(item, serverAssistant)
  );

  if (localAssistantIdx === -1) {
    localAssistantIdx = localItems.findIndex(
      (item) =>
        isAssistantTurn(item) &&
        serverAssistant.chatId &&
        item.chatId === serverAssistant.chatId &&
        localTurnTimeMatchesServer(localItems, item, serverUser)
    );
  }

  if (localAssistantIdx === -1) {
    const candidates = localItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        if (!isAssistantTurn(item)) return false;
        if (
          ![
            TURN_STATUSES.completed,
            TURN_STATUSES.failed,
            TURN_STATUSES.interrupted,
            TURN_STATUSES.running,
          ].includes(item.status)
        ) {
          return false;
        }
        const localUser = localItems.find(
          (candidate) => candidate.id === item.userMessageId
        );
        return (
          userFingerprint(localUser) === userFingerprint(serverUser) &&
          localTurnTimeMatchesServer(localItems, item, serverUser)
        );
      })
      .sort((a, b) => {
        const distance =
          localTurnTimeDistance(localItems, a.item, serverUser) -
          localTurnTimeDistance(localItems, b.item, serverUser);
        if (distance !== 0) return distance;
        return Number(a.item.createdAt || 0) - Number(b.item.createdAt || 0);
      });

    localAssistantIdx = candidates[0]?.index ?? -1;
  }

  if (localAssistantIdx === -1) {
    const candidates = localItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        if (!isAssistantTurn(item)) return false;
        if (!turnHasAttachments(localItems, item)) return false;
        return localTurnTimeMatchesServer(localItems, item, serverUser);
      })
      .sort((a, b) => {
        const distance =
          localTurnTimeDistance(localItems, a.item, serverUser) -
          localTurnTimeDistance(localItems, b.item, serverUser);
        if (distance !== 0) return distance;
        return Number(a.item.createdAt || 0) - Number(b.item.createdAt || 0);
      });

    localAssistantIdx = candidates[0]?.index ?? -1;
  }

  if (localAssistantIdx === -1) return null;

  const localAssistant = localItems[localAssistantIdx];
  const preserveRunningTurnIds = new Set(options.preserveRunningTurnIds || []);
  const preserveRunningTurn =
    isAgentHandoffPlaceholder(serverAssistant) &&
    (localAssistant.status === TURN_STATUSES.running ||
      preserveRunningTurnIds.has(localAssistant.turnId));
  const localUserIdx = localItems.findIndex(
    (item) => item.id === localAssistant.userMessageId
  );
  const nextItems = [...localItems];

  if (localUserIdx >= 0) {
    nextItems[localUserIdx] = {
      ...nextItems[localUserIdx],
      chatId: serverUser.chatId || nextItems[localUserIdx].chatId,
      publicChatId:
        serverUser.publicChatId || nextItems[localUserIdx].publicChatId || null,
      clientTurnId:
        serverUser.clientTurnId || nextItems[localUserIdx].clientTurnId || null,
      content:
        nextItems[localUserIdx].content || displayPrompt(serverUser.content),
      attachments:
        nextItems[localUserIdx].attachments?.length > 0
          ? nextItems[localUserIdx].attachments
          : serverUser.attachments || [],
      hydrationStatus: serverUser.hydrationStatus || null,
    };
  }

  nextItems[localAssistantIdx] = {
    ...localAssistant,
    chatId: serverAssistant.chatId || localAssistant.chatId,
    publicChatId:
      serverAssistant.publicChatId || localAssistant.publicChatId || null,
    clientTurnId:
      serverAssistant.clientTurnId || localAssistant.clientTurnId || null,
    finalContent: preserveRunningTurn
      ? localAssistant.finalContent
      : serverAssistant.finalContent || localAssistant.finalContent,
    truncated: Boolean(serverAssistant.truncated),
    textRef: serverAssistant.textRef || localAssistant.textRef || null,
    sources: serverAssistant.sources || localAssistant.sources,
    metrics: serverAssistant.metrics || localAssistant.metrics,
    feedbackScore: serverAssistant.feedbackScore,
    outputs: serverAssistant.outputs || localAssistant.outputs || [],
    clarifyingQuestions:
      serverAssistant.clarifyingQuestions ||
      localAssistant.clarifyingQuestions ||
      [],
    responseType: serverAssistant.responseType || localAssistant.responseType,
    hydrationStatus: serverAssistant.hydrationStatus || null,
    status: preserveRunningTurn
      ? TURN_STATUSES.running
      : TURN_STATUSES.completed,
    error: preserveRunningTurn ? localAssistant.error : null,
    timeline: preserveRunningTurn
      ? normalizeStoredTimeline([
          ...(localAssistant.timeline || []),
          ...(serverAssistant.timeline || []),
        ])
      : withoutTransientAgentReconnectEvents([
          ...(localAssistant.timeline || []),
          ...(serverAssistant.timeline || []),
        ]),
    updatedAt: nowMs(),
  };

  return nextItems;
}

export function mergeServerHistoryIntoTurns(
  history = [],
  localItems = [],
  options = {}
) {
  let merged = normalizeTurnItems(localItems);
  const seenIds = new Set(merged.map((item) => item.id));

  for (const group of groupedServerHistory(history)) {
    const [serverUser, serverAssistant] = serverGroupToItems(
      group,
      options.chatKey || null
    );

    const patched = patchLocalTurnWithServer(
      merged,
      serverUser,
      serverAssistant,
      options
    );
    if (patched) {
      merged = patched;
      continue;
    }

    for (const item of [serverUser, serverAssistant]) {
      if (seenIds.has(item.id)) {
        merged = normalizeTurnItems([...merged, item]);
      } else {
        seenIds.add(item.id);
        merged.push(item);
      }
    }
  }

  const normalized = pruneSupersededUnpersistedTurns(
    normalizeTurnItems(merged),
    history,
    options
  );
  if (options.pruneServerBackedItemsOutsideHistory) {
    return pruneServerBackedTurnsOutsideHistory(normalized, history, options);
  }
  return normalized;
}

export function findAssistantTurn(items = [], turnId = null) {
  if (!turnId) return null;
  return items.find((item) => isAssistantTurn(item) && item.turnId === turnId);
}

export function updateAssistantTurnInItems(items = [], turnId, patch = {}) {
  return normalizeTurnItems(items).map((item) => {
    if (!isAssistantTurn(item) || item.turnId !== turnId) return item;
    return {
      ...item,
      ...patch,
      timeline:
        patch.timeline !== undefined
          ? normalizeStoredTimeline(patch.timeline)
          : item.timeline || [],
      updatedAt: patch.updatedAt || nowMs(),
    };
  });
}

export function appendTimelineEventToItems(items = [], turnId, event = {}) {
  if (!event) return items;
  if (event.type === "remove_agent_event") {
    return normalizeTurnItems(items).map((item) =>
      isAssistantTurn(item) && item.turnId === turnId
        ? {
            ...item,
            timeline: removeTimelineEvent(item.timeline || [], event),
            updatedAt: nowMs(),
          }
        : item
    );
  }

  return normalizeTurnItems(items).map((item) =>
    isAssistantTurn(item) && item.turnId === turnId
      ? {
          ...item,
          timeline: mergeTimelineEvent(item.timeline || [], event),
          updatedAt: nowMs(),
        }
      : item
  );
}
