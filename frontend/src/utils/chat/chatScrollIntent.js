export const CHAT_SCROLL_BOTTOM_TOLERANCE_PX = 80;
export const CHAT_SCROLL_PINNED_BOTTOM_PX = 2;
export const CHAT_SCROLL_HISTORY_LOAD_TOP_PX = 240;
export const CHAT_SCROLL_PROGRAMMATIC_SUPPRESS_MS = 240;
export const CHAT_SCROLL_SMOOTH_SUPPRESS_MS = 900;
export const CHAT_SCROLL_USER_INTENT_WINDOW_MS = 1200;

export function chatScrollBottomGap({
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
} = {}) {
  return Number(scrollHeight) - Number(scrollTop) - Number(clientHeight);
}

export function isChatScrollAtBottom(
  { scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {},
  tolerancePx = CHAT_SCROLL_BOTTOM_TOLERANCE_PX
) {
  return (
    chatScrollBottomGap({ scrollTop, scrollHeight, clientHeight }) <=
    tolerancePx
  );
}

export function isChatScrollPinnedToBottom(
  { scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {},
  tolerancePx = CHAT_SCROLL_PINNED_BOTTOM_PX
) {
  return isChatScrollAtBottom(
    { scrollTop, scrollHeight, clientHeight },
    tolerancePx
  );
}

export function markProgrammaticChatScroll(
  state,
  reason = "programmatic",
  now = Date.now(),
  durationMs = CHAT_SCROLL_PROGRAMMATIC_SUPPRESS_MS
) {
  if (!state) return null;
  state.reason = reason;
  state.until = now + durationMs;
  return state;
}

export function isProgrammaticChatScroll(state, now = Date.now()) {
  return Boolean(state?.until && state.until >= now);
}

export function markChatUserScrollIntent(
  state,
  source = "user",
  now = Date.now()
) {
  if (!state) return null;
  state.source = source;
  state.at = now;
  return state;
}

export function hasRecentChatUserScrollIntent(
  state,
  now = Date.now(),
  windowMs = CHAT_SCROLL_USER_INTENT_WINDOW_MS
) {
  return Boolean(state?.at && now - state.at <= windowMs);
}

export function isExplicitChatScrollNavigationIntent(source = null) {
  return ["wheel", "touch", "keyboard", "pointer", "shortcut-top"].includes(
    String(source || "")
  );
}

export function shouldLoadOlderChatHistory({
  scrollTop = 0,
  hasMoreHistory = false,
  isLoadingOlderHistory = false,
  hasUserIntent = false,
  isProgrammatic = false,
  thresholdPx = CHAT_SCROLL_HISTORY_LOAD_TOP_PX,
} = {}) {
  return (
    hasUserIntent &&
    !isProgrammatic &&
    hasMoreHistory &&
    !isLoadingOlderHistory &&
    scrollTop < thresholdPx
  );
}

export function getChatScrollIntent({
  chatKey = null,
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
  hasMoreHistory = false,
  isLoadingOlderHistory = false,
  programmaticState = null,
  userIntentState = null,
  now = Date.now(),
} = {}) {
  const bottomGap = chatScrollBottomGap({
    scrollTop,
    scrollHeight,
    clientHeight,
  });
  const isNearBottom = bottomGap <= CHAT_SCROLL_BOTTOM_TOLERANCE_PX;
  const isPinnedToBottom = bottomGap <= CHAT_SCROLL_PINNED_BOTTOM_PX;
  const isProgrammatic = isProgrammaticChatScroll(programmaticState, now);
  const hasUserIntent = hasRecentChatUserScrollIntent(userIntentState, now);
  const canSavePosition = Boolean(chatKey && hasUserIntent && !isProgrammatic);

  return {
    bottomGap,
    isBottom: isPinnedToBottom,
    isNearBottom,
    isPinnedToBottom,
    isProgrammatic,
    hasUserIntent,
    canSavePosition,
    shouldLeaveFollowOutput: canSavePosition && !isPinnedToBottom,
    shouldEnterFollowOutput: canSavePosition && isPinnedToBottom,
    canLoadOlderHistory: shouldLoadOlderChatHistory({
      scrollTop,
      hasMoreHistory,
      isLoadingOlderHistory,
      hasUserIntent,
      isProgrammatic,
    }),
  };
}

export function clearSavedChatScrollPosition(scrollPositions, chatKey) {
  if (!scrollPositions || !chatKey) return false;
  if (!Object.prototype.hasOwnProperty.call(scrollPositions, chatKey)) {
    return false;
  }
  delete scrollPositions[chatKey];
  return true;
}
