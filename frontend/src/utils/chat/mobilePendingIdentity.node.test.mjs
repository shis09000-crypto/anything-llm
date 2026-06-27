import test from "node:test";
import assert from "node:assert/strict";
import {
  hasAssistantAfterSubmitted,
  historyIncludesSubmittedMessage,
  submittedMessageIndex,
} from "./mobilePendingIdentity.js";

test("pending identity ignores stale repeated user messages", () => {
  const messages = [
    {
      role: "user",
      text: "重复问题",
      sentAt: Date.parse("2026-06-26T13:10:40.000Z") / 1000,
    },
    {
      role: "assistant",
      text: "上一轮回答",
      sentAt: Date.parse("2026-06-26T13:10:40.000Z") / 1000,
    },
  ];
  const submittedAt = Date.parse("2026-06-26T14:40:47.000Z") / 1000;

  assert.equal(
    historyIncludesSubmittedMessage(messages, "重复问题", submittedAt),
    false
  );
  assert.equal(submittedMessageIndex(messages, "重复问题", submittedAt), -1);
});

test("pending identity requires timestamps for submitted turn confirmation", () => {
  const submittedAt = Date.parse("2026-06-26T14:40:47.000Z") / 1000;
  const messages = [
    {
      role: "user",
      text: "重复问题",
    },
    {
      role: "assistant",
      text: "缺少时间的回答",
    },
  ];

  assert.equal(
    historyIncludesSubmittedMessage(messages, "重复问题", submittedAt),
    false
  );
  assert.equal(
    hasAssistantAfterSubmitted(
      messages,
      "重复问题",
      submittedAt,
      (message) => !!message.text
    ),
    false
  );
});

test("pending identity confirms only the current repeated turn", () => {
  const submittedAt = Date.parse("2026-06-26T14:40:47.000Z") / 1000;
  const messages = [
    {
      role: "user",
      text: "重复问题",
      sentAt: Date.parse("2026-06-26T13:10:40.000Z") / 1000,
    },
    {
      role: "assistant",
      text: "上一轮回答",
      sentAt: Date.parse("2026-06-26T13:10:40.000Z") / 1000,
    },
    {
      role: "user",
      text: "重复问题",
      sentAt: submittedAt + 1,
    },
    {
      role: "assistant",
      text: "当前轮回答",
      sentAt: submittedAt + 1,
    },
  ];

  assert.equal(submittedMessageIndex(messages, "重复问题", submittedAt), 2);
  assert.equal(
    hasAssistantAfterSubmitted(
      messages,
      "重复问题",
      submittedAt,
      (message) => !!message.text
    ),
    true
  );
});

test("pending identity does not clear on an old repeated turn with another clientTurnId", () => {
  const submittedAt = Date.parse("2026-06-26T14:40:47.000Z") / 1000;
  const messages = [
    {
      role: "user",
      clientTurnId: "turn:old",
      text: "重复问题",
      sentAt: submittedAt,
    },
    {
      role: "assistant",
      clientTurnId: "turn:old",
      text: "上一轮回答",
      sentAt: submittedAt,
    },
  ];

  assert.equal(
    historyIncludesSubmittedMessage(messages, "重复问题", submittedAt, {
      clientTurnId: "turn:current",
    }),
    false
  );
  assert.equal(
    hasAssistantAfterSubmitted(
      messages,
      "重复问题",
      submittedAt,
      (message) => !!message.text,
      { clientTurnId: "turn:current" }
    ),
    false
  );
});

test("pending identity falls back to timestamp when server history lacks clientTurnId", () => {
  const submittedAt = Date.parse("2026-06-26T14:40:47.000Z") / 1000;
  const messages = [
    {
      role: "user",
      text: "重复问题",
      sentAt: submittedAt + 1,
    },
    {
      role: "assistant",
      text: "当前轮回答",
      sentAt: submittedAt + 1,
    },
  ];

  assert.equal(
    historyIncludesSubmittedMessage(messages, "重复问题", submittedAt, {
      clientTurnId: "turn:current",
    }),
    true
  );
  assert.equal(
    hasAssistantAfterSubmitted(
      messages,
      "重复问题",
      submittedAt,
      (message) => !!message.text,
      { clientTurnId: "turn:current" }
    ),
    true
  );
});

test("pending identity confirms attachment turns when server text is expanded", () => {
  const submittedAt = Date.parse("2026-06-26T20:39:03.000Z") / 1000;
  const messages = [
    {
      role: "user",
      text: "你看看这个图片是个啥\n\n[System image pre-analysis] ...",
      sentAt: submittedAt + 15,
      attachments: [{ name: "photo.jpg", mime: "image/jpeg" }],
    },
    {
      role: "assistant",
      text: "这是一张室内双床房的照片。",
      sentAt: submittedAt + 15,
    },
  ];

  assert.equal(
    historyIncludesSubmittedMessage(messages, "你看看", submittedAt, {
      clientTurnId: "turn:current",
      hasAttachments: true,
    }),
    true
  );
  assert.equal(
    hasAssistantAfterSubmitted(
      messages,
      "你看看",
      submittedAt,
      (message) => !!message.text,
      { clientTurnId: "turn:current", hasAttachments: true }
    ),
    true
  );
});
