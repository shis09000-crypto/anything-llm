import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultWorkspacePath,
  findOverviewThread,
  isOverviewThread,
} from "./workspaceThreads.js";

test("default workspace path does not route to overview thread", () => {
  const threads = [
    { slug: "overview-thread", thread_type: "overview" },
    { slug: "chat-thread", thread_type: "chat" },
  ];

  assert.equal(
    defaultWorkspacePath("workspace-a", threads),
    "/workspace/workspace-a"
  );
});

test("overview helpers still identify explicit overview threads", () => {
  const overview = { slug: "overview-thread", thread_type: "overview" };
  const chat = { slug: "chat-thread", thread_type: "chat" };

  assert.equal(isOverviewThread(overview), true);
  assert.equal(isOverviewThread(chat), false);
  assert.equal(findOverviewThread([chat, overview]), overview);
});
