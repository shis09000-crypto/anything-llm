import assert from "node:assert/strict";
import test from "node:test";

import {
  historySyncRetryDelay,
  resolveWorkspaceHistorySyncChatKey,
} from "./workspaceHistorySync.js";

test("cross-device history refresh always resolves the active chat key", () => {
  assert.equal(
    resolveWorkspaceHistorySyncChatKey({
      workspaceSlug: "workspace-a",
      threadSlug: "thread-a",
      getChatKey: (workspaceSlug, threadSlug) =>
        `${workspaceSlug}:${threadSlug || "default"}`,
    }),
    "workspace-a:thread-a"
  );
});

test("cross-device history refresh uses bounded automatic retries", () => {
  assert.equal(historySyncRetryDelay(0), 1_000);
  assert.equal(historySyncRetryDelay(1), 3_000);
  assert.equal(historySyncRetryDelay(2), 8_000);
  assert.equal(historySyncRetryDelay(3), null);
});
