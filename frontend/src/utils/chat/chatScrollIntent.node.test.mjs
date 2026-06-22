import test from "node:test";
import assert from "node:assert/strict";
import {
  clearSavedChatScrollPosition,
  getChatScrollIntent,
  isChatScrollPinnedToBottom,
  isExplicitChatScrollNavigationIntent,
  markChatUserScrollIntent,
  markProgrammaticChatScroll,
  shouldLoadOlderChatHistory,
} from "./chatScrollIntent.js";

test("programmatic scroll does not save position or leave follow output", () => {
  const programmatic = {};
  markProgrammaticChatScroll(programmatic, "restore", 1_000, 500);
  const userIntent = {};
  markChatUserScrollIntent(userIntent, "wheel", 1_000);

  const intent = getChatScrollIntent({
    chatKey: "workspace:thread",
    scrollTop: 120,
    scrollHeight: 1_000,
    clientHeight: 300,
    programmaticState: programmatic,
    userIntentState: userIntent,
    now: 1_100,
  });

  assert.equal(intent.isProgrammatic, true);
  assert.equal(intent.canSavePosition, false);
  assert.equal(intent.shouldLeaveFollowOutput, false);
});

test("user scroll saves position and can leave follow output", () => {
  const userIntent = {};
  markChatUserScrollIntent(userIntent, "wheel", 2_000);

  const intent = getChatScrollIntent({
    chatKey: "workspace:thread",
    scrollTop: 320,
    scrollHeight: 1_000,
    clientHeight: 300,
    userIntentState: userIntent,
    now: 2_100,
  });

  assert.equal(intent.hasUserIntent, true);
  assert.equal(intent.canSavePosition, true);
  assert.equal(intent.shouldLeaveFollowOutput, true);
});

test("near-bottom user scroll is not pinned to bottom", () => {
  const userIntent = {};
  markChatUserScrollIntent(userIntent, "wheel", 2_500);

  const intent = getChatScrollIntent({
    chatKey: "workspace:thread",
    scrollTop: 650,
    scrollHeight: 1_000,
    clientHeight: 300,
    userIntentState: userIntent,
    now: 2_550,
  });

  assert.equal(intent.bottomGap, 50);
  assert.equal(intent.isNearBottom, true);
  assert.equal(intent.isPinnedToBottom, false);
  assert.equal(intent.isBottom, false);
  assert.equal(intent.shouldEnterFollowOutput, false);
  assert.equal(intent.shouldLeaveFollowOutput, true);
});

test("strict bottom user scroll is pinned to bottom", () => {
  const userIntent = {};
  markChatUserScrollIntent(userIntent, "wheel", 2_700);

  const intent = getChatScrollIntent({
    chatKey: "workspace:thread",
    scrollTop: 699,
    scrollHeight: 1_000,
    clientHeight: 300,
    userIntentState: userIntent,
    now: 2_750,
  });

  assert.equal(intent.bottomGap, 1);
  assert.equal(intent.isNearBottom, true);
  assert.equal(intent.isPinnedToBottom, true);
  assert.equal(intent.shouldEnterFollowOutput, true);
  assert.equal(intent.shouldLeaveFollowOutput, false);
  assert.equal(
    isChatScrollPinnedToBottom({
      scrollTop: 699,
      scrollHeight: 1_000,
      clientHeight: 300,
    }),
    true
  );
});

test("programmatic near-top scroll does not load older history", () => {
  assert.equal(
    shouldLoadOlderChatHistory({
      scrollTop: 20,
      hasMoreHistory: true,
      isLoadingOlderHistory: false,
      hasUserIntent: true,
      isProgrammatic: true,
    }),
    false
  );
});

test("user near-top scroll can load older history", () => {
  assert.equal(
    shouldLoadOlderChatHistory({
      scrollTop: 20,
      hasMoreHistory: true,
      isLoadingOlderHistory: false,
      hasUserIntent: true,
      isProgrammatic: false,
    }),
    true
  );
});

test("sending from bottom clears stale saved position", () => {
  const positions = { "workspace:thread": 120, other: 50 };

  assert.equal(
    clearSavedChatScrollPosition(positions, "workspace:thread"),
    true
  );
  assert.deepEqual(positions, { other: 50 });
});

test("prepend correction without user intent does not save position", () => {
  const programmatic = {};
  markProgrammaticChatScroll(programmatic, "older-history-anchor", 3_000, 500);

  const intent = getChatScrollIntent({
    chatKey: "workspace:thread",
    scrollTop: 260,
    scrollHeight: 2_000,
    clientHeight: 600,
    programmaticState: programmatic,
    userIntentState: null,
    now: 3_100,
  });

  assert.equal(intent.canSavePosition, false);
  assert.equal(intent.shouldLeaveFollowOutput, false);
});

test("layout transitions are cancelled only by explicit scroll navigation", () => {
  assert.equal(isExplicitChatScrollNavigationIntent("wheel"), true);
  assert.equal(isExplicitChatScrollNavigationIntent("touch"), true);
  assert.equal(isExplicitChatScrollNavigationIntent("keyboard"), true);
  assert.equal(isExplicitChatScrollNavigationIntent("pointer"), true);
  assert.equal(isExplicitChatScrollNavigationIntent("click"), false);
});
