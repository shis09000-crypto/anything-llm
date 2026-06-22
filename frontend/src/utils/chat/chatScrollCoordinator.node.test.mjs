import test from "node:test";
import assert from "node:assert/strict";
import {
  chatScrollReducer,
  initialChatScrollState,
  isNearChatBottom,
  isPinnedToChatBottom,
  NEAR_BOTTOM_PX,
  PINNED_BOTTOM_PX,
} from "./chatScrollCoordinator.js";

test("near bottom uses an 80px threshold", () => {
  assert.equal(
    isNearChatBottom({
      scrollTop: 620,
      scrollHeight: 1_000,
      clientHeight: 300,
    }),
    true
  );
  assert.equal(
    isNearChatBottom({
      scrollTop: 619,
      scrollHeight: 1_000,
      clientHeight: 300,
    }),
    false
  );
  assert.equal(NEAR_BOTTOM_PX, 80);
  assert.equal(PINNED_BOTTOM_PX, 2);
});

test("near bottom is not pinned until the strict 2px threshold", () => {
  assert.equal(
    isPinnedToChatBottom({
      scrollTop: 650,
      scrollHeight: 1_000,
      clientHeight: 300,
    }),
    false
  );
  assert.equal(
    isPinnedToChatBottom({
      scrollTop: 699,
      scrollHeight: 1_000,
      clientHeight: 300,
    }),
    true
  );

  const near = chatScrollReducer(initialChatScrollState, {
    type: "USER_SCROLLED",
    scrollTop: 650,
    scrollHeight: 1_000,
    clientHeight: 300,
  });

  assert.equal(near.isNearBottom, true);
  assert.equal(near.intent, "readingHistory");
});

test("assistant streaming while reading history does not enter bottom follow", () => {
  const reading = chatScrollReducer(initialChatScrollState, {
    type: "USER_SCROLLED",
    scrollTop: 100,
    scrollHeight: 1_000,
    clientHeight: 300,
  });
  const streamed = chatScrollReducer(reading, {
    type: "ASSISTANT_MESSAGE_STREAMING",
    anchorMessageId: "message-4",
    anchorOffset: 24,
  });

  assert.equal(streamed.intent, "readingHistory");
  assert.equal(streamed.hasNewMessagesBelow, true);
  assert.equal(streamed.anchorMessageId, "message-4");
  assert.equal(streamed.anchorOffset, 24);
});

test("assistant streaming at strict bottom keeps pinnedToBottom", () => {
  const bottom = chatScrollReducer(initialChatScrollState, {
    type: "USER_SCROLLED",
    scrollTop: 699,
    scrollHeight: 1_000,
    clientHeight: 300,
  });
  const streamed = chatScrollReducer(bottom, {
    type: "ASSISTANT_MESSAGE_STREAMING",
  });

  assert.equal(streamed.intent, "pinnedToBottom");
  assert.equal(streamed.hasNewMessagesBelow, false);
});

test("user sent message forces bottom follow", () => {
  const reading = {
    ...initialChatScrollState,
    intent: "readingHistory",
    isNearBottom: false,
    hasNewMessagesBelow: true,
  };

  const sent = chatScrollReducer(reading, { type: "USER_SENT_MESSAGE" });

  assert.equal(sent.intent, "sendingMessage");
  assert.equal(sent.isNearBottom, true);
  assert.equal(sent.hasNewMessagesBelow, false);

  const appended = chatScrollReducer(sent, {
    type: "MESSAGE_APPENDED",
    messageId: "assistant-1",
  });
  assert.equal(appended.intent, "pinnedToBottom");
});

test("older message loading preserves message anchor", () => {
  const loading = chatScrollReducer(initialChatScrollState, {
    type: "OLDER_MESSAGES_LOADING",
    anchorMessageId: "message-8",
    anchorOffset: 36,
  });

  assert.equal(loading.intent, "loadingOlder");
  assert.equal(loading.anchorMessageId, "message-8");
  assert.equal(loading.anchorOffset, 36);

  const loaded = chatScrollReducer(
    { ...loading, isNearBottom: false },
    { type: "OLDER_MESSAGES_LOADED" }
  );
  assert.equal(loaded.intent, "readingHistory");
});

test("jump to bottom clears new-message badge", () => {
  const jumped = chatScrollReducer(
    {
      ...initialChatScrollState,
      intent: "readingHistory",
      isNearBottom: false,
      hasNewMessagesBelow: true,
      anchorMessageId: "message-1",
      anchorOffset: 12,
    },
    { type: "JUMP_TO_BOTTOM" }
  );

  assert.equal(jumped.intent, "pinnedToBottom");
  assert.equal(jumped.hasNewMessagesBelow, false);
  assert.equal(jumped.anchorMessageId, null);
});
