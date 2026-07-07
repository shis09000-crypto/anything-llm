import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const moduleUrl = new URL("./session.js", import.meta.url);

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

async function loadSessionModule({
  checkSessionToken,
  shouldPreserveLocalAuthOnFailure,
} = {}) {
  globalThis.__athenaCheckSessionToken =
    checkSessionToken || (async () => ({ response: { status: 200 } }));
  globalThis.__athenaShouldPreserveLocalAuthOnFailure =
    shouldPreserveLocalAuthOnFailure || (() => false);
  globalThis.window = { localStorage: makeLocalStorage() };

  const source = await readFile(moduleUrl, "utf8");
  const transformed = source
    .replace(
      'import { checkSessionToken } from "@/lib/communication/systemRuntimeClient";',
      "const checkSessionToken = globalThis.__athenaCheckSessionToken;"
    )
    .replace(
      'import { AUTH_TIMESTAMP } from "@/utils/constants";',
      'const AUTH_TIMESTAMP = "athena-auth-timestamp";'
    )
    .replace(
      'import { shouldPreserveLocalAuthOnFailure } from "@/utils/authSessionMaintenance";',
      "const shouldPreserveLocalAuthOnFailure = globalThis.__athenaShouldPreserveLocalAuthOnFailure;"
    );

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("session validation reports valid when token check succeeds", async () => {
  const mod = await loadSessionModule();
  const result = await mod.validateSessionTokenForUserDetailed();

  assert.equal(result.state, mod.SESSION_VALIDATION_STATE.VALID);
  assert.equal(result.valid, true);
  assert.equal(result.transient, false);
  assert.ok(window.localStorage.getItem("athena-auth-timestamp"));
});

test("session validation preserves auth on transient token check failure", async () => {
  const mod = await loadSessionModule({
    checkSessionToken: async () => {
      const error = new Error("Request timed out after 8000ms.");
      error.status = 0;
      error.code = "API_TIMEOUT_ERROR";
      throw error;
    },
    shouldPreserveLocalAuthOnFailure: () => true,
  });

  const result = await mod.validateSessionTokenForUserDetailed();
  const legacyBoolean = await mod.default();

  assert.equal(result.state, mod.SESSION_VALIDATION_STATE.TRANSIENT);
  assert.equal(result.valid, true);
  assert.equal(result.transient, true);
  assert.equal(legacyBoolean, true);
  assert.equal(window.localStorage.getItem("athena-auth-timestamp"), null);
});

test("session validation reports invalid on explicit auth failure", async () => {
  const mod = await loadSessionModule({
    checkSessionToken: async () => {
      const error = new Error("Invalid auth token.");
      error.status = 401;
      throw error;
    },
    shouldPreserveLocalAuthOnFailure: () => false,
  });

  const result = await mod.validateSessionTokenForUserDetailed();
  const legacyBoolean = await mod.default();

  assert.equal(result.state, mod.SESSION_VALIDATION_STATE.INVALID);
  assert.equal(result.valid, false);
  assert.equal(result.transient, false);
  assert.equal(legacyBoolean, false);
  assert.equal(window.localStorage.getItem("athena-auth-timestamp"), null);
});
