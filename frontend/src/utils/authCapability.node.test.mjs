import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAuthCapability,
  passkeyCapabilityDescription,
} from "./authCapability.js";

const MAC_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BROWSER_360_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 360SE";
const QQ_BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 MQQBrowser/14.5 Mobile Safari/537.36";
const UNKNOWN_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) UnknownBrowser/1.0 Safari/537.36";

test("Apple state shows passkey with Apple capability copy", () => {
  for (const scenario of [
    { userAgent: MAC_SAFARI_UA, platform: "MacIntel", maxTouchPoints: 0 },
    { userAgent: IPHONE_SAFARI_UA, platform: "iPhone", maxTouchPoints: 5 },
    { userAgent: IPAD_SAFARI_UA, platform: "iPad", maxTouchPoints: 5 },
  ]) {
    const capability = classifyAuthCapability({
      ...scenario,
      secureContext: true,
      passkeyHostSupported: true,
      supportsWebAuthn: true,
    });

    assert.equal(capability.platform, "apple");
    assert.equal(capability.showPasskey, true);
    assert.equal(
      passkeyCapabilityDescription(capability),
      "可使用 Face ID、Touch ID 或设备密码安全登录。"
    );
  }
});

test("Google Chrome state shows passkey with browser capability copy", () => {
  const capability = classifyAuthCapability({
    userAgent: CHROME_UA,
    platform: "Win32",
    userAgentData: {
      brands: [
        { brand: "Not A(Brand", version: "99" },
        { brand: "Google Chrome", version: "126" },
        { brand: "Chromium", version: "126" },
      ],
      platform: "Windows",
    },
    secureContext: true,
    passkeyHostSupported: true,
    supportsWebAuthn: true,
  });

  assert.equal(capability.platform, "windows");
  assert.equal(capability.browser, "chrome");
  assert.equal(capability.showPasskey, true);
  assert.equal(
    passkeyCapabilityDescription(capability),
    "可使用浏览器或设备支持的通行密钥安全登录。"
  );
});

test("unsupported domestic and unknown browsers do not show passkey or ZK fallback", () => {
  for (const scenario of [
    { userAgent: BROWSER_360_UA, platform: "Win32", browser: "domestic" },
    { userAgent: QQ_BROWSER_UA, platform: "Linux armv8l", browser: "domestic" },
    { userAgent: UNKNOWN_UA, platform: "Linux x86_64", browser: "unknown" },
  ]) {
    const capability = classifyAuthCapability({
      userAgent: scenario.userAgent,
      platform: scenario.platform,
      secureContext: true,
      passkeyHostSupported: true,
      supportsWebAuthn: true,
    });

    assert.equal(capability.browser, scenario.browser);
    assert.equal(capability.showPasskey, false);
    assert.equal("fallbackMode" in capability, false);
    assert.equal(
      passkeyCapabilityDescription(capability),
      "当前浏览器不支持通行密钥。"
    );
  }
});

test("WebAuthn support is required even for Apple and Chrome states", () => {
  for (const scenario of [
    { userAgent: MAC_SAFARI_UA, platform: "MacIntel" },
    { userAgent: CHROME_UA, platform: "Win32" },
  ]) {
    const capability = classifyAuthCapability({
      ...scenario,
      supportsWebAuthn: false,
    });

    assert.equal(capability.supportsWebAuthn, false);
    assert.equal(capability.showPasskey, false);
    assert.equal("fallbackMode" in capability, false);
  }
});
