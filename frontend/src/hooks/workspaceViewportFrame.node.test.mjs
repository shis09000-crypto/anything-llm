import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hookPath = new URL("./useWorkspaceViewportFrame.js", import.meta.url);
const cssPath = new URL("../index.css", import.meta.url);

test("tablet workspace viewport listeners are frame-coalesced and cleaned up", async () => {
  const source = await readFile(hookPath, "utf8");
  assert.match(source, /if \(frame !== null\) return;/);
  assert.match(source, /window\.requestAnimationFrame\(applyFrame\)/);
  assert.match(source, /visualViewport\?\.addEventListener\("resize"/);
  assert.match(source, /visualViewport\?\.removeEventListener\("resize"/);
  assert.match(source, /restoreInlineStyle\(root, previous\.root\)/);
  assert.match(source, /restoreInlineStyle\(body, previous\.body\)/);
});

test("tablet workspace route layers share one visible viewport height", async () => {
  const css = await readFile(cssPath, "utf8");
  assert.match(
    css,
    /html\.athena-workspace-viewport-active \.motion-route-stack[\s\S]*height: var\(--athena-workspace-viewport-height, 100dvh\);/
  );
  assert.match(
    css,
    /html\.athena-workspace-viewport-active \.motion-route-layer[\s\S]*min-height: 0;/
  );
});
