import { v4 } from "uuid";
import { normalizeTurnItemsOrder } from "./historyOrder.js";
import { dedupeReaderTextSources } from "./readerTextSources.js";

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
  if (turn.status === TURN_STATUSES.failed) return !hasMeaningfulOutput;
  if (turn.reconnectState === "failed") return !hasMeaningfulOutput;
  if (
    turn.status === TURN_STATUSES.interrupted ||
    turn.reconnectState === "offer"
  ) {
    return !hasMeaningfulOutput;
  }
  if (turn.status !== TURN_STATUSES.running) return false;
  if (options.removeRunning === false) return false;
  if (hasMeaningfulOutput) return false;

  if (turn.reconnectState === "retrying") {
    if (!turn.websocketUUID) return true;
    return isAgentReconnectAttemptStale(turn, now);
  }

  if (Number.isFinite(Number(options.runningMaxAgeMs))) {
    const timestamp = Number(turn.updatedAt || turn.createdAt || 0);
    const ageMs = timestamp > 0 ? now - timestamp : Infinity;
    return ageMs > Number(options.runningMaxAgeMs);
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
        user: null,
        assistant: null,
      });
      groups.push(byChatId.get(chatId));
    }

    const group = byChatId.get(chatId);
    group.publicChatId = group.publicChatId || message.publicChatId || null;
    if (message.role === "user" && !group.user) group.user = message;
    if (message.role === "assistant") group.assistant = message;
  }

  return groups.filter((group) => group.user || group.assistant);
}

function serverGroupToItems(group, chatKey = null) {
  const turnId = serverTurnId(group.chatId);
  const createdAt =
    (group.user?.sentAt || group.assistant?.sentAt || nowMs()) * 1000;
  const userMessage = {
    id: userItemId(turnId),
    type: "user",
    role: "user",
    turnId,
    content: group.user?.content || "",
    attachments: group.user?.attachments || [],
    readerTextSources: dedupeReaderTextSources(group.user?.readerTextSources),
    chatId: group.chatId,
    createdAt,
    hydrationStatus: group.user?.hydrationStatus || null,
    publicChatId: group.publicChatId,
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
    status: TURN_STATUSES.completed,
    finalContent: assistant.content || "",
    sources: assistant.sources || [],
    metrics: assistant.metrics || {},
    chatId: group.chatId,
    publicChatId: group.publicChatId,
    chatKey,
    error: assistant.error || null,
    createdAt: createdAt + 1,
    updatedAt: createdAt + 1,
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

function userFingerprint(item = {}) {
  if (!isUserItem(item)) return null;
  return `${String(item.content || "").trim()}:${stableJson(item.attachments || [])}`;
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

function patchLocalTurnWithServer(localItems, serverUser, serverAssistant) {
  let localAssistantIdx = localItems.findIndex(
    (item) =>
      isAssistantTurn(item) &&
      serverAssistant.chatId &&
      item.chatId === serverAssistant.chatId
  );

  if (localAssistantIdx === -1) {
    const candidates = localItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        if (!isAssistantTurn(item) || item.chatId) return false;
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
        return userFingerprint(localUser) === userFingerprint(serverUser);
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
  const localUserIdx = localItems.findIndex(
    (item) => item.id === localAssistant.userMessageId
  );
  const nextItems = [...localItems];

  if (localUserIdx >= 0) {
    nextItems[localUserIdx] = {
      ...nextItems[localUserIdx],
      chatId: nextItems[localUserIdx].chatId || serverUser.chatId,
      publicChatId:
        nextItems[localUserIdx].publicChatId || serverUser.publicChatId || null,
      content: nextItems[localUserIdx].content || serverUser.content,
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
    finalContent: serverAssistant.finalContent || localAssistant.finalContent,
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
    status: TURN_STATUSES.completed,
    error: null,
    timeline: normalizeStoredTimeline([
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
      serverAssistant
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

  return normalizeTurnItems(merged);
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
