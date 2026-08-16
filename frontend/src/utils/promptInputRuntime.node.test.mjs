import assert from "node:assert/strict";
import test from "node:test";
import {
  appendPromptUndoSnapshot,
  promptSnapshotsEqual,
} from "./promptInputRuntime.js";

const snapshot = (value, cursor = value.length) => ({
  value,
  cursorPositionStart: cursor,
  cursorPositionEnd: cursor,
});

test("prompt snapshot equality includes value and cursor", () => {
  assert.equal(promptSnapshotsEqual(snapshot("你好"), snapshot("你好")), true);
  assert.equal(
    promptSnapshotsEqual(snapshot("你好", 1), snapshot("你好")),
    false
  );
  assert.equal(promptSnapshotsEqual(snapshot("你好"), snapshot("您好")), false);
});
test("undo snapshots are deduplicated and bounded", () => {
  const stack = [];
  assert.equal(appendPromptUndoSnapshot(stack, snapshot("a"), 2), true);
  assert.equal(appendPromptUndoSnapshot(stack, snapshot("a"), 2), false);
  assert.equal(appendPromptUndoSnapshot(stack, snapshot("ab"), 2), true);
  assert.equal(appendPromptUndoSnapshot(stack, snapshot("abc"), 2), true);
  assert.deepEqual(
    stack.map((item) => item.value),
    ["ab", "abc"]
  );
});
