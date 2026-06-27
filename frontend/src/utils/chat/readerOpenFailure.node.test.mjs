import test from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableReaderOpenFailure,
  readerOpenFailureDetails,
  readerOpenFailureStatus,
} from "./readerOpenFailure.js";

test("readerOpenFailureStatus reads status from thrown api errors", () => {
  assert.equal(readerOpenFailureStatus(null, { status: 404 }), 404);
  assert.equal(readerOpenFailureStatus(null, { details: { status: 404 } }), 404);
  assert.equal(readerOpenFailureStatus(null, { raw: { status: 403 } }), 403);
});

test("client reader open failures are terminal and not retryable", () => {
  for (const status of [400, 403, 404]) {
    const details = readerOpenFailureDetails(
      null,
      null,
      { status, message: `Request failed with status ${status}.` },
      "fallback"
    );

    assert.equal(details.status, status);
    assert.equal(details.retryable, false);
    assert.equal(details.terminal, true);
  }
});

test("server and network reader open failures remain retryable", () => {
  assert.equal(isRetryableReaderOpenFailure({ status: 500 }, null), true);
  assert.equal(
    isRetryableReaderOpenFailure(null, new Error("Network failed")),
    true
  );
  assert.equal(isRetryableReaderOpenFailure(null, { status: 0 }), true);
});

test("readerOpenFailureDetails prefers server error payload messages", () => {
  const details = readerOpenFailureDetails(
    { status: 404 },
    { error: "Reader document not found." },
    { message: "Request failed with status 404." },
    "fallback"
  );

  assert.equal(details.message, "Reader document not found.");
  assert.equal(details.retryable, false);
});
