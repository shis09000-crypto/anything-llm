import test from "node:test";
import assert from "node:assert/strict";
import {
  applyChatStreamRevision,
  chatStreamProjectionDelay,
  createChatStreamAccumulator,
} from "./streamAccumulator.js";

test("accumulates every revision without relying on animation frames", () => {
  const accumulator = createChatStreamAccumulator({
    chatKey: "workspace:thread",
    turnId: "turn-1",
  });
  const expected = [];
  for (let index = 1; index <= 500; index += 1) {
    const chunk = `${index},`;
    expected.push(chunk);
    applyChatStreamRevision(accumulator, {
      content: chunk,
      revision: index,
    });
  }
  assert.equal(accumulator.content, expected.join(""));
  assert.equal(accumulator.revision, 500);
});

test("a reconnect snapshot replaces accumulated content and stale snapshots are ignored", () => {
  const accumulator = createChatStreamAccumulator({
    turn: { finalContent: "old" },
  });
  applyChatStreamRevision(accumulator, {
    content: "-delta",
    revision: 4,
  });
  applyChatStreamRevision(
    accumulator,
    { content: "authoritative", revision: 8 },
    { replace: true }
  );
  applyChatStreamRevision(
    accumulator,
    { content: "stale", revision: 7 },
    { replace: true }
  );
  assert.equal(accumulator.content, "authoritative");
  assert.equal(accumulator.revision, 8);
});

test("uses bounded desktop and compact projection intervals", () => {
  assert.equal(chatStreamProjectionDelay({ compact: false }), 50);
  assert.equal(chatStreamProjectionDelay({ compact: true }), 100);
});
