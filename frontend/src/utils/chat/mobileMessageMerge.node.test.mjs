import test from "node:test";
import assert from "node:assert/strict";
import { mergeMobileMessagesWithDraft } from "./mobileMessageMerge.js";

function user(chatId, text, sentAt) {
  return {
    id: `u-${chatId}`,
    role: "user",
    chatId,
    publicChatId: `chat_${chatId}`,
    text,
    sentAt,
  };
}

function assistant(chatId, text, sentAt, extra = {}) {
  return {
    id: `a-${chatId}`,
    role: "assistant",
    chatId,
    publicChatId: `chat_${chatId}`,
    text,
    sentAt,
    ...extra,
  };
}

test("filters stale server-backed draft messages outside the persisted page", () => {
  const persisted = [
    user(2058, "latest prompt", 1782484848),
    assistant(2058, "latest answer", 1782484848),
    user(2059, "newer prompt", 1782489445),
    assistant(2059, "newer answer", 1782489445),
    user(2060, "current prompt", 1782493045),
    assistant(2060, "current answer", 1782493045),
  ];
  const draftMessages = [
    user(1886, "old prompt", 1781703527),
    assistant(1886, "old answer", 1781703527),
  ];

  const result = mergeMobileMessagesWithDraft(persisted, draftMessages);

  assert.deepEqual(
    result.messages.map((message) => message.id),
    persisted.map((message) => message.id)
  );
  assert.deepEqual(
    result.filteredDraftMessages.map((message) => message.id),
    ["u-1886", "a-1886"]
  );
});

test("keeps an unfinished local draft turn at the bottom", () => {
  const persisted = [user(2059, "previous prompt", 1782489445)];
  const draftMessages = [
    {
      id: "turn:local:user",
      role: "user",
      text: "current prompt",
      sentAt: 1782493045,
      draftTurnId: "turn:local",
      draftTurnStatus: "running",
      draftTurnUnfinished: true,
    },
    {
      id: "turn:local:assistant",
      role: "assistant",
      text: "partial answer",
      sentAt: 1782493045,
      status: "running",
      draftTurnId: "turn:local",
      draftTurnStatus: "running",
      draftTurnUnfinished: true,
    },
  ];

  const result = mergeMobileMessagesWithDraft(persisted, draftMessages);

  assert.deepEqual(
    result.messages.map((message) => message.id),
    ["u-2059", "turn:local:user", "turn:local:assistant"]
  );
  assert.deepEqual(result.filteredDraftMessages, []);
});

test("keeps the current persisted draft turn until history catches up", () => {
  const persisted = [
    user(2058, "older prompt", 1782484848),
    assistant(2058, "older answer", 1782484848),
    user(2059, "previous prompt", 1782489445),
    assistant(2059, "previous answer", 1782489445),
  ];
  const draftMessages = [
    user(2060, "current prompt", 1782493045),
    assistant(2060, "current answer", 1782493045, {
      status: "completed",
      draftTurnId: "turn:current",
      draftTurnStatus: "completed",
    }),
  ];

  const result = mergeMobileMessagesWithDraft(persisted, draftMessages, {
    pending: {
      messageId: "u-local",
      text: "current prompt",
      submittedAt: 1782493045,
    },
  });

  assert.deepEqual(
    result.messages.map((message) => message.id),
    ["u-2058", "a-2058", "u-2059", "a-2059", "u-2060", "a-2060"]
  );
  assert.deepEqual(result.filteredDraftMessages, []);
});

test("keeps the current clientTurnId draft even when repeated text exists", () => {
  const persisted = [
    user(2058, "重复问题", 1782484848),
    assistant(2058, "old answer", 1782484848),
    user(2059, "previous prompt", 1782489445),
    assistant(2059, "previous answer", 1782489445),
  ];
  const draftMessages = [
    {
      ...user(2060, "重复问题", 1782493045),
      clientTurnId: "turn:current",
      draftTurnId: "turn:current",
      draftTurnStatus: "completed",
    },
    {
      ...assistant(2060, "current answer", 1782493045),
      clientTurnId: "turn:current",
      draftTurnId: "turn:current",
      draftTurnStatus: "completed",
      status: "completed",
    },
  ];

  const result = mergeMobileMessagesWithDraft(persisted, draftMessages, {
    pending: {
      messageId: "u-local",
      clientTurnId: "turn:current",
      text: "重复问题",
      submittedAt: 1782493045,
    },
  });

  assert.deepEqual(
    result.messages.map((message) => message.id),
    ["u-2058", "a-2058", "u-2059", "a-2059", "u-2060", "a-2060"]
  );
  assert.deepEqual(result.filteredDraftMessages, []);
});

test("does not duplicate the current turn once server history contains it", () => {
  const persisted = [
    user(2060, "current prompt", 1782493045),
    assistant(2060, "current answer from server", 1782493045),
  ];
  const draftMessages = [
    user(2060, "current prompt", 1782493045),
    assistant(2060, "current answer from draft", 1782493045),
  ];

  const result = mergeMobileMessagesWithDraft(persisted, draftMessages);

  assert.deepEqual(
    result.messages.map((message) => message.text),
    ["current prompt", "current answer from server"]
  );
  assert.deepEqual(result.filteredDraftMessages, []);
});
