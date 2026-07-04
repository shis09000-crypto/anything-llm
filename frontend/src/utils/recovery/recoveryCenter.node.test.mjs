import test from "node:test";
import assert from "node:assert/strict";
import {
  API_ERROR_CODES,
  createApiError,
} from "../../lib/communication/apiError.js";
import { recoveryCenter } from "./recoveryCenter.js";

test.beforeEach(() => {
  recoveryCenter.resetForTests();
});

test("classifies AbortError and stale task as silent", () => {
  const abort = recoveryCenter.handle(
    new DOMException("Aborted", "AbortError"),
    { source: "task", taskId: "task-1", aborted: true }
  );
  assert.equal(abort.classification, "silent");
  assert.equal(abort.silent, true);
  assert.equal(abort.shouldToast, false);

  const stale = recoveryCenter.handle(new Error("Task stale"), {
    source: "task",
    taskId: "task-2",
    stale: true,
  });
  assert.equal(stale.classification, "silent");
  assert.equal(stale.silent, true);
});

test("classifies timeout and network errors as retryable", () => {
  const timeout = recoveryCenter.handle(
    createApiError({
      code: API_ERROR_CODES.API_TIMEOUT_ERROR,
      message: "Request timed out after 1000ms.",
      details: { timeoutMs: 1000 },
    }),
    { source: "communication", requestId: "req-timeout" }
  );
  assert.equal(timeout.classification, "retryable");
  assert.equal(timeout.shouldRetry, true);

  const network = recoveryCenter.handle(new Error("Failed to fetch"), {
    source: "communication",
    requestId: "req-network",
  });
  assert.equal(network.classification, "retryable");
  assert.equal(network.shouldRetry, true);
});

test("classifies auth, permission, and signing recovery errors", () => {
  const reauth = recoveryCenter.handle(
    createApiError({ status: 401, message: "Session expired" }),
    { source: "communication" }
  );
  assert.equal(reauth.classification, "reauth");
  assert.equal(reauth.shouldReauth, true);

  const permission = recoveryCenter.handle(
    createApiError({ status: 403, message: "Forbidden" }),
    { source: "communication" }
  );
  assert.equal(permission.classification, "permission");

  const invalidSignature = recoveryCenter.handle(
    createApiError({
      status: 401,
      code: API_ERROR_CODES.INVALID_SIGNATURE,
      message: "INVALID_SIGNATURE",
    }),
    { source: "communication", retryAttempt: 0 }
  );
  assert.equal(invalidSignature.classification, "retryable");
  assert.equal(invalidSignature.shouldRetry, true);
  assert.equal(invalidSignature.recoveryAction, "refresh-signing-secret");

  const revoked = recoveryCenter.handle(
    createApiError({
      status: 403,
      code: API_ERROR_CODES.CLIENT_REVOKED,
      message: "CLIENT_REVOKED",
    }),
    { source: "communication" }
  );
  assert.equal(revoked.classification, "permission");
  assert.equal(revoked.recoveryAction, "clear-signing-cache/client-identity");
});

test("optimistic action failures rollback once and dedupe repeated toast", () => {
  let rollbackCount = 0;
  let toastCount = 0;
  const context = {
    source: "optimistic-action",
    actionId: "optimistic-1",
    scope: { surface: "test" },
    rollback: () => {
      rollbackCount += 1;
    },
    toast: {
      error: () => {
        toastCount += 1;
      },
    },
  };

  const first = recoveryCenter.handle(new Error("save failed"), context);
  const second = recoveryCenter.handle(new Error("save failed"), context);

  assert.equal(first.classification, "rollback");
  assert.equal(first.rollbackExecuted, true);
  assert.equal(second.rollbackExecuted, false);
  assert.equal(second.toastDeduped, true);
  assert.equal(rollbackCount, 1);
  assert.equal(toastCount, 1);
});

test("silent optimistic stale can rollback without toast and report recovery", () => {
  let rollbackCount = 0;
  let observed = null;

  const result = recoveryCenter.handle(new Error("Task stale"), {
    source: "optimistic-action",
    actionId: "optimistic-stale",
    stale: true,
    rollbackOnSilent: true,
    rollback: () => {
      rollbackCount += 1;
    },
    onRecovery: (recovery) => {
      observed = recovery;
    },
  });

  assert.equal(result.classification, "silent");
  assert.equal(result.silent, true);
  assert.equal(result.shouldRollback, true);
  assert.equal(result.rollbackExecuted, true);
  assert.equal(result.shouldToast, false);
  assert.equal(rollbackCount, 1);
  assert.equal(observed?.classification, "silent");
});

test("retryable optimistic network failure keeps rollback and retry semantics", () => {
  const result = recoveryCenter.handle(new Error("Failed to fetch"), {
    source: "optimistic-action",
    actionId: "optimistic-retry",
    retry: () => {},
    rollback: () => {},
  });

  assert.equal(result.classification, "rollback");
  assert.equal(result.shouldRollback, true);
  assert.equal(result.shouldRetry, true);
  assert.equal(result.retryAvailable, true);
  assert.equal(result.recoveryAction, "retry");
});

test("background reader postprocess failures do not request foreground toast", () => {
  const result = recoveryCenter.handle(
    createApiError({
      code: API_ERROR_CODES.API_TIMEOUT_ERROR,
      message: "postprocess timed out",
      details: { path: "/reader-documents/demo/postprocess" },
    }),
    {
      source: "reader",
      background: true,
      activityId: "reader-postprocess-demo",
    }
  );

  assert.equal(result.classification, "background");
  assert.equal(result.shouldToast, false);
});
