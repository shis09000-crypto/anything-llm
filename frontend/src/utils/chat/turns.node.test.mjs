import test from "node:test";
import assert from "node:assert/strict";
import {
  TURN_STATUSES,
  cleanupTransientDraftItems,
  hasMeaningfulTransientAssistantOutput,
  mergeServerHistoryIntoTurns,
  pruneServerBackedTurnsOutsideHistory,
  pruneSupersededUnpersistedTurns,
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

test("cleanup retains an empty failed turn and its user prompt by default", () => {
  const { items } = localTurn({ status: TURN_STATUSES.failed });
  const result = cleanupTransientDraftItems(items, { removeRunning: false });

  assert.equal(result.items.length, 2);
  assert.deepEqual(result.removedTurnIds, []);
});

test("explicit failed-turn cleanup removes the assistant and local user", () => {
  const { items } = localTurn({ status: TURN_STATUSES.failed });
  const result = cleanupTransientDraftItems(items, {
    removeRunning: false,
    removeFailed: true,
  });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.removedTurnIds, ["turn:local"]);
  assert.equal(result.removedTurns[0].status, TURN_STATUSES.failed);
});

test("explicit failed-turn cleanup also removes partial output", () => {
  const { items } = localTurn({
    status: TURN_STATUSES.failed,
    finalContent: "模型已经输出，但持久化失败",
    timeline: [
      {
        type: "error",
        content: "permission denied for table workspace_chats",
      },
    ],
  });
  const result = cleanupTransientDraftItems(items, {
    removeRunning: false,
    removeFailed: true,
  });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.removedTurnIds, ["turn:local"]);
  assert.equal(result.removedTurns[0].hasMeaningfulOutput, true);
});

