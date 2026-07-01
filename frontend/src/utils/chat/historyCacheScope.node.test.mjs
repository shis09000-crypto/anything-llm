import test from "node:test";
import assert from "node:assert/strict";
import {
  historyCacheScope,
  normalizeHistoryCacheDetail,
  normalizeHistoryCacheSurface,
} from "./historyCacheScope.js";

test("history cache detail keeps light and full entries separate", () => {
  assert.equal(normalizeHistoryCacheDetail("light"), "light");
  assert.equal(normalizeHistoryCacheDetail("full"), "full");
  assert.equal(normalizeHistoryCacheDetail("other"), "light");
});

test("history cache surface keeps mobile and desktop entries separate", () => {
  assert.equal(normalizeHistoryCacheSurface("desktop"), "desktop");
  assert.equal(normalizeHistoryCacheSurface("mobile"), "mobile");
  assert.equal(normalizeHistoryCacheSurface("prefetch"), "desktop");
});

test("history cache scope normalizes cache key dimensions", () => {
  assert.deepEqual(historyCacheScope({ detail: "full", surface: "mobile" }), {
    detail: "full",
    surface: "mobile",
  });
  assert.deepEqual(historyCacheScope({ detail: "light", surface: "desktop" }), {
    detail: "light",
    surface: "desktop",
  });
});
