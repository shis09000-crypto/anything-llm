import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelChatRestoreRun,
  chatBottomScrollBehavior,
  chatScrollPositionHasAnchor,
  createChatScrollPositionSnapshot,
  isChatRestoreRunCurrent,
  savedChatScrollTopFallback,
  shouldBlockChatScrollPersistenceForLayoutTransition,
  shouldBypassAutoScrollSuppressForSendFollow,
  shouldIgnorePersistedChatScrollMemory,
  shouldPreserveParkedChatAnchor,
  shouldRestoreExplicitPrepend,
  shouldSkipChatRestoreForLayoutTransition,
  startChatRestoreRun,
  tailCleanupFollowDecision,
  tailHydrationFollowDecision,
} from "./chatScrollPosition.js";

test("saved chat position records visible message anchor and list boundary", () => {
  const position = createChatScrollPositionSnapshot({
    scrollTop: 420,
    scrollHeight: 1_200,
    clientHeight: 300,
    anchor: { itemId: "message-8", offsetTop: 42 },
    firstItemId: "message-1",
    lastItemId: "message-20",
    savedAt: 10,
  });

  assert.equal(position.itemId, "message-8");
  assert.equal(position.offsetTop, 42);
  assert.equal(position.scrollTop, 420);
  assert.equal(position.firstItemId, "message-1");
  assert.equal(position.lastItemId, "message-20");
  assert.equal(chatScrollPositionHasAnchor(position), true);
});

test("scrollTop fallback is allowed only when list boundaries still match", () => {
  const position = createChatScrollPositionSnapshot({
    scrollTop: 900,
    scrollHeight: 2_000,
    clientHeight: 400,
    firstItemId: "message-1",
    lastItemId: "message-20",
  });

  assert.equal(
    savedChatScrollTopFallback(position, {
      firstItemId: "message-1",
      lastItemId: "message-20",
      scrollHeight: 2_000,
      clientHeight: 400,
    }),
    900
  );
  assert.equal(
    savedChatScrollTopFallback(position, {
      firstItemId: "message-0",
      lastItemId: "message-20",
      scrollHeight: 2_000,
      clientHeight: 400,
    }),
    null
  );
});

test("legacy numeric scrollTop is clamped when used as fallback", () => {
  assert.equal(
    savedChatScrollTopFallback(5_000, {
      firstItemId: "message-1",
      lastItemId: "message-20",
      scrollHeight: 1_000,
      clientHeight: 300,
    }),
    700
  );
});

test("prepend restoration only runs for explicit older-history requests", () => {
  assert.equal(
    shouldRestoreExplicitPrepend({
      hasRestoreRequest: false,
      firstItemChanged: true,
      isAtBottom: false,
    }),
    false
  );
  assert.equal(
    shouldRestoreExplicitPrepend({
      hasRestoreRequest: true,
      firstItemChanged: true,
      isAtBottom: false,
    }),
    true
  );
});

test("parked history anchor is preserved only outside follow-output mode", () => {
  assert.equal(
    shouldPreserveParkedChatAnchor({
      hasAnchor: true,
      isAtBottom: false,
      shouldFollowOutput: false,
      isProgrammatic: false,
    }),
    true
  );
  assert.equal(
    shouldPreserveParkedChatAnchor({
      hasAnchor: true,
      isAtBottom: false,
      shouldFollowOutput: true,
      isProgrammatic: false,
    }),
    false
  );
  assert.equal(
    shouldPreserveParkedChatAnchor({
      hasAnchor: true,
      isAtBottom: false,
      shouldFollowOutput: false,
      isProgrammatic: false,
      sendFollowActive: true,
    }),
    false
  );
  assert.equal(
    shouldPreserveParkedChatAnchor({
      hasAnchor: true,
      isAtBottom: false,
      shouldFollowOutput: false,
      isProgrammatic: false,
      layoutTransitionActive: true,
    }),
    false
  );
});

test("send-follow ignores stale non-bottom persisted memory", () => {
  assert.equal(
    shouldIgnorePersistedChatScrollMemory({
      sendFollowActive: true,
      persistedMemory: {
        chatKey: "workspace:thread",
        itemId: "server:12:assistant",
        isAtBottom: false,
      },
    }),
    true
  );
  assert.equal(
    shouldIgnorePersistedChatScrollMemory({
      sendFollowActive: true,
      persistedMemory: {
        chatKey: "workspace:thread",
        itemId: "server:45:assistant",
        isAtBottom: true,
      },
    }),
    false
  );
  assert.equal(
    shouldIgnorePersistedChatScrollMemory({
      sendFollowActive: false,
      persistedMemory: {
        chatKey: "workspace:thread",
        itemId: "server:12:assistant",
        isAtBottom: false,
      },
    }),
    false
  );
});

