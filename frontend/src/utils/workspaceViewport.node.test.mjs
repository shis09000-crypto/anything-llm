import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceViewportFrame } from "./workspaceViewport.js";

test("workspace viewport uses the full tablet frame without a keyboard", () => {
  assert.deepEqual(
    resolveWorkspaceViewportFrame({
      innerHeight: 1180,
      visualViewport: { height: 1180, offsetTop: 0 },
    }),
    { height: 1180, offsetTop: 0, keyboardInset: 0 }
  );
});
test("workspace viewport follows the visible iPad frame above the keyboard", () => {
  assert.deepEqual(
    resolveWorkspaceViewportFrame({
      innerHeight: 1180,
      visualViewport: { height: 724.4, offsetTop: 12.2 },
    }),
    { height: 724, offsetTop: 12, keyboardInset: 443 }
  );
});

test("workspace viewport falls back to layout dimensions", () => {
  assert.deepEqual(
    resolveWorkspaceViewportFrame({
      innerHeight: 800.3,
      visualViewport: null,
    }),
    { height: 800, offsetTop: 0, keyboardInset: 0 }
  );
});
