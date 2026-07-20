const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const packageJson = require("../package.json");
const {
  SECURE_WEB_PREFERENCES,
  isRecoveryRendererUrl,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  validateDesktopBuildSecurity,
} = require("../security-policy.cjs");

test("renderer process uses explicit Electron isolation defaults", () => {
  assert.equal(SECURE_WEB_PREFERENCES.contextIsolation, true);
  assert.equal(SECURE_WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(SECURE_WEB_PREFERENCES.sandbox, true);
  assert.equal(SECURE_WEB_PREFERENCES.webSecurity, true);
  assert.equal(SECURE_WEB_PREFERENCES.webviewTag, false);
});

test("renderer navigation is limited to the bound loopback service", () => {
  const recoveryUrl = pathToFileURL(
    path.join(__dirname, "..", "recovery.html")
  ).toString();
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:3001/chat", 3001), true);
  assert.equal(isTrustedRendererUrl("http://localhost:3001/chat", 3001), false);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:3002/chat", 3001), false);
  assert.equal(isTrustedRendererUrl("https://example.com", 3001), false);
  assert.equal(isSafeExternalUrl("https://example.com"), true);
  assert.equal(isSafeExternalUrl("http://example.com"), false);
  assert.equal(isRecoveryRendererUrl(recoveryUrl), true);
  assert.equal(
    isRecoveryRendererUrl(pathToFileURL("/tmp/recovery.html").toString()),
    false
  );
});

test("Windows packages retain signed update verification", () => {
  assert.deepEqual(validateDesktopBuildSecurity(packageJson), {
    ok: true,
    errors: [],
  });
});
