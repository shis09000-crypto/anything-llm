import test from "node:test";
import assert from "node:assert/strict";
import {
  TURN_STATUSES,
  cleanupTransientDraftItems,
  hasMeaningfulTransientAssistantOutput,
  mergeServerHistoryIntoTurns,
} from "./turns.js";

function localTurn({
  turnId = "turn:local",
  status = TURN_STATUSES.running,
  reconnectState = null,
  finalContent = "",
  timeline = [],
  interruptedContext = null,
} = {}) {
  const user = {
    id: `${turnId}:user`,
    type: "user",
    role: "user",
    turnId,
    content: "用户问题",
    attachments: [],
    createdAt: 10,
  };
  const assistant = {
    id: `${turnId}:assistant`,
    type: "assistant_turn",
    role: "assistant",
    turnId,
    userMessageId: user.id,
    status,
    reconnectState,
    finalContent,
    timeline,
    interruptedContext,
    createdAt: 11,
  };
  return { user, assistant, items: [user, assistant] };
}

test("cleanup removes empty failed transient turn with its local user", () => {
  const { items } = localTurn({ status: TURN_STATUSES.failed });
  const result = cleanupTransientDraftItems(items, { removeRunning: false });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.removedTurnIds, ["turn:local"]);
  assert.equal(result.removedTurns[0].status, TURN_STATUSES.failed);
});

test("cleanup removes empty interrupted reconnect offer", () => {
  const { items } = localTurn({
    status: TURN_STATUSES.interrupted,
    reconnectState: "offer",
    timeline: [
      {
        type: "thought",
        content: "Agent connection interrupted. Reconnecting 5/5...",
      },
    ],
  });
  const result = cleanupTransientDraftItems(items, { removeRunning: false });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.removedTurnIds, ["turn:local"]);
});

test("cleanup keeps interrupted turn with useful partial answer", () => {
  const { items, assistant } = localTurn({
    status: TURN_STATUSES.interrupted,
    reconnectState: "offer",
    finalContent: "已经生成的部分回答",
  });
  const result = cleanupTransientDraftItems(items, { removeRunning: false });

  assert.equal(hasMeaningfulTransientAssistantOutput(assistant), true);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.removedTurnIds, []);
});

test("cleanup keeps interrupted turn with completed tool result", () => {
  const { items } = localTurn({
    status: TURN_STATUSES.interrupted,
    reconnectState: "offer",
    timeline: [
      {
        type: "tool_result",
        toolName: "search",
        content: "工具已经返回的内容",
      },
    ],
  });
  const result = cleanupTransientDraftItems(items, { removeRunning: false });

  assert.equal(result.items.length, 2);
  assert.deepEqual(result.removedTurnIds, []);
});

test("server hydration can patch an interrupted local turn", () => {
  const { items } = localTurn({
    status: TURN_STATUSES.interrupted,
    reconnectState: "offer",
  });
  const merged = mergeServerHistoryIntoTurns(
    [
      { chatId: 42, role: "user", content: "用户问题", sentAt: 100 },
      { chatId: 42, role: "assistant", content: "落库成功回答", sentAt: 100 },
    ],
    items,
    { chatKey: "workspace:thread" }
  );

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((item) => `${item.chatId}:${item.role}:${item.turnId}`),
    ["42:user:turn:local", "42:assistant:turn:local"]
  );
  assert.equal(merged[1].status, TURN_STATUSES.completed);
  assert.equal(merged[1].finalContent, "落库成功回答");
});
