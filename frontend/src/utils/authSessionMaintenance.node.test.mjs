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
  const transformed = source
    .replaceAll("import.meta.env?.DEV", JSON.stringify(dev))
    .replace(
      /import \{\s*authReasonFrom,\s*isTerminalAuthReason,\s*\} from "@\/utils\/authLifecycleCoordinator";/,
      `const authReasonFrom = (source = {}) => String(source.reasonCode || source.raw?.reasonCode || source.raw?.reason || source.raw?.error || source.code || "").toLowerCase();
const isTerminalAuthReason = (reason) => new Set(["session_revoked", "session_expired", "session_idle_expired", "account_suspended", "client_revoked"]).has(String(reason));`
    );
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
  return mod;
}

test("classifies only structured terminal reasons as explicit failures", async () => {
  const mod = await loadAuthSessionMaintenance();

  assert.equal(mod.classifyAuthRefreshResult({ success: true }), "valid");
  assert.equal(
    mod.classifyAuthRefreshResult({
      success: false,
      status: 401,
      message: "Invalid auth token.",
    }),
    "transient"
  );
  assert.equal(
    mod.classifyAuthRefreshResult({
      success: false,
      reasonCode: "session_expired",
    }),
    "invalid"
  );
});

test("preserves local auth for transient failures in production and development", async () => {
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
      raw: { reasonCode: "account_suspended" },
    }),
    false
  );
  assert.equal(
    prodMod.shouldPreserveLocalAuthOnFailure({
      status: 500,
      message: "Request failed with status 500.",
    }),
    true
  );
  assert.equal(
    prodMod.shouldPreserveLocalAuthOnFailure({
      status: 0,
      code: "API_TIMEOUT_ERROR",
      message: "Request timed out after 8000ms.",
    }),
    true
  );
  assert.equal(
    prodMod.shouldPreserveLocalAuthOnFailure({
      status: 401,
      raw: { reasonCode: "session_revoked" },
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

test("distinguishes preflight transport outages from local crypto failures", async () => {
  const mod = await loadAuthSessionMaintenance();

  assert.deepEqual(
    mod.classifyDeviceBindingPreflightFailure({
      status: 503,
      code: "HTTP_OPEN_ERROR",
      deviceBindingStage: "transport",
    }),
    {
      status: 503,
      serviceUnavailable: true,
      errorCode: "HTTP_OPEN_ERROR",
      message: "登录服务暂时不可用，请稍后重试。",
    }
  );
  assert.deepEqual(
    mod.classifyDeviceBindingPreflightFailure({
      status: 0,
      message: "browser_hybrid_crypto_unavailable",
      deviceBindingStage: "local_crypto",
    }),
    {
      status: 0,
      serviceUnavailable: false,
      errorCode: "browser_hybrid_crypto_unavailable",
      message: "无法读取或验证此设备的安全密钥。",
    }
  );
});
