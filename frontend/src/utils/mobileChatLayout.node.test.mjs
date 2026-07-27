import assert from "node:assert/strict";
import test from "node:test";

import {
  MOBILE_COMPOSER_FALLBACK_INSET,
  MOBILE_COMPOSER_MIN_INSET,
  mobileChatPanePaddingBottom,
  mobileNewMessageButtonBottom,
  normalizeMobileComposerInset,
} from "./mobileChatLayout.js";

test("mobile composer inset uses a safe fallback before measurement", () => {
  assert.equal(normalizeMobileComposerInset(undefined), 116);
  assert.equal(normalizeMobileComposerInset(0), 116);
  assert.equal(MOBILE_COMPOSER_FALLBACK_INSET, 116);
});

test("mobile composer inset follows measured expansion without becoming unsafe", () => {
  assert.equal(normalizeMobileComposerInset(63), MOBILE_COMPOSER_MIN_INSET);
  assert.equal(normalizeMobileComposerInset(126.2), 127);
  assert.equal(normalizeMobileComposerInset(188), 188);
});

test("chat padding and new-message control share the measured composer inset", () => {
  assert.equal(
    mobileChatPanePaddingBottom(127),
    "calc(127px + var(--mobile-keyboard-inset, 0px) + 12px)"
  );
  assert.equal(
    mobileNewMessageButtonBottom(127),
    "calc(127px + var(--mobile-keyboard-inset, 0px) + 8px)"
  );
});
