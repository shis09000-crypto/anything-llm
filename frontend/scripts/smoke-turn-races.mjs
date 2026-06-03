/* global URL, console */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  TURN_STATUSES,
  appendTimelineEventToItems,
  cleanupTransientDraftItems,
  createTurn,
  findAssistantTurn,
  isAgentReconnectAttemptStale,
  mergeServerHistoryIntoTurns,
  updateAssistantTurnInItems,
} from "../src/utils/chat/turns.js";

function loadHandleChat() {
  let src = fs.readFileSync(
    new URL("../src/utils/chat/index.js", import.meta.url),
    "utf8"
  );
  src = src.replace(/import\s+(?:[^;]|\n)*?;\n/g, "");
  src = src.replace(
    "export const ABORT_STREAM_EVENT",
    "const ABORT_STREAM_EVENT"
  );
  src = src.replace(
    "export function dispatchThreadRename",
    "function dispatchThreadRename"
  );
  src = src.replace(
    "export default function handleChat",
    "function handleChat"
  );
  src = src.slice(0, src.indexOf("export function getWorkspaceSystemPrompt"));
  src += "\nresult = handleChat;";
  const sandbox = {
    result: null,
    debugChatTurn() {},
    normalizedEventSummary(event) {
      return { normalizedType: event?.type || null };
    },
    rawEventSummary(raw) {
      return { rawType: raw?.type || null };
    },
    window: { dispatchEvent() {} },
    CustomEvent: function CustomEvent() {},
  };
  vm.runInNewContext(src, sandbox);
  return sandbox.result;
}

function loadHandleSocketResponse() {
  let src = fs.readFileSync(
    new URL("../src/utils/chat/agent.js", import.meta.url),
    "utf8"
  );
  src = src.replace(/import\s+(?:[^;]|\n)*?;\n/g, "");
  src = src.replace(
    "export const AGENT_SESSION_START",
    "const AGENT_SESSION_START"
  );
  src = src.replace(
    "export const AGENT_SESSION_END",
    "const AGENT_SESSION_END"
  );
  src = src.replace("export function websocketURI", "function websocketURI");
  src = src.replace(
    "export default function handleSocketResponse",
    "function handleSocketResponse"
  );
  src = src.replace("import.meta.env.VITE_API_BASE", '"http://localhost:3001"');
  src = src.slice(0, src.indexOf("let _agentSessionActive"));
  src += "\nresult = handleSocketResponse;";
  const sandbox = {
    API_BASE: "/api",
    result: null,
    debugChatTurn() {},
    normalizedEventSummary(event) {
      return { normalizedType: event?.type || null };
    },
    rawEventSummary(raw) {
      return { rawType: raw?.type || null };
    },
    safeJsonParse: (value, fallback) => {
      try {
        return JSON.parse(value);
      } catch {
        return fallback;
      }
    },
    window: {
      location: { protocol: "http:", host: "localhost:3000" },
      dispatchEvent() {},
    },
    CustomEvent: function CustomEvent() {},
  };
  vm.runInNewContext(src, sandbox);
  return sandbox.result;
}

function completeTurn(draft, turnId, patch = {}) {
  const turn = findAssistantTurn(draft.items, turnId);
  assert.ok(turn, "target turn should exist before completion");
  return {
    ...draft,
    items: updateAssistantTurnInItems(draft.items, turnId, {
      ...patch,
      finalContent: patch.finalContent ?? turn.finalContent,
      status: TURN_STATUSES.completed,
      error: null,
    }),
    activeTurnId: draft.activeTurnId === turnId ? null : draft.activeTurnId,
    isStreaming: false,
    isAgentRunning: false,
    activeToolCall: null,
    pendingApproval: null,
  };
}

