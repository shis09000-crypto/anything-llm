import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeMobileHydratedHistory,
  mobileHistoryHydrationTargets,
  mobileHistoryPayloadSummary,
  mobileHistoryRequestOptions,
} from "./mobileHistoryHydration.js";

test("mobile PWA history requests always ask for full mobile detail", () => {
  const options = mobileHistoryRequestOptions({
    limit: 20,
    priorityWindow: 0,
    detail: "light",
  });

  assert.equal(options.limit, 20);
  assert.equal(options.detail, "full");
  assert.equal(options.priorityWindow, Number.MAX_SAFE_INTEGER);
});

test("light and empty mobile history records are selected for hydration", () => {
  const targets = mobileHistoryHydrationTargets([
    {
      role: "user",
      chatId: 44,
      publicChatId: "chat_public_44",
      content: "short prompt",
      hydrationStatus: "light",
    },
    {
      role: "assistant",
      chatId: 44,
      publicChatId: "chat_public_44",
      content: "",
      hydrationStatus: "light",
    },
    {
      role: "assistant",
      chatId: 45,
      publicChatId: "chat_public_45",
      content: "",
    },
  ]);

  assert.equal(targets.needsHydration, true);
  assert.deepEqual(targets.chatIds, [44, 45]);
  assert.deepEqual(targets.publicChatIds, ["chat_public_44", "chat_public_45"]);
  assert.equal(targets.lightCount, 2);
  assert.equal(targets.emptyContentCount, 1);
});

test("hydrated records replace light records without losing order", () => {
  const merged = mergeMobileHydratedHistory(
    [
      {
        role: "user",
        chatId: 10,
        publicChatId: "chat_10",
        content: "light prompt",
        hydrationStatus: "light",
      },
      {
        role: "assistant",
        chatId: 10,
        publicChatId: "chat_10",
        content: "",
        hydrationStatus: "light",
      },
      {
        role: "user",
        chatId: 11,
        publicChatId: "chat_11",
        content: "next prompt",
      },
    ],
    [
      {
        role: "user",
        chatId: 10,
        publicChatId: "chat_10",
        content: "full prompt",
      },
      {
        role: "assistant",
        chatId: 10,
        publicChatId: "chat_10",
        content: "full answer",
      },
    ]
  );

  assert.deepEqual(
    merged.map((item) => `${item.chatId}:${item.role}:${item.content}`),
    ["10:user:full prompt", "10:assistant:full answer", "11:user:next prompt"]
  );
});

test("payload summary exposes empty rendered mobile messages for debug logs", () => {
  const summary = mobileHistoryPayloadSummary(
    [
      {
        role: "assistant",
        chatId: 99,
        publicChatId: "chat_99",
        content: "",
        hydrationStatus: "light",
      },
    ],
    [
      {
        role: "assistant",
        chatId: 99,
        publicChatId: "chat_99",
        text: "",
        time: "20:14",
      },
    ]
  );

  assert.equal(summary.historyCount, 1);
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.lightCount, 1);
  assert.equal(summary.emptyRenderedCount, 1);
});
