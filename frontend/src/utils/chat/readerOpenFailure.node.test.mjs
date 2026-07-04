import test from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableReaderOpenFailure,
  readerOpenFailureDetails,
  readerOpenFailureResult,
  readerOpenFailureStatus,
} from "./readerOpenFailure.js";

test("readerOpenFailureStatus reads status from thrown api errors", () => {
  assert.equal(readerOpenFailureStatus(null, { status: 404 }), 404);
  assert.equal(
    readerOpenFailureStatus(null, { details: { status: 404 } }),
    404
  );
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

test("readerOpenFailureResult carries reader open stage and scope", () => {
  const failure = readerOpenFailureResult({
    stage: "metadata",
    response: { status: 403 },
    data: { error: "Sensitive reader session is invalid or expired." },
    readerDocumentId: "doc-1",
    workspaceSlug: "workspace-a",
    candidateWorkspaceSlug: "workspace-b",
  });

  assert.equal(failure.ok, false);
  assert.equal(failure.stage, "metadata");
  assert.equal(failure.status, 403);
  assert.equal(failure.retryable, false);
  assert.equal(failure.terminal, true);
  assert.equal(failure.readerDocumentId, "doc-1");
  assert.equal(failure.workspaceSlug, "workspace-a");
  assert.equal(failure.candidateWorkspaceSlug, "workspace-b");
  assert.equal(
    failure.message,
    "Sensitive reader session is invalid or expired."
  );
});
