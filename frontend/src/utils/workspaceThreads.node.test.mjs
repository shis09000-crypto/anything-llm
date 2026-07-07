import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultWorkspacePath,
  findOverviewThread,
  isOverviewThread,
  resolveWorkspaceEntryPath,
} from "./workspaceThreads.js";

test("default workspace path uses latest non-overview thread", () => {
  const threads = [
    { slug: "overview-thread", thread_type: "overview", lastChatAt: 10 },
    { slug: "older-chat-thread", thread_type: "chat", lastChatAt: 20 },
    { slug: "latest-chat-thread", thread_type: "chat", lastChatAt: 30 },
  ];

  assert.equal(
    defaultWorkspacePath("workspace-a", threads),
    "/workspace/workspace-a/t/latest-chat-thread"
  );
});

test("default workspace path falls back to overview thread", () => {
  const threads = [{ slug: "overview-thread", thread_type: "overview" }];

  assert.equal(
    defaultWorkspacePath("workspace-a", threads),
    "/workspace/workspace-a/t/overview-thread"
  );
});

test("default workspace path keeps root when no threads exist", () => {
  assert.equal(
    defaultWorkspacePath("workspace-a", []),
    "/workspace/workspace-a"
  );
});

test("workspace entry path prefers a valid last visited thread", () => {
  const threads = [
    { slug: "latest-chat-thread", thread_type: "chat", lastChatAt: 30 },
    { slug: "last-visited-thread", thread_type: "chat", lastChatAt: 10 },
  ];

  assert.equal(
    resolveWorkspaceEntryPath("workspace-a", threads, "last-visited-thread"),
    "/workspace/workspace-a/t/last-visited-thread"
  );
});

test("workspace entry path ignores an invalid last visited thread", () => {
  const threads = [
    { slug: "latest-chat-thread", thread_type: "chat", lastChatAt: 30 },
  ];

  assert.equal(
    resolveWorkspaceEntryPath("workspace-a", threads, "missing-thread"),
    "/workspace/workspace-a/t/latest-chat-thread"
  );
});

test("overview helpers still identify explicit overview threads", () => {
  const overview = { slug: "overview-thread", thread_type: "overview" };
  const chat = { slug: "chat-thread", thread_type: "chat" };

  assert.equal(isOverviewThread(overview), true);
  assert.equal(isOverviewThread(chat), false);
  assert.equal(findOverviewThread([chat, overview]), overview);
});
