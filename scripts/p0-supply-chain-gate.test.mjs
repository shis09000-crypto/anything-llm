import assert from "node:assert/strict";
import test from "node:test";
import {
  auditWithRetry,
  retryableAuditFailure,
} from "./p0-supply-chain-gate.js";

test("supply-chain audit retries a transient registry reset", () => {
  let calls = 0;
  const waits = [];
  const result = auditWithRetry("server", {
    maxAttempts: 3,
    wait: (attempt) => waits.push(attempt),
    run: () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("socket hang up");
        error.retryable = true;
        throw error;
      }
      return { advisories: [], summary: { vulnerabilities: {} } };
    },
  });

  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1]);
});

test("supply-chain audit does not retry policy or parser failures", () => {
  let calls = 0;
  assert.throws(
    () =>
      auditWithRetry("server", {
        maxAttempts: 3,
        wait: () => assert.fail("non-retryable failure must not wait"),
        run: () => {
          calls += 1;
          throw new Error("audit summary schema invalid");
        },
      }),
    /attempts=1/
  );
  assert.equal(calls, 1);
});

test("retry classification is limited to transport availability", () => {
  assert.equal(retryableAuditFailure("socket hang up"), true);
  assert.equal(retryableAuditFailure("ECONNRESET"), true);
  assert.equal(retryableAuditFailure("HTTP Error 503"), true);
  assert.equal(retryableAuditFailure("critical advisory found"), false);
});