function completeTurnWithPendingDelta(
  draft,
  turnId,
  patch = {},
  pendingDelta = null
) {
  const turn = findAssistantTurn(draft.items, turnId);
  assert.ok(turn, "target turn should exist before completion");
  const patchHasFinalContent =
    (typeof patch.finalContent === "string" && patch.finalContent.length > 0) ||
    (typeof patch.content === "string" && patch.content.length > 0);
  const finalPatch =
    pendingDelta?.content && !patchHasFinalContent
      ? {
          ...patch,
          finalContent: `${turn.finalContent || ""}${pendingDelta.content}`,
          sources:
            pendingDelta.sources?.length > 0
              ? pendingDelta.sources
              : patch.sources,
          metrics: pendingDelta.metrics || patch.metrics,
          chatId: pendingDelta.chatId || patch.chatId,
        }
      : patch;

  return completeTurn(draft, turnId, {
    ...finalPatch,
    finalContent:
      finalPatch.finalContent !== undefined
        ? finalPatch.finalContent
        : finalPatch.content !== undefined && finalPatch.content !== ""
          ? finalPatch.content
          : turn.finalContent || "",
    sources: finalPatch.sources || turn.sources || [],
    metrics: finalPatch.metrics || turn.metrics || {},
    chatId: finalPatch.chatId || turn.chatId || null,
  });
}

function failTurn(draft, turnId, reason = "failed") {
  return {
    ...draft,
    items: updateAssistantTurnInItems(draft.items, turnId, {
      status: TURN_STATUSES.failed,
      error: reason,
    }),
    activeTurnId: draft.activeTurnId === turnId ? null : draft.activeTurnId,
    isStreaming: false,
    isAgentRunning: false,
    activeToolCall: null,
    pendingApproval: null,
  };
}

function applyDeltaIfRunning(draft, turnId, content) {
  const turn = findAssistantTurn(draft.items, turnId);
  if (!turn || turn.status !== TURN_STATUSES.running) return draft;
  return {
    ...draft,
    items: updateAssistantTurnInItems(draft.items, turnId, {
      status: TURN_STATUSES.running,
      finalContent: `${turn.finalContent || ""}${content || ""}`,
    }),
    activeTurnId: turnId,
    isStreaming: true,
  };
}

function normalizeRunningState(stored = {}) {
  const threadActivityByKey = {};
  Object.entries(stored.threadActivityByKey || {}).forEach(
    ([chatKey, activity]) => {
      if (activity?.status === TURN_STATUSES.running) {
        threadActivityByKey[chatKey] = activity;
      }
    }
  );

  return {
    activeRunningThread:
      stored.activeRunningThread?.status === TURN_STATUSES.running
        ? stored.activeRunningThread
        : null,
    threadActivityByKey,
  };
}

function markRunning(state, chatKey, turnId) {
  const activity = {
    workspaceSlug: "ws",
    threadSlug: null,
    chatKey,
    turnId,
    status: TURN_STATUSES.running,
    updatedAt: Date.now(),
  };
  return normalizeRunningState({
    activeRunningThread: activity,
    threadActivityByKey: {
      ...(state.threadActivityByKey || {}),
      [chatKey]: activity,
    },
  });
}

function markSettled(state, chatKey, turnId) {
  const threadActivityByKey = { ...(state.threadActivityByKey || {}) };
  delete threadActivityByKey[chatKey];
  return normalizeRunningState({
    activeRunningThread:
      state.activeRunningThread?.chatKey === chatKey &&
      state.activeRunningThread?.turnId === turnId
        ? null
        : state.activeRunningThread,
    threadActivityByKey,
  });
}

function hasWorkspaceActivity(state, workspaceSlug) {
  return Object.values(state.threadActivityByKey || {}).some(
    (activity) =>
      activity.workspaceSlug === workspaceSlug &&
      activity.status === TURN_STATUSES.running
  );
}

function getRunningThread(state, workspaceSlug) {
  return (
    Object.values(state.threadActivityByKey || {}).find(
      (activity) =>
        activity.workspaceSlug === workspaceSlug &&
        activity.status === TURN_STATUSES.running
    ) || null
  );
}

