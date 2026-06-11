export const CHAT_SCROLL_BOTTOM_TOLERANCE_PX = 2;
export const CHAT_SCROLL_HISTORY_LOAD_TOP_PX = 240;
export const CHAT_SCROLL_PROGRAMMATIC_SUPPRESS_MS = 240;
export const CHAT_SCROLL_SMOOTH_SUPPRESS_MS = 900;
export const CHAT_SCROLL_USER_INTENT_WINDOW_MS = 1200;

export function isChatScrollAtBottom(
  { scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {},
  tolerancePx = CHAT_SCROLL_BOTTOM_TOLERANCE_PX
) {
  return scrollHeight - scrollTop - clientHeight < tolerancePx;
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
  const isBottom = isChatScrollAtBottom({
    scrollTop,
    scrollHeight,
    clientHeight,
  });
  const isProgrammatic = isProgrammaticChatScroll(programmaticState, now);
  const hasUserIntent = hasRecentChatUserScrollIntent(userIntentState, now);
  const canSavePosition = Boolean(chatKey && hasUserIntent && !isProgrammatic);

  return {
    isBottom,
    isProgrammatic,
    hasUserIntent,
    canSavePosition,
    shouldLeaveFollowOutput: canSavePosition && !isBottom,
    shouldEnterFollowOutput: canSavePosition && isBottom,
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
