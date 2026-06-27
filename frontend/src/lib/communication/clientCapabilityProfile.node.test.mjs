import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const clientCapabilityProfileUrl = new URL(
  "./clientCapabilityProfile.js",
  import.meta.url
);

async function loadClientCapabilityProfile() {
  const source = await readFile(clientCapabilityProfileUrl, "utf8");
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
    assert.equal(profile.capabilities.clipboard, false);
  } finally {
    globalThis.window = originalWindow;
  }
});