function hasThreadActivity(state, chatKey) {
  const activity = state.threadActivityByKey?.[chatKey];
  return activity?.status === TURN_STATUSES.running ? activity : null;
}

const handleChat = loadHandleChat();
const handleSocketResponse = loadHandleSocketResponse();
const closedChunk = handleChat({
  type: "textResponseChunk",
  textResponse: "done",
  close: true,
  uuid: "u1",
});
assert.equal(closedChunk.type, "assistant_final");
assert.equal(closedChunk.content, "done");

function socketMessage(payload) {
  return handleSocketResponse({}, { data: JSON.stringify(payload) });
}

const closedSocketChunk = socketMessage({
  type: "reportStreamEvent",
  content: {
    type: "textResponseChunk",
    uuid: "ws-close",
    content: "done",
    close: true,
    chatId: 11,
    sources: [{ title: "source" }],
    metrics: { total_tokens: 3 },
  },
});
assert.equal(closedSocketChunk.type, "assistant_final");
assert.equal(closedSocketChunk.content, "done");
assert.equal(closedSocketChunk.chatId, 11);
assert.equal(closedSocketChunk.closed, true);
assert.deepEqual(closedSocketChunk.sources, [{ title: "source" }]);
assert.deepEqual(closedSocketChunk.metrics, { total_tokens: 3 });

const fullTextResponse = socketMessage({
  type: "reportStreamEvent",
  content: {
    type: "fullTextResponse",
    uuid: "ws-final",
    content: "final",
    chatId: 12,
  },
});
assert.equal(fullTextResponse.type, "assistant_final");
assert.equal(fullTextResponse.content, "final");
assert.equal(fullTextResponse.chatId, 12);

const reportChatId = socketMessage({
  type: "reportStreamEvent",
  content: { type: "chatId", uuid: "ws-chat", chatId: 13 },
});
assert.equal(reportChatId.type, "assistant_final");
assert.equal(reportChatId.chatId, 13);

const topLevelChatId = socketMessage({
  type: "chatId",
  content: { uuid: "top-chat", chatId: 14 },
});
assert.equal(topLevelChatId.type, "assistant_final");
assert.equal(topLevelChatId.chatId, 14);

const wssFailure = socketMessage({
  type: "wssFailure",
  content: "socket failed",
});
assert.equal(wssFailure.type, "assistant_error");
assert.equal(wssFailure.error, "socket failed");

const first = createTurn({ prompt: "first", chatKey: "ws:default" });
let draft = {
  items: first.items,
  activeTurnId: first.turnId,
  isStreaming: true,
  isAgentRunning: false,
};
draft = completeTurn(draft, first.turnId, {
  finalContent: closedChunk.content,
});
const completed = findAssistantTurn(draft.items, first.turnId);
assert.equal(completed.status, TURN_STATUSES.completed);
assert.equal(completed.finalContent, "done");
assert.equal(draft.activeTurnId, null);
assert.equal(draft.isStreaming, false);

const emptyClosedChunk = handleChat({
  type: "textResponseChunk",
  textResponse: "",
  close: true,
  uuid: "u-empty",
});
assert.equal(emptyClosedChunk.type, "assistant_final");
assert.equal(emptyClosedChunk.content, "");

