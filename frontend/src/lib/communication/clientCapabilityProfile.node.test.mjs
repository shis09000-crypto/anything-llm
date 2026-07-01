import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const clientCapabilityProfileUrl = new URL(
  "./clientCapabilityProfile.js",
  import.meta.url
);
const mobileRuntimeUrl = new URL(
  "../../utils/mobileRuntime.js",
  import.meta.url
);

async function loadClientCapabilityProfile() {
  const mobileRuntimeSource = await readFile(mobileRuntimeUrl, "utf8");
  globalThis.__clientCapabilityProfileTestMobileRuntime = await import(
    `data:text/javascript;base64,${Buffer.from(mobileRuntimeSource).toString("base64")}#mobile-runtime-${Date.now()}-${Math.random()}`
  );
  const source = (await readFile(clientCapabilityProfileUrl, "utf8")).replace(
    /import\s+\{[\s\S]*?\}\s+from\s+"@\/utils\/mobileRuntime";/,
    "const { detectIPadLikeNavigator, forcedMobilePlatform, mobileRuntimeForced } = globalThis.__clientCapabilityProfileTestMobileRuntime;"
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("getClientCapabilityProfile detects viewport, input, surface, and APIs", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 3,
    matchMedia: (query) => ({
      matches:
        query.includes("pointer: coarse") ||
        query.includes("any-pointer: coarse") ||
        query.includes("display-mode: standalone"),
    }),
    document: { createElement: () => ({}) },
    Notification: function Notification() {},
    navigator: {
      maxTouchPoints: 5,
      standalone: false,
      mediaDevices: { getUserMedia: async () => {} },
      clipboard: { writeText: async () => {} },
    },
  };

  try {
    const mod = await loadClientCapabilityProfile();
    const profile = mod.getClientCapabilityProfile();
    assert.deepEqual(profile.viewport, {
      width: 390,
      height: 844,
      devicePixelRatio: 3,
    });
    assert.deepEqual(profile.input, {
      touch: true,
      hover: false,
      pointer: "coarse",
    });
    assert.equal(profile.surface, "pwa");
    assert.deepEqual(profile.device, {
      formFactor: "desktop",
      family: "desktop-browser",
      os: "unknown",
    });
    assert.deepEqual(profile.capabilities, {
      camera: true,
      microphone: true,
      filePicker: true,
      notifications: true,
      clipboard: true,
    });
    assert.ok(mod.encodeCapabilityProfile(profile));
  } finally {
    globalThis.window = originalWindow;
  }
});

test("getClientCapabilityProfile has SSR-safe fallbacks", async () => {
  const originalWindow = globalThis.window;
  delete globalThis.window;

  try {
    const mod = await loadClientCapabilityProfile();
    const profile = mod.getClientCapabilityProfile();
    assert.deepEqual(profile.viewport, {
      width: 0,
      height: 0,
      devicePixelRatio: 1,
    });
    assert.equal(profile.input.pointer, "none");
    assert.equal(profile.surface, "browser");
    assert.deepEqual(profile.device, {
      formFactor: "desktop",
      family: "desktop-browser",
      os: "unknown",
    });
    assert.equal(profile.capabilities.clipboard, false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("getClientCapabilityProfile identifies iPad as tablet device", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    innerWidth: 820,
    innerHeight: 1180,
    devicePixelRatio: 2,
    matchMedia: (query) => ({
      matches:
        query.includes("pointer: coarse") ||
        query.includes("any-pointer: coarse"),
    }),
    document: { createElement: () => ({}) },
    navigator: {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
  };

  try {
    const mod = await loadClientCapabilityProfile();
    const profile = mod.getClientCapabilityProfile();
    assert.deepEqual(profile.device, {
      formFactor: "tablet",
      family: "ipad",
      os: "ipados",
    });
    assert.equal(profile.surface, "browser");
    assert.equal(profile.input.touch, true);
  } finally {
    globalThis.window = originalWindow;
  }
});
