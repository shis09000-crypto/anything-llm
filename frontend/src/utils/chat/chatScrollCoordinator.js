export const NEAR_BOTTOM_PX = 80;
export const PINNED_BOTTOM_PX = 2;

export const initialChatScrollState = {
  intent: "pinnedToBottom",
  isNearBottom: true,
  anchorMessageId: null,
  anchorOffset: 0,
  hasNewMessagesBelow: false,
};

export function isNearChatBottom({
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
  thresholdPx = NEAR_BOTTOM_PX,
} = {}) {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}

export function isPinnedToChatBottom({
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
  thresholdPx = PINNED_BOTTOM_PX,
} = {}) {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}

export function chatScrollReducer(state = initialChatScrollState, event = {}) {
  switch (event.type) {
    case "USER_SCROLLED": {
      const isNearBottom = isNearChatBottom(event);
      const isPinnedToBottom = isPinnedToChatBottom(event);
      return {
        ...state,
        intent: isPinnedToBottom ? "pinnedToBottom" : "readingHistory",
        isNearBottom,
        hasNewMessagesBelow: isNearBottom ? false : state.hasNewMessagesBelow,
      };
    }
    case "USER_SENT_MESSAGE":
      return {
        ...state,
        intent: "sendingMessage",
        isNearBottom: true,
        hasNewMessagesBelow: false,
      };
    case "ASSISTANT_MESSAGE_STREAMING":
    case "MESSAGE_APPENDED":
      if (state.intent === "readingHistory") {
        return {
          ...state,
          hasNewMessagesBelow: true,
          anchorMessageId: event.anchorMessageId ?? state.anchorMessageId,
          anchorOffset: Number.isFinite(event.anchorOffset)
            ? event.anchorOffset
            : state.anchorOffset,
        };
      }
      if (state.intent === "sendingMessage") {
        return {
          ...state,
          intent: "pinnedToBottom",
          isNearBottom: true,
          hasNewMessagesBelow: false,
        };
      }
      return {
        ...state,
        intent: "pinnedToBottom",
        isNearBottom: true,
        hasNewMessagesBelow: false,
      };
    case "OLDER_MESSAGES_LOADING":
      return {
        ...state,
        intent: "loadingOlder",
        anchorMessageId: event.anchorMessageId ?? state.anchorMessageId,
        anchorOffset: Number.isFinite(event.anchorOffset)
          ? event.anchorOffset
          : state.anchorOffset,
      };
    case "OLDER_MESSAGES_LOADED":
      return {
        ...state,
        intent:
          state.intent === "pinnedToBottom"
            ? "pinnedToBottom"
            : "readingHistory",
      };
    case "LAYOUT_WILL_CHANGE":
      return {
        ...state,
        intent: "restoringAnchor",
        anchorMessageId: event.anchorMessageId ?? state.anchorMessageId,
        anchorOffset: Number.isFinite(event.anchorOffset)
          ? event.anchorOffset
          : state.anchorOffset,
      };
    case "LAYOUT_DID_STABILIZE":
      return {
        ...state,
        intent:
          state.intent === "pinnedToBottom"
            ? "pinnedToBottom"
            : "readingHistory",
      };
    case "JUMP_TO_BOTTOM":
      return {
        ...state,
        intent: "pinnedToBottom",
        isNearBottom: true,
        hasNewMessagesBelow: false,
        anchorMessageId: null,
        anchorOffset: 0,
      };
    default:
      return state;
  }
}
