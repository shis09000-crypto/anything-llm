export function clampChatScrollTop(
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0
) {
  const top = Number(scrollTop);
  const maxTop = Math.max(Number(scrollHeight) - Number(clientHeight), 0);
  if (!Number.isFinite(top)) return 0;
  return Math.min(Math.max(top, 0), maxTop);
}

export function normalizeChatAnchor(anchor = null) {
  if (!anchor?.itemId) return null;
  const offsetTop = Number(anchor.offsetTop);
  const rowOffsetTop = Number(anchor.rowOffsetTop);
  const innerOffsetTop = Number(anchor.innerAnchor?.offsetTop);
  const innerBlockIndex = Number(anchor.innerAnchor?.blockIndex);
  return {
    itemId: String(anchor.itemId),
    offsetTop: Number.isFinite(offsetTop) ? offsetTop : 0,
    rowOffsetTop: Number.isFinite(rowOffsetTop)
      ? rowOffsetTop
      : Number.isFinite(offsetTop)
        ? offsetTop
        : 0,
    innerAnchor:
      Number.isFinite(innerBlockIndex) && innerBlockIndex >= 0
        ? {
            blockIndex: innerBlockIndex,
            offsetTop: Number.isFinite(innerOffsetTop) ? innerOffsetTop : 0,
            textFingerprint: anchor.innerAnchor?.textFingerprint
              ? String(anchor.innerAnchor.textFingerprint)
              : null,
          }
        : null,
  };
}

export function createChatScrollPositionSnapshot({
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
  anchor = null,
  firstItemId = null,
  lastItemId = null,
  savedAt = Date.now(),
} = {}) {
  const normalizedAnchor = normalizeChatAnchor(anchor);
  return {
    itemId: normalizedAnchor?.itemId || null,
    offsetTop: normalizedAnchor?.offsetTop || 0,
    rowOffsetTop: normalizedAnchor?.rowOffsetTop || 0,
    innerAnchor: normalizedAnchor?.innerAnchor || null,
    scrollTop: clampChatScrollTop(scrollTop, scrollHeight, clientHeight),
    firstItemId: firstItemId || null,
    lastItemId: lastItemId || null,
    savedAt,
  };
}

export function normalizeChatScrollPosition(position = null) {
  if (typeof position === "number") {
    return {
      itemId: null,
      offsetTop: 0,
      rowOffsetTop: 0,
      innerAnchor: null,
      scrollTop: Number.isFinite(position) ? position : 0,
      firstItemId: null,
      lastItemId: null,
      savedAt: Date.now(),
    };
  }
  if (!position || typeof position !== "object") return null;
  const normalizedAnchor = normalizeChatAnchor(
    position.itemId
      ? {
          itemId: position.itemId,
          offsetTop: position.offsetTop,
          rowOffsetTop: position.rowOffsetTop,
          innerAnchor: position.innerAnchor,
        }
      : null
  );
  const scrollTop = Number(position.scrollTop);
  return {
    itemId: normalizedAnchor?.itemId || null,
    offsetTop: normalizedAnchor?.offsetTop || 0,
    rowOffsetTop: normalizedAnchor?.rowOffsetTop || 0,
    innerAnchor: normalizedAnchor?.innerAnchor || null,
    scrollTop: Number.isFinite(scrollTop) ? scrollTop : 0,
    firstItemId: position.firstItemId || null,
    lastItemId: position.lastItemId || null,
    savedAt: position.savedAt || Date.now(),
  };
}

export function chatScrollPositionHasAnchor(position = null) {
  return Boolean(normalizeChatScrollPosition(position)?.itemId);
}

export function savedChatScrollTopFallback(
  position = null,
  {
    firstItemId = null,
    lastItemId = null,
    scrollHeight = 0,
    clientHeight = 0,
  } = {}
) {
  const normalized = normalizeChatScrollPosition(position);
  if (!normalized) return null;

  const savedFirst = normalized.firstItemId || null;
  const savedLast = normalized.lastItemId || null;
  const firstMatches = !savedFirst || savedFirst === (firstItemId || null);
  const lastMatches = !savedLast || savedLast === (lastItemId || null);
  if (!firstMatches || !lastMatches) return null;

  return clampChatScrollTop(normalized.scrollTop, scrollHeight, clientHeight);
}

export function shouldRestoreExplicitPrepend({
  hasRestoreRequest = false,
  firstItemChanged = false,
  isAtBottom = false,
} = {}) {
  return Boolean(hasRestoreRequest && firstItemChanged && !isAtBottom);
}

export function shouldPreserveParkedChatAnchor({
  hasAnchor = false,
  isAtBottom = false,
  shouldFollowOutput = false,
  isProgrammatic = false,
  sendFollowActive = false,
  layoutTransitionActive = false,
} = {}) {
  return Boolean(
    hasAnchor &&
      !isAtBottom &&
      !shouldFollowOutput &&
      !isProgrammatic &&
      !sendFollowActive &&
      !layoutTransitionActive
  );
}

export function shouldIgnorePersistedChatScrollMemory({
  sendFollowActive = false,
  persistedMemory = null,
} = {}) {
  return Boolean(sendFollowActive && persistedMemory?.isAtBottom !== true);
}

export function shouldBypassAutoScrollSuppressForSendFollow({
  suppressAutoScroll = false,
  sendFollowActive = false,
} = {}) {
  return Boolean(suppressAutoScroll && sendFollowActive);
}

export function shouldSkipChatRestoreForLayoutTransition({
  layoutTransitionActive = false,
} = {}) {
  return Boolean(layoutTransitionActive);
}

export function shouldBlockChatScrollPersistenceForLayoutTransition({
  layoutTransitionActive = false,
  hasUserIntent = false,
} = {}) {
  return Boolean(layoutTransitionActive && !hasUserIntent);
}

export function chatBottomScrollBehavior({
  smooth = false,
  sendFollowActive = false,
} = {}) {
  return sendFollowActive ? "auto" : smooth ? "smooth" : "auto";
}

export function tailHydrationFollowDecision({
  signalChanged = false,
  isAtBottom = false,
  shouldFollowOutput = false,
  hasParkedAnchor = false,
  hasSavedPosition = false,
  hasRecentUserIntent = false,
  isLoadingOlderHistory = false,
  hasPrependRestoreRequest = false,
} = {}) {
  if (!signalChanged) {
    return {
      shouldFollowBottom: false,
      blockedByUserIntent: false,
      blockedByOlderHistory: false,
    };
  }

  const blockedByOlderHistory = Boolean(
    isLoadingOlderHistory || hasPrependRestoreRequest
  );
  if (blockedByOlderHistory) {
    return {
      shouldFollowBottom: false,
      blockedByUserIntent: false,
      blockedByOlderHistory: true,
    };
  }

  if (isAtBottom || shouldFollowOutput) {
    return {
      shouldFollowBottom: true,
      blockedByUserIntent: false,
      blockedByOlderHistory: false,
    };
  }

  const blockedByUserIntent = Boolean(
    hasParkedAnchor && (hasRecentUserIntent || hasSavedPosition)
  );
  return {
    shouldFollowBottom: !blockedByUserIntent,
    blockedByUserIntent,
    blockedByOlderHistory: false,
  };
}