const pendingRaceTurn = createTurn({
  prompt: "pending race",
  chatKey: "ws:default",
});
let pendingRaceDraft = {
  items: pendingRaceTurn.items,
  activeTurnId: pendingRaceTurn.turnId,
  isStreaming: true,
  isAgentRunning: false,
};
pendingRaceDraft = completeTurnWithPendingDelta(
  pendingRaceDraft,
  pendingRaceTurn.turnId,
  {
    finalContent: emptyClosedChunk.content,
    chatId: 202,
    sources: [{ title: "final" }],
    metrics: { total_tokens: 1 },
  },
  {
    content: "ok",
    chatId: 202,
    sources: [{ title: "pending" }],
    metrics: { total_tokens: 2 },
  }
);
const pendingRaceCompleted = findAssistantTurn(
  pendingRaceDraft.items,
  pendingRaceTurn.turnId
);
assert.equal(pendingRaceCompleted.status, TURN_STATUSES.completed);
assert.equal(pendingRaceCompleted.finalContent, "ok");
assert.equal(pendingRaceCompleted.chatId, 202);
assert.deepEqual(pendingRaceCompleted.sources, [{ title: "pending" }]);
assert.deepEqual(pendingRaceCompleted.metrics, { total_tokens: 2 });

const overridingTurn = createTurn({
  prompt: "override",
  chatKey: "ws:default",
});
let overridingDraft = {
  items: overridingTurn.items,
  activeTurnId: overridingTurn.turnId,
  isStreaming: true,
  isAgentRunning: false,
};
overridingDraft = completeTurnWithPendingDelta(
  overridingDraft,
  overridingTurn.turnId,
  { finalContent: "server final" },
  { content: "pending should not duplicate" }
);
assert.equal(
  findAssistantTurn(overridingDraft.items, overridingTurn.turnId).finalContent,
  "server final"
);

const beforeLateDelta = completed.finalContent;
draft = applyDeltaIfRunning(draft, first.turnId, " late");
assert.equal(findAssistantTurn(draft.items, first.turnId).status, "completed");
assert.equal(
  findAssistantTurn(draft.items, first.turnId).finalContent,
  beforeLateDelta
);

const failedTurn = createTurn({ prompt: "fail", chatKey: "ws:default" });
let failedDraft = {
  items: failedTurn.items,
  activeTurnId: failedTurn.turnId,
  isStreaming: false,
  isAgentRunning: true,
};
failedDraft = failTurn(
  failedDraft,
  failedTurn.turnId,
  "Agent websocket closed before a final response."
);
assert.equal(
  findAssistantTurn(failedDraft.items, failedTurn.turnId).status,
  TURN_STATUSES.failed
);
assert.equal(failedDraft.activeTurnId, null);
assert.equal(failedDraft.isAgentRunning, false);

const oldTurn = createTurn({ prompt: "old", chatKey: "ws:default" });
const newTurn = createTurn({ prompt: "new", chatKey: "ws:default" });
let lateDraft = {
  items: [...oldTurn.items, ...newTurn.items],
  activeTurnId: newTurn.turnId,
};
lateDraft.items = appendTimelineEventToItems(lateDraft.items, oldTurn.turnId, {
  type: "thought",
  content: "late event from old socket",
});
assert.deepEqual(
  findAssistantTurn(lateDraft.items, oldTurn.turnId).timeline.map(
    (event) => event.content
  ),
  ["late event from old socket"]
);
assert.deepEqual(
  findAssistantTurn(lateDraft.items, newTurn.turnId).timeline,
  []
);

const persistedTurn = createTurn({
  prompt: "persisted",
  chatKey: "ws:default",
  chatId: 101,
});
let persistedDraft = completeTurn(
  {
    items: persistedTurn.items,
    activeTurnId: persistedTurn.turnId,
    isStreaming: true,
    isAgentRunning: false,
  },
  persistedTurn.turnId,
  { finalContent: "local", chatId: 101 }
);
persistedDraft = {
  ...persistedDraft,
  items: mergeServerHistoryIntoTurns(
    [
      { role: "user", chatId: 101, content: "persisted", sentAt: 1 },
      { role: "assistant", chatId: 101, content: "server", sentAt: 2 },
    ],
    persistedDraft.items,
    { chatKey: "ws:default" }
  ),
};
assert.equal(
  findAssistantTurn(persistedDraft.items, persistedTurn.turnId).status,
  TURN_STATUSES.completed
);
assert.equal(persistedDraft.activeTurnId, null);
assert.equal(persistedDraft.isStreaming, false);

