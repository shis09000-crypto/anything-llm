import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrl = new URL("./userStateSync.js", import.meta.url);

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
}

async function loadSync(api = {}) {
  const source = await readFile(moduleUrl, "utf8");
  const localStorage = memoryStorage();
  globalThis.localStorage = localStorage;
  globalThis.window = { localStorage };
  globalThis.__userStateSyncApi = {
    getUserStates: api.getUserStates || (async () => []),
    patchUserStates: api.patchUserStates || (async (states) => states),
    deleteUserState: api.deleteUserState || (async () => ({ success: true })),
    USER_STATE_NAMESPACES: {
      chatDraft: "chat.draft",
      threadReadState: "thread.read-state",
      appearance: "preferences.appearance",
      ...api.namespaces,
    },
  };
  globalThis.__userStateSyncAuthUser =
    api.getStoredAuthUser || (() => ({ id: 7, authUserId: "auth-7" }));
  globalThis.__userStateSyncDecrypt =
    api.decryptLocalCachePayload || (async () => null);
  const transformed = source
    .replace(
      /import \{[\s\S]*?\} from "@\/lib\/communication\/userStateClient";/,
      "const { getUserStates, patchUserStates, deleteUserState, USER_STATE_NAMESPACES } = globalThis.__userStateSyncApi;"
    )
    .replace(
      'import { APPEARANCE_SETTINGS } from "@/utils/constants";',
      'const APPEARANCE_SETTINGS = "appearance-settings";'
    )
    .replace(
      'import { safeJsonParse } from "@/utils/request";',
      "const safeJsonParse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };"
    )
    .replace(
      'import { getStoredAuthUser } from "@/utils/authUserStorage";',
      "const getStoredAuthUser = globalThis.__userStateSyncAuthUser;"
    )
    .replace(
      'import { decryptLocalCachePayload } from "@/utils/security/localCacheCrypto";',
      "const decryptLocalCachePayload = globalThis.__userStateSyncDecrypt;"
    );
  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("thread read cursor is locally monotonic and same-scope writes are ordered", async () => {
  const writes = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const sync = await loadSync({
    patchUserStates: async (states) => {
      writes.push(states[0]);
      if (writes.length === 1) await firstGate;
      return states;
    },
  });

  const first = sync.advanceThreadReadCursor({
    workspaceSlug: "ws-a",
    threadSlug: "thread-a",
    cursor: 20,
    messageId: 20,
  });
  const second = sync.advanceThreadReadCursor({
    workspaceSlug: "ws-a",
    threadSlug: "thread-a",
    cursor: 21,
    messageId: 21,
  });
  const duplicate = sync.advanceThreadReadCursor({
    workspaceSlug: "ws-a",
    threadSlug: "thread-a",
    cursor: 21,
    messageId: 21,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writes.length, 1);
  releaseFirst();
  await Promise.all([first, second, duplicate]);

  assert.deepEqual(
    writes.map((state) => state.value.cursor),
    [20, 21]
  );
  assert.equal(
    sync.threadReadStateScope({ workspaceSlug: "ws-a" }),
    "workspace:ws-a"
  );
});

test("prompt draft flush commits the final debounced value immediately", async () => {
  const writes = [];
  const sync = await loadSync({
    patchUserStates: async (states) => {
      writes.push(states[0]);
      return states;
    },
  });

  sync.persistPromptDraft("thread:ws-a:thread-a", "final text", {
    workspaceSlug: "ws-a",
    threadSlug: "thread-a",
    debounceMs: 60_000,
  });
  assert.equal(writes.length, 0);

  await sync.flushPromptDraft("thread:ws-a:thread-a");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.text, "final text");
  assert.equal(writes[0].version, "3");
});

test("originating browser self-heals a legacy local draft envelope", async () => {
  const writes = [];
  const sync = await loadSync({
    getUserStates: async () => [
      {
        namespace: "chat.draft",
        scope: "thread:ws-a:thread-a",
        stateVersion: 1,
        value: {
          encryptedText: { encrypted: true },
          workspaceSlug: "ws-a",
          threadSlug: "thread-a",
        },
      },
    ],
    decryptLocalCachePayload: async () => ({ text: "legacy text" }),
    patchUserStates: async (states) => {
      writes.push(states[0]);
      return states;
    },
  });

  const text = await sync.hydratePromptDraft(
    "thread:ws-a:thread-a",
    "fallback"
  );
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(text, "legacy text");
  assert.equal(writes[0].value.text, "legacy text");
  assert.equal(writes[0].version, "3");
});

test("a submitted prompt tombstone rejects a slow stale remote hydration", async () => {
  let resolveRemote;
  const remoteGate = new Promise((resolve) => {
    resolveRemote = resolve;
  });
  const sync = await loadSync({
    getUserStates: async () => await remoteGate,
  });

  const hydration = sync.hydratePromptDraft("thread:ws-a:thread-a", "cleared");
  await new Promise((resolve) => setTimeout(resolve, 0));
  sync.clearPromptDraft("thread:ws-a:thread-a");
  resolveRemote([
    {
      namespace: "chat.draft",
      scope: "thread:ws-a:thread-a",
      updatedAt: new Date(Date.now() - 1_000).toISOString(),
      value: {
        text: "already submitted prompt",
        updatedAt: Date.now() - 1_000,
        expiresAt: Date.now() + 60_000,
      },
    },
  ]);

  assert.equal(await hydration, "cleared");
});
