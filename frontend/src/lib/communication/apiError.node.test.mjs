import assert from "node:assert/strict";
import test from "node:test";

import { isApiAbortError } from "./apiError.js";

test("recognizes direct and wrapped abort errors without classifying real failures", () => {
  assert.equal(
    isApiAbortError(new DOMException("Task aborted or stale.", "AbortError")),
    true
  );
  assert.equal(isApiAbortError({ raw: { name: "AbortError" } }), true);
  assert.equal(isApiAbortError({ code: "ABORT_ERR" }), true);
  assert.equal(
    isApiAbortError({ status: 503, message: "Service unavailable" }),
    false
  );
});