test("send-follow bypasses one-shot suppress and disables smooth bottom scroll", () => {
  assert.equal(
    shouldBypassAutoScrollSuppressForSendFollow({
      suppressAutoScroll: true,
      sendFollowActive: true,
    }),
    true
  );
  assert.equal(
    shouldBypassAutoScrollSuppressForSendFollow({
      suppressAutoScroll: true,
      sendFollowActive: false,
    }),
    false
  );
  assert.equal(
    chatBottomScrollBehavior({
      smooth: true,
      sendFollowActive: true,
    }),
    "auto"
  );
  assert.equal(
    chatBottomScrollBehavior({
      smooth: true,
      sendFollowActive: false,
    }),
    "smooth"
  );
});

test("layout transition skips persisted restore and programmatic persistence", () => {
  assert.equal(
    shouldSkipChatRestoreForLayoutTransition({
      layoutTransitionActive: true,
    }),
    true
  );
  assert.equal(
    shouldSkipChatRestoreForLayoutTransition({
      layoutTransitionActive: false,
    }),
    false
  );
  assert.equal(
    shouldBlockChatScrollPersistenceForLayoutTransition({
      layoutTransitionActive: true,
      hasUserIntent: false,
    }),
    true
  );
  assert.equal(
    shouldBlockChatScrollPersistenceForLayoutTransition({
      layoutTransitionActive: true,
      hasUserIntent: true,
    }),
    false
  );
});

test("tail hydration follows bottom when no user parked anchor blocks it", () => {
  assert.deepEqual(
    tailHydrationFollowDecision({
      signalChanged: true,
      isAtBottom: false,
      shouldFollowOutput: true,
      hasParkedAnchor: false,
      hasSavedPosition: false,
      hasRecentUserIntent: false,
    }),
    {
      shouldFollowBottom: true,
      blockedByUserIntent: false,
      blockedByOlderHistory: false,
    }
  );
});

test("tail hydration does not override a user parked history anchor", () => {
  assert.deepEqual(
    tailHydrationFollowDecision({
      signalChanged: true,
      isAtBottom: false,
      shouldFollowOutput: false,
      hasParkedAnchor: true,
      hasSavedPosition: true,
      hasRecentUserIntent: true,
    }),
    {
      shouldFollowBottom: false,
      blockedByUserIntent: true,
      blockedByOlderHistory: false,
    }
  );
});

test("tail hydration does not run during explicit older-history prepend", () => {
  assert.deepEqual(
    tailHydrationFollowDecision({
      signalChanged: true,
      isAtBottom: false,
      shouldFollowOutput: true,
      hasPrependRestoreRequest: true,
    }),
    {
      shouldFollowBottom: false,
      blockedByUserIntent: false,
      blockedByOlderHistory: true,
    }
  );
});

test("tail cleanup follows bottom when no user anchor blocks it", () => {
  assert.deepEqual(
    tailCleanupFollowDecision({
      signalChanged: true,
      isAtBottom: false,
      shouldFollowOutput: true,
      hasParkedAnchor: false,
      hasSavedPosition: false,
      hasRecentUserIntent: false,
    }),
    {
      shouldFollowBottom: true,
      blockedByUserIntent: false,
      blockedByOlderHistory: false,
    }
  );
});

test("tail cleanup respects a user parked history anchor", () => {
  assert.deepEqual(
    tailCleanupFollowDecision({
      signalChanged: true,
      isAtBottom: false,
      shouldFollowOutput: false,
      hasParkedAnchor: true,
      hasSavedPosition: true,
      hasRecentUserIntent: true,
    }),
    {
      shouldFollowBottom: false,
      blockedByUserIntent: true,
      blockedByOlderHistory: false,
    }
  );
});

test("chat restore run generation invalidates stale settle callbacks", () => {
  const state = { active: false, generation: 0 };

  const firstRun = startChatRestoreRun(state);
  assert.equal(isChatRestoreRunCurrent(state, firstRun), true);

  cancelChatRestoreRun(state);
  assert.equal(isChatRestoreRunCurrent(state, firstRun), false);

  const secondRun = startChatRestoreRun(state);
  assert.equal(isChatRestoreRunCurrent(state, secondRun), true);
  assert.equal(isChatRestoreRunCurrent(state, firstRun), false);
});
