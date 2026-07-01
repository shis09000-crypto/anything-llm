import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const moduleUrl = new URL("./authSessionMaintenance.js", import.meta.url);

async function loadAuthSessionMaintenance({
  dev = true,
  hasWindow = true,
} = {}) {
  if (hasWindow) globalThis.window = {};
  else delete globalThis.window;

  const source = await readFile(moduleUrl, "utf8");
  const transformed = source.replaceAll(
    "import.meta.env?.DEV",
    JSON.stringify(dev)
  );
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
  return mod;
}

test("classifies successful and explicit auth refresh failures", async () => {
  const mod = await loadAuthSessionMaintenance();

  assert.equal(mod.classifyAuthRefreshResult({ success: true }), "valid");
  assert.equal(
    mod.classifyAuthRefreshResult({
      success: false,
      status: 401,
      message: "Invalid auth token.",
    }),
    "invalid"
  );
  assert.equal(
    mod.classifyAuthRefreshResult({
      success: false,
      message: "Session expired or invalid.",
    }),
    "invalid"
  );
});

test("preserves local auth only for development transient failures", async () => {
  const devMod = await loadAuthSessionMaintenance({ dev: true });
  const prodMod = await loadAuthSessionMaintenance({ dev: false });

  assert.equal(
    devMod.shouldPreserveLocalAuthOnFailure({
      status: 0,
      code: "API_TIMEOUT_ERROR",
      message: "Request timed out after 8000ms.",
    }),
    true
  );
  assert.equal(
    devMod.shouldPreserveLocalAuthOnFailure({
      status: 500,
      message: "Request failed with status 500.",
    }),
    true
  );
  assert.equal(
    devMod.shouldPreserveLocalAuthOnFailure({
      status: 403,
      message: "Invalid auth for user.",
    }),
    false
  );
  assert.equal(
    prodMod.shouldPreserveLocalAuthOnFailure({
      status: 500,
      message: "Request failed with status 500.",
    }),
    false
  );
});

test("retry delay backs off quickly and caps at ten seconds", async () => {
  const mod = await loadAuthSessionMaintenance();

  assert.equal(mod.authMaintenanceRetryDelayMs(0), 1_000);
  assert.equal(mod.authMaintenanceRetryDelayMs(2), 4_000);
  assert.equal(mod.authMaintenanceRetryDelayMs(99), 10_000);
});
