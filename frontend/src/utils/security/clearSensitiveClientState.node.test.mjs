import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const moduleUrl = new URL("./clearSensitiveClientState.js", import.meta.url);

function memoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[index] || null;
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    has(key) {
      return store.has(key);
    },
  };
}

async function loadClearSensitiveClientState() {
  const source = await readFile(moduleUrl, "utf8");
  globalThis.__clearSensitiveStateTest = {
    removedAuthTokens: 0,
    removedAuthUsers: 0,
    threadClears: 0,
    workspaceClears: 0,
  };

  const transformed = source
    .replace(
      /import\s+\{[\s\S]*?\}\s+from\s+"@\/utils\/constants";/,
      `const {
        AUTH_TIMESTAMP,
        LAST_USER_ACTION_AT,
        LAST_VISITED_WORKSPACE,
        LAST_VISITED_WORKSPACE_THREADS,
        USER_PROMPT_INPUT_MAP,
      } = {
        AUTH_TIMESTAMP: "auth_timestamp",
        LAST_USER_ACTION_AT: "last_user_action_at",
        LAST_VISITED_WORKSPACE: "last_visited_workspace",
        LAST_VISITED_WORKSPACE_THREADS: "last_visited_workspace_threads",
        USER_PROMPT_INPUT_MAP: "user_prompt_input_map",
      };`
    )
    .replace(
      'import { removeAuthToken } from "@/utils/authTokenStorage";',
      `const removeAuthToken = () => {
        globalThis.__clearSensitiveStateTest.removedAuthTokens += 1;
      };`
    )
    .replace(
      'import { removeStoredAuthUser } from "@/utils/authUserStorage";',
      `const removeStoredAuthUser = () => {
        globalThis.__clearSensitiveStateTest.removedAuthUsers += 1;
      };`
    )
    .replace(
      'import { storageKeys } from "@/utils/appEnvironment";',
      "const storageKeys = (storage) => Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(Boolean);"
    )
    .replace(
      'import { threadHistoryCache } from "@/utils/chat/threadHistoryCache";',
      `const threadHistoryCache = {
        clearAll() {
          globalThis.__clearSensitiveStateTest.threadClears += 1;
        },
      };`
    )
    .replace(
      'import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";',
      `const workspaceNavigationCache = {
        clear() {
          globalThis.__clearSensitiveStateTest.workspaceClears += 1;
        },
      };`
    )
    .replace(
      'import { clearLocalCacheCryptoKeys } from "@/utils/security/localCacheCrypto";',
      "const clearLocalCacheCryptoKeys = async () => {};"
    );

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("session-only clear preserves durable caches when requested", async () => {
  const originalWindow = globalThis.window;
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  globalThis.window = { localStorage, sessionStorage };

  localStorage.setItem("user_prompt_input_map", "draft-map");
  localStorage.setItem("last_visited_workspace", "workspace-a");
  localStorage.setItem("auth_timestamp", "123");
  sessionStorage.setItem("chat-thread-draft:abc", "draft");
  sessionStorage.setItem("chat-thread-active-running", "thread-abc");

  try {
    const mod = await loadClearSensitiveClientState();
    mod.clearSensitiveClientSession({ includeDurableCaches: false });

    assert.equal(localStorage.getItem("user_prompt_input_map"), "draft-map");
    assert.equal(localStorage.getItem("last_visited_workspace"), "workspace-a");
    assert.equal(localStorage.getItem("auth_timestamp"), null);
    assert.equal(sessionStorage.getItem("chat-thread-draft:abc"), "draft");
    assert.equal(
      sessionStorage.getItem("chat-thread-active-running"),
      "thread-abc"
    );
    assert.equal(globalThis.__clearSensitiveStateTest.removedAuthTokens, 1);
    assert.equal(globalThis.__clearSensitiveStateTest.removedAuthUsers, 1);
    assert.equal(globalThis.__clearSensitiveStateTest.threadClears, 0);
    assert.equal(globalThis.__clearSensitiveStateTest.workspaceClears, 0);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("default session clear removes durable local work caches", async () => {
  const originalWindow = globalThis.window;
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  globalThis.window = { localStorage, sessionStorage };

  localStorage.setItem("user_prompt_input_map", "draft-map");
  localStorage.setItem("last_visited_workspace", "workspace-a");
  localStorage.setItem("last_visited_workspace_threads", "thread-map");
  sessionStorage.setItem("chat-thread-draft:abc", "draft");
  sessionStorage.setItem("chat-thread-active-running", "thread-abc");

  try {
    const mod = await loadClearSensitiveClientState();
    mod.clearSensitiveClientSession();

    assert.equal(localStorage.getItem("user_prompt_input_map"), null);
    assert.equal(localStorage.getItem("last_visited_workspace"), null);
    assert.equal(localStorage.getItem("last_visited_workspace_threads"), null);
    assert.equal(sessionStorage.getItem("chat-thread-draft:abc"), null);
    assert.equal(sessionStorage.getItem("chat-thread-active-running"), null);
    assert.equal(globalThis.__clearSensitiveStateTest.threadClears, 1);
    assert.equal(globalThis.__clearSensitiveStateTest.workspaceClears, 1);
  } finally {
    globalThis.window = originalWindow;
  }
});
