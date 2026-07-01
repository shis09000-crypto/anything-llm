import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const authUserStorageUrl = new URL("./authUserStorage.js", import.meta.url);

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
  };
}

async function loadAuthUserStorage() {
  const source = await readFile(authUserStorageUrl, "utf8");
  const transformed = source.replace(
    'import { AUTH_USER } from "@/utils/constants";',
    'const AUTH_USER = "anythingllm_user";'
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("auth user storage migrates legacy localStorage user into sessionStorage", async () => {
  const originalWindow = globalThis.window;
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  localStorage.setItem(
    "anythingllm_user",
    JSON.stringify({
      id: 7,
      username: "alice",
      authToken: "must-not-persist",
      passwordHash: "must-not-persist",
    })
  );
  globalThis.window = { localStorage, sessionStorage };

  try {
    const mod = await loadAuthUserStorage();
    assert.deepEqual(mod.getStoredAuthUser(), { id: 7, username: "alice" });
    assert.deepEqual(JSON.parse(sessionStorage.getItem("anythingllm_user")), {
      id: 7,
      username: "alice",
    });
    assert.equal(localStorage.getItem("anythingllm_user"), null);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("setStoredAuthUser keeps user snapshot out of localStorage", async () => {
  const originalWindow = globalThis.window;
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  globalThis.window = { localStorage, sessionStorage };

  try {
    const mod = await loadAuthUserStorage();
    mod.setStoredAuthUser({
      id: 1,
      username: "owner",
      email: "owner@example.com",
      apiKey: "must-not-persist",
    });
    assert.equal(localStorage.getItem("anythingllm_user"), null);
    assert.deepEqual(JSON.parse(sessionStorage.getItem("anythingllm_user")), {
      id: 1,
      username: "owner",
      email: "owner@example.com",
    });
  } finally {
    globalThis.window = originalWindow;
  }
});

test("removeStoredAuthUser clears legacy and session copies", async () => {
  const originalWindow = globalThis.window;
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  localStorage.setItem("anythingllm_user", "{}");
  sessionStorage.setItem("anythingllm_user", "{}");
  globalThis.window = { localStorage, sessionStorage };

  try {
    const mod = await loadAuthUserStorage();
    mod.removeStoredAuthUser();
    assert.equal(localStorage.getItem("anythingllm_user"), null);
    assert.equal(sessionStorage.getItem("anythingllm_user"), null);
  } finally {
    globalThis.window = originalWindow;
  }
});
