import test from "node:test";
import assert from "node:assert/strict";
import {
  clearSavedChatScrollPosition,
  getChatScrollIntent,
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
