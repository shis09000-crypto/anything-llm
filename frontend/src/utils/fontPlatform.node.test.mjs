import test from "node:test";
import assert from "node:assert/strict";
import {
  detectFontPlatform,
  FONT_PLATFORM_APPLE,
  FONT_PLATFORM_ATTRIBUTE,
  FONT_PLATFORM_CJK_WEBFONT,
  installFontPlatformScope,
} from "./fontPlatform.js";

test("detects Apple platforms from navigator platform and user agent", () => {
  assert.equal(
    detectFontPlatform({
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      maxTouchPoints: 0,
    }),
    FONT_PLATFORM_APPLE
  );

  assert.equal(
    detectFontPlatform({
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    }),
    FONT_PLATFORM_APPLE
  );

  assert.equal(
    detectFontPlatform({
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    }),
    FONT_PLATFORM_APPLE
  );
});

test("uses the CJK webfont platform for non-Apple devices", () => {
  for (const navigatorLike of [
    {
      platform: "Win32",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    {
      platform: "Linux armv8l",
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
    },
    {
      platform: "Linux x86_64",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    },
  ]) {
    assert.equal(
      detectFontPlatform(navigatorLike),
      FONT_PLATFORM_CJK_WEBFONT
    );
  }
});

test("installFontPlatformScope writes the platform attribute", () => {
  const attributes = new Map();
  const root = {
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  };

  const platform = installFontPlatformScope(root, {
    platform: "Win32",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  });

  assert.equal(platform, FONT_PLATFORM_CJK_WEBFONT);
  assert.equal(
    attributes.get(FONT_PLATFORM_ATTRIBUTE),
    FONT_PLATFORM_CJK_WEBFONT
  );
});
