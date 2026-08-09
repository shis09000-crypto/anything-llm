import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

const moduleUrl = new URL("./authLifecycleCoordinator.js", import.meta.url);

function storage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

async function loadCoordinator(pathname = "/workspace/alpha") {
  const sessionStorage = storage();
  const replacements = [];
  globalThis.window = {
    location: {
      origin: "https://athenallm.online",
      href: `https://athenallm.online${pathname}`,
      pathname,
      replace: (target) => replacements.push(target),
    },
    sessionStorage,
  };
  globalThis.__clearCalls = [];
  const source = await readFile(moduleUrl, "utf8");
  const transformed = source.replace(
    'import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";',
    "const clearSensitiveClientSession = (options) => globalThis.__clearCalls.push(options);"
  );
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
  return { mod, replacements };
}

test("ordinary business failures cannot trigger a login redirect", async () => {
  const { mod, replacements } = await loadCoordinator();
  assert.equal(mod.redirectToLogin({ reason: "forbidden" }), false);
  assert.deepEqual(replacements, []);
  assert.deepEqual(globalThis.__clearCalls, []);
});

test("missing local session storage is recoverable and never forces logout", async () => {
  const { mod, replacements } = await loadCoordinator();
  assert.equal(
    mod.redirectToLogin({ reason: "missing_session_storage" }),
    false
  );
  assert.deepEqual(replacements, []);
  assert.deepEqual(globalThis.__clearCalls, []);
  assert.equal(
    mod.normalizeLegacyLoginSearch(
      "?nt=1&reason=missing_session_storage&returnRef=1"
    ),
    "?nt=1"
  );
});

test("terminal Identity failures preserve a same-origin return target", async () => {
  const { mod, replacements } = await loadCoordinator(
    "/workspace/alpha?t=trusted"
  );
  assert.equal(mod.redirectToLogin({ reason: "session_revoked" }), true);
  assert.equal(replacements.length, 1);
  assert.match(replacements[0], /^\/login\?nt=1&reason=session_revoked/);
  assert.deepEqual(globalThis.__clearCalls, [
    { includeDurableCaches: false, preserveRecovery: true },
  ]);
  assert.equal(mod.consumeAuthReturnRef(), "/workspace/alpha?t=trusted");
});

test("external and login URLs are never accepted as return targets", async () => {
  const { mod } = await loadCoordinator();
  assert.equal(mod.preserveAuthReturnRef("https://evil.example/phish"), null);
  assert.equal(mod.preserveAuthReturnRef("/login"), null);
});
