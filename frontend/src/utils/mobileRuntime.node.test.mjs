import test from "node:test";
import assert from "node:assert/strict";
import {
  ATHENA_FORCE_MOBILE_PLATFORM_STORAGE_KEY,
  ATHENA_FORCE_MOBILE_STORAGE_KEY,
  detectMobileRuntimeFromNavigator,
  detectPhoneRuntimeFromNavigator,
  detectTabletRuntimeFromNavigator,
  forcedMobilePlatform,
  isMobileRuntime,
  isMobileRuntimeForced,
  mobileShellRuntimeActive,
  syncMobileRuntimeOverrideFromUrl,
  tabletDesktopRuntimeActive,
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
  const iphone = testWindow({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    platform: "iPhone",
    maxTouchPoints: 5,
    innerWidth: 390,
    coarsePointer: true,
  });
  assert.equal(detectPhoneRuntimeFromNavigator(iphone), true);
  assert.equal(detectTabletRuntimeFromNavigator(iphone), false);
  assert.equal(detectMobileRuntimeFromNavigator(iphone), true);
  assert.equal(mobileShellRuntimeActive(iphone), true);

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
  assert.equal(detectTabletRuntimeFromNavigator(modernIPad), true);
  assert.equal(detectPhoneRuntimeFromNavigator(modernIPad), false);
  assert.equal(detectMobileRuntimeFromNavigator(modernIPad), false);
  assert.equal(isMobileRuntime(modernIPad), false);
  assert.equal(mobileShellRuntimeActive(modernIPad), false);
  assert.equal(tabletDesktopRuntimeActive(modernIPad), true);

  const legacyIPad = testWindow({
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    platform: "iPad",
    maxTouchPoints: 5,
    innerWidth: 820,
    coarsePointer: true,
  });
  assert.equal(detectTabletRuntimeFromNavigator(legacyIPad), true);
  assert.equal(detectPhoneRuntimeFromNavigator(legacyIPad), false);
  assert.equal(detectMobileRuntimeFromNavigator(legacyIPad), false);
  assert.equal(isMobileRuntime(legacyIPad), false);
  assert.equal(mobileShellRuntimeActive(legacyIPad), false);
  assert.equal(tabletDesktopRuntimeActive(legacyIPad), true);
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
  assert.equal(mobileShellRuntimeActive(win), true);
  assert.equal(tabletDesktopRuntimeActive(win), false);
  assert.equal(forcedMobilePlatform(win), "ios");
});

test("Android tablets default to desktop shell while Android phones remain mobile", () => {
  const androidTablet = testWindow({
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    platform: "Linux armv8l",
    maxTouchPoints: 10,
    innerWidth: 900,
    coarsePointer: true,
  });
  assert.equal(detectTabletRuntimeFromNavigator(androidTablet), true);
  assert.equal(detectPhoneRuntimeFromNavigator(androidTablet), false);
  assert.equal(isMobileRuntime(androidTablet), false);
  assert.equal(tabletDesktopRuntimeActive(androidTablet), true);

  const androidPhone = testWindow({
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/AP1A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    maxTouchPoints: 5,
    innerWidth: 820,
    coarsePointer: true,
  });
  assert.equal(detectTabletRuntimeFromNavigator(androidPhone), false);
  assert.equal(detectPhoneRuntimeFromNavigator(androidPhone), true);
  assert.equal(isMobileRuntime(androidPhone), true);
  assert.equal(tabletDesktopRuntimeActive(androidPhone), false);
});
