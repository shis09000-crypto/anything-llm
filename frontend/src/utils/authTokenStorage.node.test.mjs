import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const authStorageUrl = new URL("./authTokenStorage.js", import.meta.url);

function memoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key(index) {
      return [...store.keys()][index] ?? null;
    },
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    has: (key) => store.has(key),
  };
}

async function loadAuthTokenStorage() {
  const source = await readFile(authStorageUrl, "utf8");
  const transformed = source.replace(
    'import { AUTH_TOKEN } from "@/utils/constants";',
    'const AUTH_TOKEN = "anythingllm_authToken";'
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("auth token storage migrates legacy localStorage token into sessionStorage", async () => {
  const originalWindow = globalThis.window;
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  localStorage.setItem("anythingllm_authToken", "legacy-token");
  globalThis.window = { localStorage, sessionStorage, dispatchEvent: () => {} };

  try {
    const mod = await loadAuthTokenStorage();
    assert.equal(mod.getAuthToken(), "legacy-token");
    assert.equal(
      sessionStorage.getItem("anythingllm_authToken"),
      "legacy-token"
    );
    assert.equal(localStorage.getItem("anythingllm_authToken"), null);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("setAuthToken keeps bearer token out of localStorage", async () => {
  const originalWindow = globalThis.window;
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  globalThis.window = { localStorage, sessionStorage, dispatchEvent: () => {} };

  try {
    const mod = await loadAuthTokenStorage();
    mod.setAuthToken("new-token");
    assert.equal(sessionStorage.getItem("anythingllm_authToken"), "new-token");
    assert.equal(localStorage.getItem("anythingllm_authToken"), null);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("removeAuthToken clears token and signing secret session cache", async () => {
  const originalWindow = globalThis.window;
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const events = [];
  localStorage.setItem("anythingllm_authToken", "legacy-token");
  sessionStorage.setItem("anythingllm_authToken", "session-token");
  sessionStorage.setItem("athena_signing_secret_v1:client_a", "secret");
  sessionStorage.setItem("other", "keep");
  globalThis.window = {
    localStorage,
    sessionStorage,
    dispatchEvent: (event) => events.push(event.type),
  };

  try {
    const mod = await loadAuthTokenStorage();
    mod.removeAuthToken();
    assert.equal(sessionStorage.getItem("anythingllm_authToken"), null);
    assert.equal(localStorage.getItem("anythingllm_authToken"), null);
    assert.equal(
      sessionStorage.getItem("athena_signing_secret_v1:client_a"),
      null
    );
    assert.equal(sessionStorage.getItem("other"), "keep");
    assert.deepEqual(events, [mod.AUTH_SESSION_CLEARED_EVENT]);
  } finally {
    globalThis.window = originalWindow;
  }
});
