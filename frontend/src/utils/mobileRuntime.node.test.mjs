import test from "node:test";
import assert from "node:assert/strict";
import {
  ATHENA_FORCE_MOBILE_PLATFORM_STORAGE_KEY,
  ATHENA_FORCE_MOBILE_STORAGE_KEY,
  detectMobileRuntimeFromNavigator,
  forcedMobilePlatform,
  isMobileRuntime,
  isMobileRuntimeForced,
  syncMobileRuntimeOverrideFromUrl,
} from "./mobileRuntime.js";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

function testWindow({
  href = "https://localhost:3000/",
  userAgent = "Mozilla/5.0",
  platform = "MacIntel",
  maxTouchPoints = 0,
  innerWidth = 1440,
  coarsePointer = false,
  sessionStorage = memoryStorage(),
} = {}) {
  return {
    location: { href, search: new URL(href).search },
    sessionStorage,
    innerWidth,
    matchMedia: (query) => ({
      matches:
        coarsePointer &&
        (query.includes("pointer: coarse") ||
          query.includes("any-pointer: coarse")),
    }),
    navigator: {
      userAgent,
      platform,
      maxTouchPoints,
    },
  };
}

test("URL parameter forces mobile runtime and persists for the current tab", () => {
  const sessionStorage = memoryStorage();
  const win = testWindow({
    href: "https://localhost:3000/?athenaMobile=1&athenaPlatform=android",
    sessionStorage,
  });

  assert.equal(syncMobileRuntimeOverrideFromUrl(win), true);
  assert.equal(isMobileRuntimeForced(win), true);
  assert.equal(isMobileRuntime(win), true);
  assert.equal(forcedMobilePlatform(win), "android");
  assert.equal(sessionStorage.getItem(ATHENA_FORCE_MOBILE_STORAGE_KEY), "true");
  assert.equal(
    sessionStorage.getItem(ATHENA_FORCE_MOBILE_PLATFORM_STORAGE_KEY),
    "android"
  );

  win.location = {
    href: "https://localhost:3000/workspace/demo",
    search: "",
  };
  assert.equal(isMobileRuntimeForced(win), true);
  assert.equal(forcedMobilePlatform(win), "android");

  win.location = {
    href: "https://localhost:3000/?mobile=0",
    search: "?mobile=0",
  };
  assert.equal(syncMobileRuntimeOverrideFromUrl(win), false);
  assert.equal(isMobileRuntimeForced(win), false);
  assert.equal(forcedMobilePlatform(win), null);
  assert.equal(sessionStorage.getItem(ATHENA_FORCE_MOBILE_STORAGE_KEY), null);
});

test("forced mobile defaults to iOS PWA semantics when platform is omitted", () => {
  const win = testWindow({
    href: "https://localhost:3000/workspace/demo?mobile=1",
  });

  assert.equal(isMobileRuntimeForced(win), true);
  assert.equal(forcedMobilePlatform(win), "ios");
});

test("navigator detection still handles real mobile devices", () => {
  assert.equal(
    detectMobileRuntimeFromNavigator(
      testWindow({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        platform: "iPhone",
        maxTouchPoints: 5,
        innerWidth: 390,
        coarsePointer: true,
      })
    ),
    true
  );

  assert.equal(
    detectMobileRuntimeFromNavigator(
      testWindow({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)",
        platform: "MacIntel",
        maxTouchPoints: 0,
        innerWidth: 1440,
        coarsePointer: false,
      })
    ),
    false
  );
});

test("iPad is detected as tablet but does not enter mobile runtime by default", () => {
  const modernIPad = testWindow({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    platform: "MacIntel",
    maxTouchPoints: 5,
    innerWidth: 820,
    coarsePointer: true,
  });
  assert.equal(detectMobileRuntimeFromNavigator(modernIPad), false);
  assert.equal(isMobileRuntime(modernIPad), false);

  const legacyIPad = testWindow({
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    platform: "iPad",
    maxTouchPoints: 5,
    innerWidth: 820,
    coarsePointer: true,
  });
  assert.equal(detectMobileRuntimeFromNavigator(legacyIPad), false);
  assert.equal(isMobileRuntime(legacyIPad), false);
});

test("iPad can still enter mobile runtime through explicit force-mobile URL", () => {
  const win = testWindow({
    href: "https://localhost:3000/?athenaMobile=1&athenaPlatform=ios",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    platform: "iPad",
    maxTouchPoints: 5,
    innerWidth: 820,
    coarsePointer: true,
  });

  assert.equal(isMobileRuntimeForced(win), true);
  assert.equal(isMobileRuntime(win), true);
  assert.equal(forcedMobilePlatform(win), "ios");
});
