const ROLE_ORDER = {
  user: 0,
  assistant: 1,
};

function numericChatId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function roleOrder(role) {
  return ROLE_ORDER[role] ?? 2;
}

function itemCreatedAt(item = {}) {
  const value = Number(item.createdAt ?? item.sentAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function turnOrderState(items = []) {
  const byTurnId = new Map();
  for (const item of items) {
    if (!item?.turnId) continue;
    const current = byTurnId.get(item.turnId) || {
      chatId: null,
      createdAt: Number.POSITIVE_INFINITY,
    };
    const chatId = numericChatId(item.chatId);
    byTurnId.set(item.turnId, {
      chatId: current.chatId ?? chatId,
      createdAt: Math.min(current.createdAt, itemCreatedAt(item)),
    });
  }
  return byTurnId;
}

export function normalizeChatHistoryOrder(history = []) {
  return history
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const aChatId = numericChatId(a.message?.chatId);
      const bChatId = numericChatId(b.message?.chatId);
      if (aChatId !== null && bChatId !== null && aChatId !== bChatId) {
        return aChatId - bChatId;
      }
      if (aChatId !== null && bChatId === null) return -1;
      if (aChatId === null && bChatId !== null) return 1;

      const roleDelta = roleOrder(a.message?.role) - roleOrder(b.message?.role);
      if (aChatId !== null && roleDelta !== 0) return roleDelta;

      return a.index - b.index;
    })
    .map(({ message }) => message);
}

export function findChatHistoryOrderIssue(history = []) {
  let previous = null;
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    const chatId = numericChatId(message?.chatId);
    if (chatId === null) continue;

    if (previous) {
      if (chatId < previous.chatId) {
        return {
          type: "chatId_descended",
          index,
          previousChatId: previous.chatId,
          chatId,
          role: message?.role || null,
          previousRole: previous.role,
        };
      }
      if (
        chatId === previous.chatId &&
        roleOrder(message?.role) < roleOrder(previous.role)
      ) {
        return {
          type: "role_order",
          index,
          previousChatId: previous.chatId,
          chatId,
          role: message?.role || null,
          previousRole: previous.role,
        };
      }
    }

    previous = { chatId, role: message?.role || null };
  }
  return null;
}

export function normalizeTurnItemsOrder(items = []) {
  const turnState = turnOrderState(items);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aTurn = turnState.get(a.item?.turnId) || {};
      const bTurn = turnState.get(b.item?.turnId) || {};
      const aChatId = aTurn.chatId ?? numericChatId(a.item?.chatId);
      const bChatId = bTurn.chatId ?? numericChatId(b.item?.chatId);

      if (aChatId !== null && bChatId !== null && aChatId !== bChatId) {
        return aChatId - bChatId;
      }
      if (aChatId !== null && bChatId === null) return -1;
      if (aChatId === null && bChatId !== null) return 1;

      if (
        (aChatId !== null && aChatId === bChatId) ||
        (a.item?.turnId && b.item?.turnId && a.item.turnId === b.item.turnId)
      ) {
        const roleDelta = roleOrder(a.item?.role) - roleOrder(b.item?.role);
        if (roleDelta !== 0) return roleDelta;
      }

      const aCreatedAt = aTurn.createdAt ?? itemCreatedAt(a.item);
      const bCreatedAt = bTurn.createdAt ?? itemCreatedAt(b.item);
      if (Number.isFinite(aCreatedAt) && Number.isFinite(bCreatedAt)) {
        if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;
      }

      return a.index - b.index;
    })
    .map(({ item }) => item);
}
