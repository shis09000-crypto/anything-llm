import assert from "node:assert/strict";
import test from "node:test";
import { computeAutoFitFontSize } from "./numericTextFit.js";

test("keeps the current font size when the complete value fits", () => {
  assert.equal(
    computeAutoFitFontSize({
      availableWidth: 240,
      contentWidth: 180,
      defaultFontSize: 24,
    }),
    24
  );
});

test("shrinks proportionally instead of truncating a long value", () => {
  assert.equal(
    computeAutoFitFontSize({
      availableWidth: 120,
      contentWidth: 240,
      defaultFontSize: 24,
    }),
    12
  );
});

test("uses the configured lower bound for extremely long values", () => {
  assert.equal(
    computeAutoFitFontSize({
      availableWidth: 40,
      contentWidth: 800,
      defaultFontSize: 24,
      minimumFontSize: 7,
    }),
    7
  );
});