test("explicit interrupted-turn cleanup removes an empty reconnect offer", () => {
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
  const result = cleanupTransientDraftItems(items, {
    removeRunning: false,
    removeInterrupted: true,
  });

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

test("cleanup removes a restored running turn after the storage grace window even with output", () => {
  const { items } = localTurn({
    status: TURN_STATUSES.running,
    finalContent: "已经显示但没有落库的旧回答",
  });
  items[1].updatedAt = 1_000;
  const result = cleanupTransientDraftItems(items, {
    now: 700_001,
    runningMaxAgeMs: 600_000,
  });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.removedTurnIds, ["turn:local"]);
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

test("server hydration preserves the model used by that historical turn", () => {
  const merged = mergeServerHistoryIntoTurns(
    [
      { chatId: 47, role: "user", content: "你好", sentAt: 100 },
      {
        chatId: 47,
        role: "assistant",
        content: "你好",
        sentAt: 100,
        execution: {
          model: "deepseek-v4-flash",
          provider: "deepseek",
          requestedProtocol: "responses",
          effectiveProtocol: "responses",
          responseId: "ath_resp_47",
          source: "responses_runtime",
        },
      },
    ],
    [],
    { chatKey: "workspace:thread" }
  );

  const assistant = merged.find((item) => item.type === "assistant_turn");
  assert.equal(assistant.execution.model, "deepseek-v4-flash");
  assert.equal(assistant.execution.responseId, "ath_resp_47");
});

test("completed server hydration removes transient Agent reconnect thoughts", () => {
  const { items } = localTurn({
    status: TURN_STATUSES.running,
    timeline: [
      {
        id: "agent-reconnect:invocation",
        type: "thought",
        content: "Agent connection interrupted. Reconnecting 1/5...",
      },
      {
        id: "tool-result:market",
        type: "tool_result",
        toolName: "crypto_market_snapshot",
        content: "complete",
      },
    ],
  });
  const merged = mergeServerHistoryIntoTurns(
    [
      { chatId: 45, role: "user", content: "用户问题", sentAt: 100 },
      { chatId: 45, role: "assistant", content: "完整回答", sentAt: 100 },
    ],
    items,
    { chatKey: "workspace:thread" }
  );

  const assistant = merged.find((item) => item.type === "assistant_turn");
  assert.equal(assistant.status, TURN_STATUSES.completed);
  assert.equal(
    assistant.timeline.some((event) =>
      String(event.content || "").startsWith(
        "Agent connection interrupted. Reconnecting"
      )
    ),
    false
  );
  assert.equal(
    assistant.timeline.some((event) => event.type === "tool_result"),
    true
  );
});

test("server hydration preserves an active agent turn during handoff", () => {
  const { items } = localTurn({
    status: TURN_STATUSES.running,
    finalContent: "",
  });
  items[0].clientTurnId = "turn:local";
  items[1].clientTurnId = "turn:local";
  items[1].websocketUUID = "agent-invocation";

  const merged = mergeServerHistoryIntoTurns(
    [
      {
        chatId: 43,
        role: "user",
        content: "用户问题",
        clientTurnId: "turn:local",
        sentAt: 100,
      },
      {
        chatId: 43,
        role: "assistant",
        content: "@agent: Swapping over to agent chat.",
        clientTurnId: "turn:local",
        sentAt: 100,
      },
    ],
    items,
    { chatKey: "workspace:thread" }
  );

  const assistant = merged.find((item) => item.type === "assistant_turn");
  assert.equal(assistant.chatId, 43);
  assert.equal(assistant.status, TURN_STATUSES.running);
  assert.equal(assistant.finalContent, "");
  assert.equal(assistant.websocketUUID, "agent-invocation");
});

test("server hydration revives a raced agent handoff while its session is active", () => {
  const { items } = localTurn({
    status: TURN_STATUSES.completed,
    finalContent: "@agent: Swapping over to agent chat.",
  });
  items[0].clientTurnId = "turn:local";
  items[1].clientTurnId = "turn:local";

  const merged = mergeServerHistoryIntoTurns(
    [
      {
        chatId: 44,
        role: "user",
        content: "用户问题",
        clientTurnId: "turn:local",
        sentAt: 100,
      },
      {
        chatId: 44,
        role: "assistant",
        content: "@agent: Swapping over to agent chat.",
        clientTurnId: "turn:local",
        sentAt: 100,
      },
    ],
    items,
    {
      chatKey: "workspace:thread",
      preserveRunningTurnIds: ["turn:local"],
    }
  );

  const assistant = merged.find((item) => item.type === "assistant_turn");
  assert.equal(assistant.chatId, 44);
  assert.equal(assistant.status, TURN_STATUSES.running);
  assert.equal(assistant.finalContent, "@agent: Swapping over to agent chat.");
});

test("server-only agent handoff history remains running", () => {
  const merged = mergeServerHistoryIntoTurns(
    [
      {
        chatId: 45,
        role: "user",
        content: "用户问题",
        clientTurnId: "turn:server",
        sentAt: 100,
      },
      {
        chatId: 45,
        role: "assistant",
        content: "@agent: Swapping over to agent chat.",
        clientTurnId: "turn:server",
        sentAt: 100,
      },
    ],
    [],
    { chatKey: "workspace:thread" }
  );

  const assistant = merged.find((item) => item.type === "assistant_turn");
  assert.equal(assistant.status, TURN_STATUSES.running);
});

test("server hydration does not patch a repeated prompt from stale history", () => {
  const { items } = localTurn({ status: TURN_STATUSES.running });
  const currentUserCreatedAt = Date.parse("2026-06-26T14:40:47.496Z");
  items[0].createdAt = currentUserCreatedAt;
  items[1].createdAt = currentUserCreatedAt + 1;

  const merged = mergeServerHistoryIntoTurns(
    [
      {
        chatId: 42,
        role: "user",
        content: "用户问题",
        sentAt: Date.parse("2026-06-26T13:10:40.000Z") / 1000,
      },
      {
        chatId: 42,
        role: "assistant",
        content: "上一轮回答",
        sentAt: Date.parse("2026-06-26T13:10:40.000Z") / 1000,
      },
    ],
    items,
    { chatKey: "workspace:thread" }
  );

  const localAssistant = merged.find(
    (item) => item.type === "assistant_turn" && item.turnId === "turn:local"
  );
  const staleAssistant = merged.find(
    (item) => item.type === "assistant_turn" && item.chatId === 42
  );

  assert.equal(localAssistant.chatId || null, null);
  assert.equal(localAssistant.status, TURN_STATUSES.running);
  assert.equal(staleAssistant.turnId, "server:42");
  assert.equal(staleAssistant.finalContent, "上一轮回答");
});

test("server hydration requires a server timestamp before patching by content", () => {
  const { items } = localTurn({ status: TURN_STATUSES.running });
  const currentUserCreatedAt = Date.parse("2026-06-26T14:40:47.496Z");
  items[0].createdAt = currentUserCreatedAt;
  items[1].createdAt = currentUserCreatedAt + 1;

  const merged = mergeServerHistoryIntoTurns(
    [
      {
        chatId: 42,
        role: "user",
        content: "用户问题",
      },
      {
        chatId: 42,
        role: "assistant",
        content: "没有 sentAt 的回答",
      },
    ],
    items,
    { chatKey: "workspace:thread" }
  );

  const localAssistant = merged.find(
    (item) => item.type === "assistant_turn" && item.turnId === "turn:local"
  );
  const serverAssistant = merged.find(
    (item) => item.type === "assistant_turn" && item.chatId === 42
  );

  assert.equal(localAssistant.chatId || null, null);
  assert.equal(localAssistant.status, TURN_STATUSES.running);
  assert.equal(serverAssistant.turnId, "server:42");
});

test("server hydration removes an older unpersisted orphan after newer authoritative history", () => {
  const orphan = localTurn({
    turnId: "turn:orphan-agent",
    status: TURN_STATUSES.running,
    finalContent: "旧 Agent 已显示的回答",
  });
  const oldAt = Date.parse("2026-08-04T08:59:00.000Z");
  orphan.user.createdAt = oldAt;
  orphan.assistant.createdAt = oldAt + 1;
  orphan.assistant.updatedAt = Date.parse("2026-08-04T14:00:00.000Z");
  orphan.assistant.websocketUUID = "completed-agent-websocket";

  const merged = mergeServerHistoryIntoTurns(
    [
      {
        chatId: 2294,
        role: "user",
        content: "哈咯",
        sentAt: Date.parse("2026-08-04T13:18:06.000Z") / 1000,
      },
      {
        chatId: 2294,
        role: "assistant",
        content: "最新权威回答",
        sentAt: Date.parse("2026-08-04T13:18:06.000Z") / 1000,
      },
    ],
    orphan.items,
    { chatKey: "workspace:thread" }
  );

  assert.deepEqual(
    merged.map((item) => item.turnId),
    ["server:2294", "server:2294"]
  );
});

test("superseded orphan cleanup preserves the active Agent turn", () => {
  const active = localTurn({
    turnId: "turn:active-agent",
    status: TURN_STATUSES.running,
    finalContent: "仍在生成",
  });
  active.user.createdAt = 1_000;
  active.assistant.createdAt = 1_001;
  active.assistant.updatedAt = 1_001;

  const pruned = pruneSupersededUnpersistedTurns(
    active.items,
    [
      { chatId: 9, role: "user", sentAt: 10_000 },
      { chatId: 9, role: "assistant", sentAt: 10_000 },
    ],
    { preserveRunningTurnIds: ["turn:active-agent"] }
  );

  assert.equal(pruned.length, 2);
  assert.equal(pruned[1].turnId, "turn:active-agent");
});

test("server hydration repairs a repeated prompt turn with a stale chat id", () => {
  const { items } = localTurn({ status: TURN_STATUSES.running });
  const currentUserCreatedAt = Date.parse("2026-06-26T14:40:47.496Z");
  items[0].createdAt = currentUserCreatedAt;
  items[0].chatId = 42;
  items[1].createdAt = currentUserCreatedAt + 1;
  items[1].chatId = 42;

  const merged = mergeServerHistoryIntoTurns(
    [
      {
        chatId: 42,
        role: "user",
        content: "用户问题",
        sentAt: Date.parse("2026-06-26T13:10:40.000Z") / 1000,
      },
      {
        chatId: 42,
        role: "assistant",
        content: "上一轮回答",
        sentAt: Date.parse("2026-06-26T13:10:40.000Z") / 1000,
      },
      {
        chatId: 43,
        role: "user",
        content: "用户问题",
        sentAt: Date.parse("2026-06-26T14:40:48.000Z") / 1000,
      },
      {
        chatId: 43,
        role: "assistant",
        content: "当前轮回答",
        sentAt: Date.parse("2026-06-26T14:40:48.000Z") / 1000,
      },
    ],
    items,
    { chatKey: "workspace:thread" }
  );

  const localAssistant = merged.find(
    (item) => item.type === "assistant_turn" && item.turnId === "turn:local"
  );

  assert.equal(localAssistant.chatId, 43);
  assert.equal(localAssistant.status, TURN_STATUSES.completed);
  assert.equal(localAssistant.finalContent, "当前轮回答");
});

test("prune removes completed server-backed turns outside a paged history window", () => {
  const staleUser = {
    id: "server:1886:user",
    type: "user",
    role: "user",
    turnId: "server:1886",
    chatId: 1886,
    content: "old prompt",
    createdAt: 1781703527000,
  };
  const staleAssistant = {
    id: "server:1886:assistant",
    type: "assistant_turn",
    role: "assistant",
    turnId: "server:1886",
    userMessageId: staleUser.id,
    chatId: 1886,
    status: TURN_STATUSES.completed,
    finalContent: "old answer",
    createdAt: 1781703527001,
  };
  const currentUser = {
    id: "server:2060:user",
    type: "user",
    role: "user",
    turnId: "server:2060",
    chatId: 2060,
    content: "current prompt",
    createdAt: 1782493045000,
  };
  const currentAssistant = {
    id: "server:2060:assistant",
    type: "assistant_turn",
    role: "assistant",
    turnId: "server:2060",
    userMessageId: currentUser.id,
    chatId: 2060,
    status: TURN_STATUSES.completed,
    finalContent: "current answer",
    createdAt: 1782493045001,
  };

  const pruned = pruneServerBackedTurnsOutsideHistory(
    [staleUser, staleAssistant, currentUser, currentAssistant],
    [
      { chatId: 2060, role: "user", content: "current prompt" },
      { chatId: 2060, role: "assistant", content: "current answer" },
    ]
  );

  assert.deepEqual(
    pruned.map((item) => item.chatId),
    [2060, 2060]
  );
});

test("prune keeps unfinished and preserved turns outside the history window", () => {
  const running = localTurn({ status: TURN_STATUSES.running });
  running.user.chatId = 1886;
  running.assistant.chatId = 1886;
  const preserved = localTurn({
    turnId: "turn:preserved",
    status: TURN_STATUSES.completed,
    finalContent: "kept",
  });
  preserved.user.chatId = 1887;
  preserved.assistant.chatId = 1887;

  const pruned = pruneServerBackedTurnsOutsideHistory(
    [...running.items, ...preserved.items],
    [{ chatId: 2060, role: "user", content: "current prompt" }],
    { preserveTurnIds: ["turn:preserved"] }
  );

  assert.deepEqual(
    pruned.map((item) => item.turnId),
    ["turn:local", "turn:local", "turn:preserved", "turn:preserved"]
  );
});
