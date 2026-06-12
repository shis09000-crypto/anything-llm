import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_SCROLL_MEMORY_MAX_AGE_MS,
  CHAT_SCROLL_MEMORY_STORAGE_KEY,
  createChatScrollBottomMemorySnapshot,
  createChatScrollMemorySnapshot,
  historyContainsChatId,
  normalizeChatScrollMemoryEntry,
  pruneChatScrollMemoryMap,
  readChatScrollMemory,
  shouldFetchOlderForChatScrollMemory,
  textFingerprint,
  writeChatScrollBottomMemory,
  writeChatScrollMemory,
} from "./chatScrollMemory.js";

test("chat scroll memory snapshot stores structure without message text", () => {
  const snapshot = createChatScrollMemorySnapshot({
    chatKey: "workspace:thread",
    item: { id: "server:42:assistant", chatId: 42, role: "assistant" },
    anchor: {
      itemId: "server:42:assistant",
      offsetTop: -12,
      innerAnchor: {
        blockIndex: 3,
        offsetTop: 42,
        textFingerprint: textFingerprint("secret paragraph body"),
      },
    },
    scrollTop: 800,
    firstItemId: "server:40:user",
    lastItemId: "server:45:assistant",
    savedAt: 1_000,
  });

  assert.equal(snapshot.chatKey, "workspace:thread");
  assert.equal(snapshot.chatId, 42);
  assert.equal(snapshot.role, "assistant");
  assert.equal(snapshot.innerAnchor.blockIndex, 3);
  assert.equal(snapshot.innerAnchor.textFingerprint.includes("secret"), false);
});

test("bottom memory snapshot clears inner anchor and points at latest item", () => {
  const snapshot = createChatScrollBottomMemorySnapshot({
    chatKey: "workspace:thread",
    item: { id: "server:45:assistant", chatId: 45, type: "assistant_turn" },
    scrollTop: 1_200,
    firstItemId: "server:40:user",
    lastItemId: "server:45:assistant",
    savedAt: 2_000,
  });

  assert.equal(snapshot.chatKey, "workspace:thread");
  assert.equal(snapshot.itemId, "server:45:assistant");
  assert.equal(snapshot.chatId, 45);
  assert.equal(snapshot.role, "assistant");
  assert.equal(snapshot.isAtBottom, true);
  assert.equal(snapshot.innerAnchor, null);
});

test("writing bottom memory overwrites a stale history anchor", () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  storage.delete(CHAT_SCROLL_MEMORY_STORAGE_KEY);

  writeChatScrollMemory("workspace:thread", {
    chatKey: "workspace:thread",
    itemId: "server:12:assistant",
    chatId: 12,
    role: "assistant",
    innerAnchor: {
      blockIndex: 2,
      offsetTop: 10,
      textFingerprint: "100:old",
    },
    rowOffsetTop: -40,
    scrollTop: 500,
    isAtBottom: false,
    savedAt: Date.now() - 10,
  });

  const written = writeChatScrollBottomMemory("workspace:thread", {
    item: { id: "server:45:user", chatId: 45, type: "user" },
    scrollTop: 2_000,
    firstItemId: "server:12:assistant",
    lastItemId: "server:45:user",
  });
  const stored = readChatScrollMemory("workspace:thread");

  assert.equal(written.isAtBottom, true);
  assert.equal(stored.isAtBottom, true);
  assert.equal(stored.itemId, "server:45:user");
  assert.equal(stored.innerAnchor, null);
});

test("chat scroll memory prunes expired and excess records", () => {
  const at = CHAT_SCROLL_MEMORY_MAX_AGE_MS + 10_000;
  const map = {
    fresh: { chatKey: "fresh", savedAt: at - 100 },
    stale: { chatKey: "stale", savedAt: 1 },
    newest: { chatKey: "newest", savedAt: at },
  };

  assert.deepEqual(Object.keys(pruneChatScrollMemoryMap(map, { at })), [
    "newest",
    "fresh",
  ]);
  assert.deepEqual(
    Object.keys(pruneChatScrollMemoryMap(map, { at, maxThreads: 1 })),
    ["newest"]
  );
});

test("damaged chat scroll memory records are ignored", () => {
  assert.equal(normalizeChatScrollMemoryEntry(null), null);
  assert.equal(normalizeChatScrollMemoryEntry({ savedAt: Date.now() }), null);
  assert.equal(
    normalizeChatScrollMemoryEntry({
      chatKey: "workspace:thread",
      savedAt: Date.now() - CHAT_SCROLL_MEMORY_MAX_AGE_MS - 1,
    }),
    null
  );
});

test("older history prefetch stops when target is present or limit is reached", () => {
  const memory = { chatId: 12 };
  assert.equal(
    shouldFetchOlderForChatScrollMemory({
      memory,
      history: [{ chatId: 12 }],
      page: { hasMore: true },
    }),
    false
  );
  assert.equal(
    shouldFetchOlderForChatScrollMemory({
      memory,
      history: [{ chatId: 20 }],
      page: { hasMore: true },
      attempt: 2,
      maxAttempts: 8,
    }),
    true
  );
  assert.equal(
    shouldFetchOlderForChatScrollMemory({
      memory,
      history: [{ chatId: 20 }],
      page: { hasMore: true },
      attempt: 8,
      maxAttempts: 8,
    }),
    false
  );
  assert.equal(historyContainsChatId([{ chatId: 12 }], 12), true);
});
