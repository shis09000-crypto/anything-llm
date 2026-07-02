import test from "node:test";
import assert from "node:assert/strict";
import { cryptoSectionScrollEnabled } from "./sectionScrollRuntime.js";

test("desktop fine pointer enables crypto section scroll when wide enough", () => {
  assert.equal(
    cryptoSectionScrollEnabled({
      desktopWidthMatches: true,
      finePointer: true,
    }),
    true
  );
});

test("tablet desktop runtime enables crypto section scroll on tablet width", () => {
  assert.equal(
    cryptoSectionScrollEnabled({
      tabletWidthMatches: true,
      tabletDesktop: true,
      finePointer: false,
    }),
    true
  );
});

test("phone and reduced motion disable crypto section scroll", () => {
  assert.equal(
    cryptoSectionScrollEnabled({
      tabletWidthMatches: true,
      tabletDesktop: false,
      finePointer: false,
    }),
    false
  );
  assert.equal(
    cryptoSectionScrollEnabled({
      desktopWidthMatches: true,
      tabletWidthMatches: true,
      tabletDesktop: true,
      finePointer: true,
      reducedMotion: true,
    }),
    false
  );
});
