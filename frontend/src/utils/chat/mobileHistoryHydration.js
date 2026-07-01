import { normalizeChatHistoryOrder } from "./historyOrder.js";
import { historyRequestOptionsForDevice } from "./historyRequestOptions.js";

export const MOBILE_PWA_HISTORY_HYDRATE_MARKER = "mobile-pwa-light-hydrate";

function normalizedText(value = "") {
  return String(value || "").trim();
}

function arrayPayload(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasHistoryPayload(item = {}) {
  return !!(
    normalizedText(item.content) ||
    arrayPayload(item.attachments).length > 0 ||
    arrayPayload(item.outputs).length > 0 ||
    arrayPayload(item.agentEvents).length > 0 ||
    arrayPayload(item.clarifyingQuestions).length > 0
  );
}

function historyIdentity(item = {}) {
  return item.publicChatId || item.chatId || null;
}

function historyMergeKey(item = {}) {
  const identity = historyIdentity(item);
  if (identity) return `${identity}:${item.role || "unknown"}`;
  return `${item.role || "unknown"}:${item.sentAt || ""}:${item.id || ""}`;
}

function addHydrationTarget(targets, item = {}) {
  if (item.chatId) targets.chatIds.add(item.chatId);
  if (item.publicChatId) targets.publicChatIds.add(item.publicChatId);
}

export function mobileHistoryRequestOptions({
  limit = 20,
  signal = null,
  ...options
} = {}) {
  return historyRequestOptionsForDevice({
    ...options,
    mobile: true,
    surface: "mobile",
    limit,
    signal,
  });
}

export function mobileHistoryHydrationTargets(history = []) {
  const targets = {
    chatIds: new Set(),
    publicChatIds: new Set(),
    lightCount: 0,
    emptyContentCount: 0,
  };

  for (const item of history.filter(Boolean)) {
    const hasIdentity = !!historyIdentity(item);
    if (!hasIdentity) continue;

    if (item.hydrationStatus === "light") {
      targets.lightCount += 1;
      addHydrationTarget(targets, item);
      continue;
    }

    if (
      (item.role === "assistant" || item.role === "user") &&
      !hasHistoryPayload(item)
    ) {
      targets.emptyContentCount += 1;
      addHydrationTarget(targets, item);
    }
  }

  return {
    chatIds: [...targets.chatIds],
    publicChatIds: [...targets.publicChatIds],
    lightCount: targets.lightCount,
    emptyContentCount: targets.emptyContentCount,
    needsHydration: targets.chatIds.size > 0 || targets.publicChatIds.size > 0,
  };
}

export function mergeMobileHydratedHistory(history = [], hydratedHistory = []) {
  if (!Array.isArray(hydratedHistory) || hydratedHistory.length === 0) {
    return normalizeChatHistoryOrder(history);
  }

  const order = [];
  const byKey = new Map();
  for (const item of [...history, ...hydratedHistory].filter(Boolean)) {
    const key = historyMergeKey(item);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, item);
  }

  return normalizeChatHistoryOrder(order.map((key) => byKey.get(key)));
}

export function mobileHistoryPayloadSummary(history = [], messages = []) {
  const targets = mobileHistoryHydrationTargets(history);
  const emptyRenderedMessages = messages.filter(
    (message) =>
      (message.role === "assistant" || message.role === "user") &&
      !normalizedText(message.text) &&
      !arrayPayload(message.outputs).length &&
      !arrayPayload(message.timeline).length &&
      !arrayPayload(message.clarifyingQuestions).length
  );

  return {
    historyCount: Array.isArray(history) ? history.length : 0,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    lightCount: targets.lightCount,
    emptyContentCount: targets.emptyContentCount,
    emptyRenderedCount: emptyRenderedMessages.length,
    chatIds: targets.chatIds,
    publicChatIds: targets.publicChatIds,
  };
}
