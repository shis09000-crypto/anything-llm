import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchPersistedChatHydration,
  persistedHydratedChatHistory,
} from "./persistedTurn.js";

test("thread persisted confirmation hydrates only the completed chat", async () => {
  const calls = [];
  const workspaceModel = {
    threads: {
      chatHistoryHydration: async (workspaceSlug, threadSlug, chatIds) => {
        calls.push({
          type: "thread-hydrate",
          workspaceSlug,
          threadSlug,
          chatIds,
        });
        return { history: [], hydratedChatIds: chatIds };
      },
      chatHistory: async () => {
        calls.push({ type: "thread-full-history" });
        return [];
      },
    },
    chatHistory: async () => {
      calls.push({ type: "workspace-full-history" });
      return [];
    },
  };

  await fetchPersistedChatHydration({
    workspaceModel,
    workspaceSlug: "workspace",
    threadSlug: "thread",
    chatId: 42,
  });

  assert.deepEqual(calls, [
    {
      type: "thread-hydrate",
      workspaceSlug: "workspace",
      threadSlug: "thread",
      chatIds: [42],
    },
  ]);
});

test("workspace persisted confirmation hydrates only the completed chat", async () => {
  const calls = [];
  const workspaceModel = {
    threads: {
      chatHistoryHydration: async () => {
        calls.push({ type: "thread-hydrate" });
        return { history: [] };
      },
    },
    chatHistoryHydration: async (workspaceSlug, chatIds) => {
      calls.push({ type: "workspace-hydrate", workspaceSlug, chatIds });
      return { history: [], hydratedChatIds: chatIds };
    },
    chatHistory: async () => {
      calls.push({ type: "workspace-full-history" });
      return [];
    },
  };

  await fetchPersistedChatHydration({
    workspaceModel,
    workspaceSlug: "workspace",
    chatId: 7,
  });

  assert.deepEqual(calls, [
    { type: "workspace-hydrate", workspaceSlug: "workspace", chatIds: [7] },
  ]);
});

test("persisted hydration keeps only the requested chat when assistant exists", () => {
  const history = persistedHydratedChatHistory(
    {
      history: [
        { chatId: 40, role: "user", content: "older" },
        { chatId: 42, role: "user", content: "prompt" },
        { chatId: 42, role: "assistant", content: "answer" },
        { chatId: 43, role: "assistant", content: "newer" },
      ],
    },
    42
  );

  assert.deepEqual(
    history.map((message) => `${message.chatId}:${message.role}`),
    ["42:user", "42:assistant"]
  );
});

test("persisted hydration is empty until assistant record is available", () => {
  assert.deepEqual(
    persistedHydratedChatHistory(
      { history: [{ chatId: 42, role: "user", content: "prompt" }] },
      42
    ),
    []
  );
});
