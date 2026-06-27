const ROLE_ORDER = {
  user: 0,
  assistant: 1,
};

const UNFINISHED_STATUSES = new Set(["running", "interrupted"]);

function normalizedText(value = "") {
  return String(value || "").trim();
}

function numericChatId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function numericSentAt(value) {
  const sentAt = Number(value);
  if (!Number.isFinite(sentAt) || sentAt <= 0) return null;
  return sentAt > 10_000_000_000
    ? Math.floor(sentAt / 1000)
    : Math.floor(sentAt);
}

function roleOrder(role) {
  return ROLE_ORDER[role] ?? 2;
}

function messageClientTurnId(message = {}) {
  return message.clientTurnId || message.draftTurnId || message.turnId || null;
}

export function mobileMessageRealKey(message = {}) {
  const id = message.publicChatId || message.chatId;
  return id ? `${message.role}:${id}` : null;
}

export function mobileMessagesLookSame(first = {}, second = {}) {
  if (first.role !== second.role) return false;
  if (normalizedText(first.text) !== normalizedText(second.text)) return false;
  const firstSentAt = numericSentAt(first.sentAt);
  const secondSentAt = numericSentAt(second.sentAt);
  if (!firstSentAt || !secondSentAt) return false;
  return Math.abs(firstSentAt - secondSentAt) <= 180;
}

function persistedWindowBounds(messages = []) {
  return messages.reduce(
    (bounds, message) => {
      const realKey = mobileMessageRealKey(message);
      if (realKey) bounds.realKeys.add(realKey);

      const chatId = numericChatId(message.chatId);
      if (chatId !== null) {
        bounds.hasServerBackedMessages = true;
        bounds.maxChatId =
          bounds.maxChatId === null
            ? chatId
            : Math.max(bounds.maxChatId, chatId);
      }

      const sentAt = numericSentAt(message.sentAt);
      if (sentAt !== null) {
        bounds.maxSentAt =
          bounds.maxSentAt === null
            ? sentAt
            : Math.max(bounds.maxSentAt, sentAt);
      }

      return bounds;
    },
    {
      realKeys: new Set(),
      hasServerBackedMessages: false,
      maxChatId: null,
      maxSentAt: null,
    }
  );
}

function messageMatchesPendingTurn(message = {}, pending = null) {
  if (!pending?.submittedAt) return false;
  const expectedClientTurnId = pending.clientTurnId || null;
  if (expectedClientTurnId) {
    const candidateClientTurnId = messageClientTurnId(message);
    if (candidateClientTurnId) {
      return candidateClientTurnId === expectedClientTurnId;
    }
  }
  const sentAt = numericSentAt(message.sentAt);
  const submittedAt = numericSentAt(pending.submittedAt);
  if (!sentAt || !submittedAt) return false;
  if (Math.abs(sentAt - submittedAt) > 180) return false;
  if (message.role === "assistant") return true;
  return (
    message.id === pending.messageId ||
    normalizedText(message.text) === normalizedText(pending.text)
  );
}

function draftMessageIsUnfinished(message = {}) {
  return !!(
    message.draftIsActiveTurn ||
    message.draftTurnUnfinished ||
    UNFINISHED_STATUSES.has(message.status) ||
    UNFINISHED_STATUSES.has(message.draftTurnStatus)
  );
}

function draftMessageIsNewerThanPersistedWindow(message = {}, bounds = {}) {
  const chatId = numericChatId(message.chatId);
  if (
    chatId !== null &&
    bounds.maxChatId !== null &&
    chatId > bounds.maxChatId
  ) {
    return true;
  }

  const sentAt = numericSentAt(message.sentAt);
  if (
    sentAt !== null &&
    bounds.maxSentAt !== null &&
    sentAt >= bounds.maxSentAt - 5
  ) {
    return true;
  }

  return !bounds.hasServerBackedMessages;
}

function shouldAppendServerBackedDraftMessage(
  message = {},
  bounds = {},
  pending = null
) {
  if (draftMessageIsUnfinished(message)) return true;
  if (messageMatchesPendingTurn(message, pending)) return true;
  return draftMessageIsNewerThanPersistedWindow(message, bounds);
}

function filteredDraftMessage(message = {}, reason = "stale_server_backed") {
  return {
    id: message.id || null,
    role: message.role || null,
    chatId: message.chatId || null,
    publicChatId: message.publicChatId || null,
    sentAt: numericSentAt(message.sentAt),
    draftTurnId: message.draftTurnId || null,
    draftTurnStatus: message.draftTurnStatus || message.status || null,
    reason,
  };
}

export function normalizeMobileMessageOrder(messages = []) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const aChatId = numericChatId(a.message.chatId);
      const bChatId = numericChatId(b.message.chatId);
      if (aChatId !== null && bChatId !== null && aChatId !== bChatId) {
        return aChatId - bChatId;
      }

      const aSentAt = numericSentAt(a.message.sentAt);
      const bSentAt = numericSentAt(b.message.sentAt);
      if (aSentAt !== null && bSentAt !== null && aSentAt !== bSentAt) {
        return aSentAt - bSentAt;
      }

      const roleDelta = roleOrder(a.message.role) - roleOrder(b.message.role);
      if (roleDelta !== 0 && (aChatId === bChatId || aSentAt === bSentAt)) {
        return roleDelta;
      }

      if (aChatId !== null && bChatId === null) return -1;
      if (aChatId === null && bChatId !== null) return 1;

      return a.index - b.index;
    })
    .map(({ message }) => message);
}

export function mergeMobileMessagesWithDraft(
  persisted = [],
  draftMessages = [],
  options = {}
) {
  if (!draftMessages.length) {
    return {
      messages: normalizeMobileMessageOrder(persisted),
      filteredDraftMessages: [],
    };
  }

  const bounds = persistedWindowBounds(persisted);
  const merged = [...persisted];
  const filteredDraftMessages = [];

  for (const draftMessage of draftMessages) {
    const realKey = mobileMessageRealKey(draftMessage);
    if (realKey && bounds.realKeys.has(realKey)) continue;
    if (
      !realKey &&
      merged.some((message) => mobileMessagesLookSame(message, draftMessage))
    ) {
      continue;
    }

    if (
      realKey &&
      !shouldAppendServerBackedDraftMessage(
        draftMessage,
        bounds,
        options.pending || null
      )
    ) {
      filteredDraftMessages.push(filteredDraftMessage(draftMessage));
      continue;
    }

    merged.push(draftMessage);
    if (realKey) bounds.realKeys.add(realKey);
  }

  return {
    messages: normalizeMobileMessageOrder(merged),
    filteredDraftMessages,
  };
}
