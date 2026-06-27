import test from "node:test";
import assert from "node:assert/strict";
import {
  createAdaptiveLayoutObserver,
  deriveAdaptiveLayout,
  deriveInputMode,
  deriveLayoutMode,
  deriveSurface,
} from "./adaptiveLayout.js";

test("deriveLayoutMode follows Athena breakpoints", () => {
  assert.equal(deriveLayoutMode({ width: 320 }), "mobile");
  assert.equal(deriveLayoutMode({ width: 767 }), "mobile");
  assert.equal(deriveLayoutMode({ width: 768 }), "tablet");
  assert.equal(deriveLayoutMode({ width: 1199 }), "tablet");
  assert.equal(deriveLayoutMode({ width: 1200 }), "desktop");
});

test("deriveInputMode prefers fine pointer and hover over touch", () => {
  assert.equal(
    deriveInputMode({ touch: true, hover: false, pointer: "coarse" }),
    "touch"
  );
  assert.equal(
    deriveInputMode({ touch: true, hover: true, pointer: "fine" }),
    "mouse"
  );
  assert.equal(
    deriveInputMode({ touch: false, hover: false, pointer: "none" }),
    "mouse"
  );
});

test("deriveAdaptiveLayout normalizes surface names", () => {
  const layout = deriveAdaptiveLayout({
    viewport: { width: 900, height: 700, devicePixelRatio: 2 },
    input: { touch: true, hover: false, pointer: "coarse" },
    surface: "desktopApp",
    capabilities: { clipboard: true },
  });
  assert.equal(layout.layoutMode, "tablet");
  assert.equal(layout.inputMode, "touch");
  assert.equal(layout.surface, "desktop-app");
  assert.equal(deriveSurface("mobileApp"), "mobile-app");
  assert.equal(layout.capabilityProfile.capabilities.clipboard, true);
});

test("createAdaptiveLayoutObserver registers and cleans listeners", () => {
  const listeners = new Map();
  const mediaListeners = [];
  const windowRef = {
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    matchMedia(query) {
      const mql = {
        query,
        matches: false,
        addEventListener(type, handler) {
          mediaListeners.push({ query, type, handler, removed: false });
        },
        removeEventListener(type, handler) {
          const item = mediaListeners.find(
            (entry) =>
              entry.query === query &&
              entry.type === type &&
              entry.handler === handler
          );
          if (item) item.removed = true;
        },
      };
      return mql;
    },
  };
  let width = 1400;
  const emissions = [];
  const observer = createAdaptiveLayoutObserver({
    windowRef,
    getProfile: () => ({
      viewport: { width, height: 800, devicePixelRatio: 1 },
      input: { touch: false, hover: true, pointer: "fine" },
      surface: "browser",
      capabilities: {},
    }),
    onChange: (layout) => emissions.push(layout),
  });

  assert.equal(observer.read().layoutMode, "desktop");
  width = 500;
  listeners.get("resize")();
  assert.equal(emissions.at(-1).layoutMode, "mobile");

  observer.dispose();
  assert.equal(listeners.size, 0);
  assert.ok(mediaListeners.every((entry) => entry.removed));
});