const failedLocalOverrideTurn = createTurn({
  prompt: "server should win failed local",
  chatKey: "ws:default",
});
let failedLocalOverrideItems = updateAssistantTurnInItems(
  failedLocalOverrideTurn.items,
  failedLocalOverrideTurn.turnId,
  {
    status: TURN_STATUSES.failed,
    error: "local failure",
  }
);
failedLocalOverrideItems = mergeServerHistoryIntoTurns(
  [
    {
      role: "user",
      chatId: 303,
      content: "server should win failed local",
      sentAt: 1,
    },
    {
      role: "assistant",
      chatId: 303,
      content: "server completed",
      sentAt: 2,
    },
  ],
  failedLocalOverrideItems,
  { chatKey: "ws:default" }
);
const failedLocalOverrideAssistant = findAssistantTurn(
  failedLocalOverrideItems,
  failedLocalOverrideTurn.turnId
);
assert.equal(failedLocalOverrideAssistant.status, TURN_STATUSES.completed);
assert.equal(failedLocalOverrideAssistant.error, null);
assert.equal(failedLocalOverrideAssistant.finalContent, "server completed");

const localFailedCleanupTurn = createTurn({
  prompt: "failed local cleanup",
  chatKey: "ws:default",
});
const failedCleanup = cleanupTransientDraftItems(
  updateAssistantTurnInItems(
    localFailedCleanupTurn.items,
    localFailedCleanupTurn.turnId,
    {
      status: TURN_STATUSES.failed,
      error: "local failure",
    }
  )
);
assert.deepEqual(failedCleanup.items, []);
assert.deepEqual(failedCleanup.removedTurnIds, [localFailedCleanupTurn.turnId]);

const localRunningCleanupTurn = createTurn({
  prompt: "running local cleanup",
  chatKey: "ws:default",
});
const runningCleanup = cleanupTransientDraftItems(localRunningCleanupTurn.items);
assert.deepEqual(runningCleanup.items, []);
assert.deepEqual(runningCleanup.removedTurnIds, [localRunningCleanupTurn.turnId]);

const now = Date.now();
const retryingRoughTurn = createTurn({
  prompt: "retrying rough",
  chatKey: "ws:default",
});
const retryingRoughItems = updateAssistantTurnInItems(
  retryingRoughTurn.items,
  retryingRoughTurn.turnId,
  {
    reconnectState: "retrying",
    websocketUUID: "agent-rough",
    agentModelTier: "rough",
    silenceTimeoutMs: 50_000,
    reconnectAttemptStartedAt: now - 90_000,
  }
);
assert.equal(
  cleanupTransientDraftItems(retryingRoughItems, { now }).items.length,
  2
);
assert.equal(
  isAgentReconnectAttemptStale(
    findAssistantTurn(retryingRoughItems, retryingRoughTurn.turnId),
    now
  ),
  false
);

const staleRetryingRoughItems = updateAssistantTurnInItems(
  retryingRoughTurn.items,
  retryingRoughTurn.turnId,
  {
    reconnectState: "retrying",
    websocketUUID: "agent-rough",
    agentModelTier: "rough",
    silenceTimeoutMs: 50_000,
    reconnectAttemptStartedAt: now - 101_000,
  }
);
assert.deepEqual(
  cleanupTransientDraftItems(staleRetryingRoughItems, { now }).items,
  []
);
assert.equal(
  isAgentReconnectAttemptStale(
    findAssistantTurn(staleRetryingRoughItems, retryingRoughTurn.turnId),
    now
  ),
  true
);

