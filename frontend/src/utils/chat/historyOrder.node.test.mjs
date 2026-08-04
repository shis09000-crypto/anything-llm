import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChatHistoryOrder,
  normalizeTurnItemsOrder,
} from "./historyOrder.js";
import { TURN_STATUSES, mergeServerHistoryIntoTurns } from "./turns.js";

function rolesByChatId(history) {
  return history.map(
    (message) => `${message.chatId || "local"}:${message.role}`
  );
}

test("normalizeChatHistoryOrder sorts persisted chat messages by chatId and role", () => {
  const local = { role: "user", content: "sending" };
  const ordered = normalizeChatHistoryOrder([
    { chatId: 3, role: "user", content: "u3" },
    { chatId: 1, role: "assistant", content: "a1" },
    { chatId: 2, role: "assistant", content: "a2" },
    local,
    { chatId: 1, role: "user", content: "u1" },
    { chatId: 2, role: "user", content: "u2" },
    { chatId: 3, role: "assistant", content: "a3" },
  ]);

  assert.deepEqual(rolesByChatId(ordered), [
    "1:user",
    "1:assistant",
    "2:user",
    "2:assistant",
    "3:user",
    "3:assistant",
    "local:user",
  ]);
});

test("normalizeChatHistoryOrder keeps hydrate updates in canonical position", () => {
  const ordered = normalizeChatHistoryOrder([
    { chatId: 10, role: "user", hydrationStatus: "light" },
    { chatId: 10, role: "assistant", hydrationStatus: "light" },
    { chatId: 8, role: "assistant", content: "hydrated" },
    { chatId: 8, role: "user", content: "hydrated prompt" },
    { chatId: 11, role: "user" },
  ]);

  assert.deepEqual(rolesByChatId(ordered), [
    "8:user",
    "8:assistant",
    "10:user",
    "10:assistant",
    "11:user",
  ]);
});

test("mergeServerHistoryIntoTurns repairs out-of-order server and draft items", () => {
  const localUser = {
    id: "turn:local:user",
    type: "user",
    role: "user",
    turnId: "turn:local",
    content: "local prompt",
    createdAt: 10,
  };
  const localAssistant = {
    id: "turn:local:assistant",
    type: "assistant_turn",
    role: "assistant",
    turnId: "turn:local",
    userMessageId: localUser.id,
    status: TURN_STATUSES.running,
    finalContent: "",
    createdAt: 11,
  };

  const items = mergeServerHistoryIntoTurns(
    [
      { chatId: 3, role: "user", content: "u3", sentAt: 300 },
      { chatId: 3, role: "assistant", content: "a3", sentAt: 300 },
      { chatId: 1, role: "assistant", content: "a1", sentAt: 100 },
      { chatId: 1, role: "user", content: "u1", sentAt: 100 },
      { chatId: 2, role: "user", content: "u2", sentAt: 200 },
      { chatId: 2, role: "assistant", content: "a2", sentAt: 200 },
    ],
    [localUser, localAssistant],
    {
      chatKey: "workspace:thread",
      preserveRunningTurnIds: ["turn:local"],
    }
  );

  assert.deepEqual(
    items.map((item) => `${item.chatId || "local"}:${item.role}`),
    [
      "1:user",
      "1:assistant",
      "2:user",
      "2:assistant",
      "3:user",
      "3:assistant",
      "local:user",
      "local:assistant",
    ]
  );
});

test("normalizeTurnItemsOrder keeps a partially persisted local turn together", () => {
  const ordered = normalizeTurnItemsOrder([
    {
      id: "server:5:assistant",
      type: "assistant_turn",
      role: "assistant",
      turnId: "server:5",
      chatId: 5,
      createdAt: 501,
    },
    {
      id: "local:user",
      type: "user",
      role: "user",
      turnId: "local",
      createdAt: 1000,
    },
    {
      id: "local:assistant",
      type: "assistant_turn",
      role: "assistant",
      turnId: "local",
      chatId: 4,
      createdAt: 1001,
    },
    {
      id: "server:5:user",
      type: "user",
      role: "user",
      turnId: "server:5",
      chatId: 5,
      createdAt: 500,
    },
  ]);

  assert.deepEqual(
    ordered.map((item) => `${item.chatId || "missing"}:${item.role}`),
    ["missing:user", "4:assistant", "5:user", "5:assistant"]
  );
});
