import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_CAPABILITY_STATUS,
  classifyAuthCapability,
  passkeyCapabilityDescription,
} from "./authCapability.js";

const WINDOWS_EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36";
const MAC_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15";

function capable(overrides = {}) {
  return classifyAuthCapability({
    userAgent: WINDOWS_CHROME_UA,
    platform: "Win32",
    secureContext: true,
    validRpHost: true,
    webAuthnApiAvailable: true,
    serverPasskeyEnabled: true,
    crossDeviceAllowed: true,
    rpIdValid: true,
    ...overrides,
  });
}

test("Windows Hello produces a primary local passkey capability", () => {
  for (const userAgent of [WINDOWS_CHROME_UA, WINDOWS_EDGE_UA]) {
    const capability = capable({
      userAgent,
      platformAuthenticatorAvailable: true,
    });
    assert.equal(capability.status, AUTH_CAPABILITY_STATUS.LOCAL_READY);
    assert.equal(capability.showPasskey, true);
    assert.equal(
      passkeyCapabilityDescription(capability),
      "可使用 Windows Hello 安全登录。"
    );
  }
});

test("Windows without Hello exposes only phone or security-key entry", () => {
  const capability = capable({ platformAuthenticatorAvailable: false });
  assert.equal(capability.status, AUTH_CAPABILITY_STATUS.CROSS_DEVICE_ONLY);
  assert.equal(capability.showPasskey, true);
  assert.match(passkeyCapabilityDescription(capability), /手机扫码/);
});

test("macOS platform authenticator is local ready", () => {
  const capability = capable({
    userAgent: MAC_SAFARI_UA,
    platform: "MacIntel",
    platformAuthenticatorAvailable: true,
  });
  assert.equal(capability.platform, "apple");
  assert.equal(capability.status, AUTH_CAPABILITY_STATUS.LOCAL_READY);
  assert.match(passkeyCapabilityDescription(capability), /Touch ID/);
});

test("insecure, invalid RP, unavailable WebAuthn and embedded webviews hide passkeys", () => {
  for (const overrides of [
    { secureContext: false },
    { validRpHost: false },
    { rpIdValid: false },
    { webAuthnApiAvailable: false },
    { embeddedWebView: true },
    { serverPasskeyEnabled: false },
  ]) {
    const capability = capable(overrides);
    assert.equal(capability.status, AUTH_CAPABILITY_STATUS.UNAVAILABLE);
    assert.equal(capability.showPasskey, false);
  }
});

test("browser brands are diagnostic only, not an allowlist", () => {
  const capability = capable({
    userAgent: "Unknown Standards Browser",
    platform: "Linux",
    platformAuthenticatorAvailable: false,
  });
  assert.equal(capability.browser, "unknown");
  assert.equal(capability.status, AUTH_CAPABILITY_STATUS.CROSS_DEVICE_ONLY);
});