for (const [tier, timeoutMs] of [
  ["refined", 90_000],
  ["ultra", 120_000],
]) {
  const tierTurn = createTurn({
    prompt: `${tier} retrying`,
    chatKey: "ws:default",
  });
  const tierItems = updateAssistantTurnInItems(tierTurn.items, tierTurn.turnId, {
    reconnectState: "retrying",
    websocketUUID: `agent-${tier}`,
    agentModelTier: tier,
    silenceTimeoutMs: timeoutMs,
    reconnectAttemptStartedAt: now - (timeoutMs * 2 + 1),
  });
  assert.deepEqual(cleanupTransientDraftItems(tierItems, { now }).items, []);
}

const unknownTierTurn = createTurn({
  prompt: "unknown tier retrying",
  chatKey: "ws:default",
});
const unknownTierItems = updateAssistantTurnInItems(
  unknownTierTurn.items,
  unknownTierTurn.turnId,
  {
    reconnectState: "retrying",
    websocketUUID: "agent-unknown",
    reconnectAttemptStartedAt: now - 179_000,
  }
);
assert.equal(cleanupTransientDraftItems(unknownTierItems, { now }).items.length, 2);
const staleUnknownTierItems = updateAssistantTurnInItems(
  unknownTierTurn.items,
  unknownTierTurn.turnId,
  {
    reconnectState: "retrying",
    websocketUUID: "agent-unknown",
    reconnectAttemptStartedAt: now - 181_000,
  }
);
assert.deepEqual(
  cleanupTransientDraftItems(staleUnknownTierItems, { now }).items,
  []
);

const offerTurn = createTurn({
  prompt: "offer should stay",
  chatKey: "ws:default",
});
const offerItems = updateAssistantTurnInItems(offerTurn.items, offerTurn.turnId, {
  status: TURN_STATUSES.interrupted,
  reconnectState: "offer",
});
assert.equal(cleanupTransientDraftItems(offerItems, { now }).items.length, 2);

const chatKey = "ws:default";
let runningState = { activeRunningThread: null, threadActivityByKey: {} };
runningState = markRunning(runningState, chatKey, "turn-running");
assert.equal(hasWorkspaceActivity(runningState, "ws"), true);
assert.equal(getRunningThread(runningState, "ws")?.turnId, "turn-running");
assert.equal(hasThreadActivity(runningState, chatKey)?.turnId, "turn-running");
runningState = markSettled(runningState, chatKey, "turn-running");
assert.equal(hasWorkspaceActivity(runningState, "ws"), false);
assert.equal(getRunningThread(runningState, "ws"), null);
assert.equal(hasThreadActivity(runningState, chatKey), null);
assert.deepEqual(runningState.threadActivityByKey, {});
assert.equal(runningState.activeRunningThread, null);

const settledState = normalizeRunningState({
  activeRunningThread: {
    workspaceSlug: "ws",
    chatKey,
    turnId: "turn-complete",
    status: TURN_STATUSES.completed,
  },
  threadActivityByKey: {
    [chatKey]: {
      workspaceSlug: "ws",
      chatKey,
      turnId: "turn-complete",
      status: TURN_STATUSES.completed,
    },
    "ws:failed": {
      workspaceSlug: "ws",
      chatKey: "ws:failed",
      turnId: "turn-failed",
      status: TURN_STATUSES.failed,
    },
  },
});
assert.equal(settledState.activeRunningThread, null);
assert.deepEqual(settledState.threadActivityByKey, {});
assert.equal(hasWorkspaceActivity(settledState, "ws"), false);
assert.equal(getRunningThread(settledState, "ws"), null);
assert.equal(hasThreadActivity(settledState, chatKey), null);

for (const file of [
  "../src/models/workspace.js",
  "../src/models/workspaceThread.js",
]) {
  const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const adds = [...src.matchAll(/addEventListener\(ABORT_STREAM_EVENT/g)]
    .length;
  const removes = [...src.matchAll(/removeEventListener\(ABORT_STREAM_EVENT/g)]
    .length;
  assert.equal(adds, removes, `${file} abort listener add/remove mismatch`);
}

console.log("turn race smoke passed");
