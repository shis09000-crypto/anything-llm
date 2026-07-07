import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_SECONDARY_PRELOAD_EVENT,
  chatSecondaryTask,
  dispatchChatSecondaryPreload,
} from "./chatSecondaryPreload.js";

test("chat secondary task uses P0 rank3 foreground metadata", () => {
  const task = chatSecondaryTask("account:avatar:after-chat-ready", {
    workspaceSlug: "workspace-a",
    threadSlug: "thread-a",
    surface: "account-avatar",
  });

  assert.equal(task.label, "account:avatar:after-chat-ready");
  assert.equal(task.priority, "P0");
  assert.equal(task.policy, "foreground");
  assert.equal(task.intentRank, 3);
  assert.equal(task.resource, "network");
  assert.equal(task.scope.route, "workspace-chat");
  assert.equal(task.scope.surface, "account-avatar");
  assert.equal(task.scope.workspaceSlug, "workspace-a");
  assert.equal(task.scope.threadSlug, "thread-a");
});

test("dispatchChatSecondaryPreload emits the shared ready event", () => {
  const originalWindow = globalThis.window;
  const originalPerformance = globalThis.performance;
  const originalCustomEvent = globalThis.CustomEvent;
  const marks = [];
  let dispatched = null;

  globalThis.CustomEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  globalThis.performance = {
    mark: (name) => marks.push(name),
  };
  globalThis.window = {
    dispatchEvent: (event) => {
      dispatched = event;
    },
  };

  try {
    dispatchChatSecondaryPreload({
      workspaceSlug: "workspace-a",
      threadSlug: "thread-a",
    });

    assert.equal(dispatched.type, CHAT_SECONDARY_PRELOAD_EVENT);
    assert.equal(dispatched.detail.workspaceSlug, "workspace-a");
    assert.equal(dispatched.detail.threadSlug, "thread-a");
    assert.deepEqual(marks, ["athena:chat_secondary_preload_started"]);
  } finally {
    globalThis.window = originalWindow;
    globalThis.performance = originalPerformance;
    globalThis.CustomEvent = originalCustomEvent;
  }
});
