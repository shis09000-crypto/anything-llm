import test from "node:test";
import assert from "node:assert/strict";
import { nextTrustedAvatar } from "./accountAvatarState.js";

test("transient avatar refresh cannot clear the last trusted avatar", () => {
  assert.equal(
    nextTrustedAvatar("data:image/png;base64,old", null),
    "data:image/png;base64,old"
  );
  assert.equal(
    nextTrustedAvatar("data:image/png;base64,old", undefined),
    "data:image/png;base64,old"
  );
});

test("authoritative profile refresh can replace or remove the avatar", () => {
  assert.equal(
    nextTrustedAvatar(
      "data:image/png;base64,old",
      "data:image/png;base64,new",
      {
        authoritative: true,
      }
    ),
    "data:image/png;base64,new"
  );
  assert.equal(
    nextTrustedAvatar("data:image/png;base64,old", null, {
      authoritative: true,
    }),
    null
  );
});
