import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import * as apiError from "./apiError.js";

const apiClientUrl = new URL("./apiClient.js", import.meta.url);

async function loadApiClient({
  dev = false,
  signingOverrides = {},
  sessionRecoveryOverrides = {},
} = {}) {
  const source = await readFile(apiClientUrl, "utf8");
  globalThis.__apiClientTestBaseHeaders = () => ({
    Authorization: "Bearer test-token",
  });
  globalThis.__apiClientTestApiError = apiError;
  globalThis.__apiClientTestDev = dev;
  globalThis.__apiClientTestTransportSecurity = {
    assertSecureHttpUrl: (url) => url,
  };
  globalThis.__apiClientTestIdentity = {
    createCommunicationRequestId: () => "req-api-test",
    resetCalls: [],
    async resetClientIdentity(options = {}) {
      globalThis.__apiClientTestIdentity.resetCalls.push(options);
    },
    withClientIdentityHeaders: (headers = {}, { requestId } = {}) => ({
      ...headers,
      "X-Athena-Client-Id": "client-api-test",
      "X-Athena-Platform": "web",
      "X-Athena-App-Version": "test",
      "X-Athena-Request-Id": requestId,
    }),
  };
  globalThis.__apiClientTestSigning = {
    cleared: 0,
    clearSigningSecretCache: () => {
      globalThis.__apiClientTestSigning.cleared += 1;
    },
    isRecoverableSigningError: (code) =>
      ["INVALID_SIGNATURE", "SIGNING_SECRET_ROTATED"].includes(code),
    maybeSignedRequestHeaders: async () => ({ headers: {}, signed: false }),
    ...signingOverrides,
  };
  globalThis.__apiClientTestSensitiveState = {
    cleared: [],
    clearSensitiveClientSession(options = {}) {
      globalThis.__apiClientTestSensitiveState.cleared.push(options);
    },
  };
  globalThis.__apiClientTestMetrics = {
    events: [],
    communicationByteLength(value = "") {
      return String(value || "").length;
    },
    communicationResponseSize(_response, data) {
      return JSON.stringify(data || "").length;
    },
    recordCommunicationEvent(event) {
      globalThis.__apiClientTestMetrics.events.push(event);
    },
  };
  globalThis.__apiClientTestTaskRequestMetadata = {
    runScheduledTaskRequest: (operation, request = {}) =>
      operation({
        signal: request.signal,
        handle: {
          context: () => ({
            id: "task:test",
            priority: "P1",
            coordinationContext: {
              coordinationRunId: "coordination:test",
              stepId: "step:test",
              center: "task",
              correlationId: "correlation:test",
              causationId: "task:parent",
              deadlineAt: "2099-01-01T00:00:00.000Z",
            },
          }),
        },
      }),
  };
  globalThis.__apiClientTestRecovery = {
    events: [],
    recoveryCenter: {
      handle(error, context = {}) {
        const result = {
          classification:
            error?.code === "API_TIMEOUT_ERROR"
              ? "retryable"
              : error?.code === "CLIENT_REVOKED"
                ? "permission"
                : error?.status === 401
                  ? "reauth"
                  : "fatal",
          shouldRetry: error?.code === "API_TIMEOUT_ERROR",
          shouldRollback: false,
          shouldToast: false,
          shouldReauth: error?.status === 401,
          silent: false,
          userMessage: null,
          recoveryAction:
            error?.code === "CLIENT_REVOKED"
              ? "clear-signing-cache/client-identity"
              : error?.code === "INVALID_SIGNATURE"
                ? "refresh-signing-secret"
                : null,
        };
        error.recovery = result;
        globalThis.__apiClientTestRecovery.events.push({
          error,
          context,
          result,
        });
        return result;
      },
    },
  };
  globalThis.__apiClientTestSessionRecovery = {
    attempts: [],
    async attemptSessionRecovery(options = {}) {
      globalThis.__apiClientTestSessionRecovery.attempts.push(options);
      return {
        recovered: false,
        terminal: true,
        reason: "recovery_binding_missing",
      };
    },
    recoveryReplayAllowed({ method = "GET", headers = {}, task = null } = {}) {
      const normalizedMethod = String(method).toUpperCase();
      return (
        ["GET", "HEAD", "OPTIONS"].includes(normalizedMethod) ||
        Boolean(
          headers["Idempotency-Key"] ||
            headers["idempotency-key"] ||
            task?.sourceActionId ||
            task?.idempotencyKey
        )
      );
    },
    ...sessionRecoveryOverrides,
  };
  globalThis.__apiClientTestAuthLifecycle = {
    redirects: [],
    authReasonFrom({ raw } = {}, fallback = null) {
      return raw?.reasonCode || raw?.reason || raw?.error || fallback;
    },
    isTerminalAuthReason(reason) {
      return [
        "session_expired",
        "session_idle_expired",
        "session_revoked",
        "session_epoch_incompatible",
        "account_disabled",
        "account_suspended",
        "client_revoked",
        "device_identity_reauth",
      ].includes(reason);
    },
    redirectToLogin(options = {}) {
      globalThis.__apiClientTestAuthLifecycle.redirects.push(options);
      return true;
    },
  };

  const transformed = source
    .replace(
      'import { API_BASE } from "@/utils/constants";',
      'const API_BASE = "/api";'
    )
    .replace(
      'import { baseHeaders } from "@/utils/request";',
      "const baseHeaders = globalThis.__apiClientTestBaseHeaders;"
    )
    .replace(
      'import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";',
      "const { API_ERROR_CODES, createApiError, normalizeApiError } = globalThis.__apiClientTestApiError;"
    )
    .replace(
      'import { assertSecureHttpUrl } from "./transportSecurity";',
      "const { assertSecureHttpUrl } = globalThis.__apiClientTestTransportSecurity;"
    )
    .replace(
      /import\s+\{[\s\S]*?\}\s+from\s+"\.\/clientIdentity";/,
      "const { createCommunicationRequestId, resetClientIdentity, withClientIdentityHeaders } = globalThis.__apiClientTestIdentity;"
    )
    .replace(
      /import\s+\{[\s\S]*?\}\s+from\s+"\.\/requestSigningClient";/,
      "const { clearSigningSecretCache, isRecoverableSigningError, maybeSignedRequestHeaders } = globalThis.__apiClientTestSigning;"
    )
    .replace(
      'import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";',
      "const { clearSensitiveClientSession } = globalThis.__apiClientTestSensitiveState;"
    )
    .replace(
      /import\s+\{[\s\S]*?\}\s+from\s+"\.\/communicationMetrics";/,
      "const { communicationByteLength, communicationResponseSize, recordCommunicationEvent } = globalThis.__apiClientTestMetrics;"
    )
    .replace(
      'import { runScheduledTaskRequest } from "@/utils/tasks/taskRequestMetadata";',
      "const { runScheduledTaskRequest } = globalThis.__apiClientTestTaskRequestMetadata;"
    )
    .replace(
      'import { recoveryCenter } from "@/utils/recovery/recoveryCenter";',
      "const { recoveryCenter } = globalThis.__apiClientTestRecovery;"
    )
    .replace(
      /import\s+\{\s*attemptSessionRecovery,\s*recoveryReplayAllowed,?\s*\}\s+from\s+"@\/utils\/authRecoveryCoordinator";/,
      "const { attemptSessionRecovery, recoveryReplayAllowed } = globalThis.__apiClientTestSessionRecovery;"
    )
    .replace(
      /import\s+\{\s*authReasonFrom,\s*isTerminalAuthReason,\s*redirectToLogin,?\s*\}\s+from\s+"@\/utils\/authLifecycleCoordinator";/,
      "const { authReasonFrom, isTerminalAuthReason, redirectToLogin } = globalThis.__apiClientTestAuthLifecycle;"
    )
    .replaceAll("import.meta.env.DEV", "globalThis.__apiClientTestDev");

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("requestJson returns data, requestId, and DEV logs correlated metadata", async () => {
  const originalFetch = globalThis.fetch;
  const originalDebug = console.debug;
  const logs = [];
  const requestMetadata = [];
  let receivedUrl;
  let receivedInit;

  console.debug = (...args) => logs.push(args);
  globalThis.fetch = async (url, init) => {
    receivedUrl = url;
    receivedInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const { requestJson } = await loadApiClient({ dev: true });
    const result = await requestJson("/ping", {
      method: "POST",
      body: { hello: "world" },
      onRequestMetadata: (metadata) => requestMetadata.push(metadata),
    });

    assert.equal(receivedUrl, "/api/ping");
    assert.equal(receivedInit.method, "POST");
    assert.equal(receivedInit.headers.Authorization, "Bearer test-token");
    assert.equal(receivedInit.headers["X-Athena-Client-Id"], "client-api-test");
    assert.equal(receivedInit.headers["X-Athena-Request-Id"], result.requestId);
    assert.equal(receivedInit.headers["X-Athena-Task-Id"], "task:test");
    assert.equal(
      receivedInit.headers["X-Athena-Coordination-Run-Id"],
      "coordination:test"
    );
    assert.equal(receivedInit.headers["X-Athena-Task-Priority"], "P1");
    assert.equal(
      receivedInit.headers["X-Athena-Coordination-Deadline-At"],
      "2099-01-01T00:00:00.000Z"
    );
    assert.equal(
      receivedInit.headers["X-Athena-Coordination-Causation-Id"],
      "task:parent"
    );
    assert.equal(receivedInit.body, JSON.stringify({ hello: "world" }));
    assert.deepEqual(result.data, { ok: true });
    assert.equal(typeof result.requestId, "string");
    assert.deepEqual(requestMetadata, [
      {
        requestId: "req-api-test",
        method: "POST",
        path: "/ping",
        retryAttempt: 0,
      },
    ]);

    const startLog = logs.find((entry) => entry[0] === "[apiClient] start");
    const successLog = logs.find((entry) => entry[0] === "[apiClient] success");
    assert.ok(startLog);
    assert.ok(successLog);
    assert.equal(startLog[1].requestId, result.requestId);
    assert.equal(successLog[1].requestId, result.requestId);
    assert.equal(successLog[1].status, 200);
    assert.equal(typeof successLog[1].durationMs, "number");
  } finally {
    globalThis.fetch = originalFetch;
    console.debug = originalDebug;
  }
});

test("requestJson converts non-ok responses to HTTP_OPEN_ERROR with raw JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "nope" }), { status: 500 });

  try {
    const { requestJson } = await loadApiClient();
    await assert.rejects(
      requestJson("/broken"),
      (error) =>
        error.code === apiError.API_ERROR_CODES.HTTP_OPEN_ERROR &&
        error.status === 500 &&
        error.raw?.error === "nope"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestJson preserves authentication state on Identity capability outage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        error: "identity_capability_unavailable",
        retryable: true,
      }),
      { status: 503 }
    );

  try {
    const { requestJson } = await loadApiClient();
    await assert.rejects(
      requestJson("/workspaces"),
      (error) => error.status === 503 && error.raw?.retryable === true
    );
    assert.deepEqual(globalThis.__apiClientTestSensitiveState.cleared, []);
    assert.deepEqual(globalThis.__apiClientTestIdentity.resetCalls, []);
    assert.deepEqual(globalThis.__apiClientTestSessionRecovery.attempts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestJson maps CLIENT_REVOKED and delegates terminal cleanup", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false, error: "CLIENT_REVOKED" }), {
      status: 403,
    });

  try {
    const { requestJson } = await loadApiClient();
    await assert.rejects(
      requestJson("/client-identity/revoke", {
        method: "POST",
        body: { clientId: "client-api-test" },
      }),
      (error) =>
        error.code === apiError.API_ERROR_CODES.CLIENT_REVOKED &&
        error.status === 403 &&
        error.recovery?.classification === "permission" &&
        error.recovery?.recoveryAction ===
          "clear-signing-cache/client-identity" &&
        globalThis.__apiClientTestSigning.cleared === 1 &&
        globalThis.__apiClientTestIdentity.resetCalls.length === 1 &&
        globalThis.__apiClientTestIdentity.resetCalls[0].rotateDeviceKey ===
          true &&
        globalThis.__apiClientTestAuthLifecycle.redirects.length === 1 &&
        globalThis.__apiClientTestAuthLifecycle.redirects[0].reason ===
          "client_revoked"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestJson preserves auth on an unstructured session mismatch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Session client mismatch." }), {
      status: 401,
    });

  try {
    const { requestJson } = await loadApiClient();
    await assert.rejects(
      requestJson("/system/user"),
      (error) =>
        error.code === apiError.API_ERROR_CODES.HTTP_OPEN_ERROR &&
        error.status === 401
    );
    assert.equal(globalThis.__apiClientTestSigning.cleared, 2);
    assert.equal(globalThis.__apiClientTestIdentity.resetCalls.length, 0);
    assert.equal(globalThis.__apiClientTestSessionRecovery.attempts.length, 1);
    assert.deepEqual(globalThis.__apiClientTestSensitiveState.cleared, []);
    assert.deepEqual(globalThis.__apiClientTestAuthLifecycle.redirects, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestJson clears stale signing secret and retries recoverable signature failures once", async () => {
  const originalFetch = globalThis.fetch;
  const originalSigning = globalThis.__apiClientTestSigning;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(
        JSON.stringify({ success: false, error: "INVALID_SIGNATURE" }),
        { status: 401 }
      );
    }
    return new Response(JSON.stringify({ success: true, retried: true }), {
      status: 200,
    });
  };

  try {
    const { requestJson } = await loadApiClient({
      dev: true,
      signingOverrides: {
        maybeSignedRequestHeaders: async () => ({
          headers: { "X-Athena-Signature": "sig" },
          signed: true,
        }),
      },
    });
    const result = await requestJson("/client-identity/rotate-signing-secret", {
      method: "POST",
      body: { clientId: "client-api-test" },
    });
    assert.deepEqual(result.data, { success: true, retried: true });
    assert.equal(fetchCount, 2);
    assert.equal(globalThis.__apiClientTestSigning.cleared, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__apiClientTestSigning = originalSigning;
  }
});

test("requestJson recovers a mismatched device identity and safely replays GET once", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 2) {
      return new Response(JSON.stringify({ success: true, recovered: true }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: "INVALID_SIGNATURE",
        recovery: "CLIENT_IDENTITY_REAUTH_REQUIRED",
      }),
      { status: 401 }
    );
  };

  try {
    const { requestJson } = await loadApiClient({
      sessionRecoveryOverrides: {
        async attemptSessionRecovery(options = {}) {
          globalThis.__apiClientTestSessionRecovery.attempts.push(options);
          return { recovered: true };
        },
      },
      signingOverrides: {
        maybeSignedRequestHeaders: async () => ({
          headers: { "X-Athena-Signature": "sig" },
          signed: true,
        }),
      },
    });
    const result = await requestJson("/system/user");
    assert.deepEqual(result.data, { success: true, recovered: true });
    assert.equal(fetchCount, 2);
    assert.equal(globalThis.__apiClientTestSigning.cleared, 1);
    assert.deepEqual(globalThis.__apiClientTestSessionRecovery.attempts, [
      { source: "api" },
    ]);
    assert.deepEqual(globalThis.__apiClientTestIdentity.resetCalls, []);
    assert.deepEqual(globalThis.__apiClientTestSensitiveState.cleared, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestJson does not replay an ordinary non-idempotent POST after recovery", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(
      JSON.stringify({
        success: false,
        error: "INVALID_SIGNATURE",
        recovery: "CLIENT_IDENTITY_REAUTH_REQUIRED",
      }),
      { status: 401 }
    );
  };

  try {
    const { requestJson } = await loadApiClient({
      sessionRecoveryOverrides: {
        async attemptSessionRecovery(options = {}) {
          globalThis.__apiClientTestSessionRecovery.attempts.push(options);
          return { recovered: true };
        },
      },
      signingOverrides: {
        maybeSignedRequestHeaders: async () => ({
          headers: { "X-Athena-Signature": "sig" },
          signed: true,
        }),
      },
    });
    await assert.rejects(
      requestJson("/workspace/new", {
        method: "POST",
        body: { name: "Operations" },
      }),
      (error) =>
        error.code === apiError.API_ERROR_CODES.INVALID_SIGNATURE &&
        error.status === 401
    );
    assert.equal(fetchCount, 1);
    assert.deepEqual(globalThis.__apiClientTestIdentity.resetCalls, []);
    assert.deepEqual(globalThis.__apiClientTestSensitiveState.cleared, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestJson falls back to login only after terminal device mismatch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        error: "INVALID_SIGNATURE",
        recovery: "CLIENT_IDENTITY_REAUTH_REQUIRED",
      }),
      { status: 401 }
    );

  try {
    const { requestJson } = await loadApiClient({
      sessionRecoveryOverrides: {
        async attemptSessionRecovery(options = {}) {
          globalThis.__apiClientTestSessionRecovery.attempts.push(options);
          return {
            recovered: false,
            terminal: true,
            reason: "device_key_mismatch",
          };
        },
      },
      signingOverrides: {
        maybeSignedRequestHeaders: async () => ({
          headers: { "X-Athena-Signature": "sig" },
          signed: true,
        }),
      },
    });
    await assert.rejects(requestJson("/system/user"));
    assert.deepEqual(globalThis.__apiClientTestIdentity.resetCalls, []);
    assert.deepEqual(globalThis.__apiClientTestSensitiveState.cleared, []);
    assert.deepEqual(globalThis.__apiClientTestAuthLifecycle.redirects, [
      { reason: "device_identity_reauth" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestJson can skip base headers for unauthenticated JSON requests", async () => {
  const originalFetch = globalThis.fetch;
  let receivedInit;
  globalThis.fetch = async (_url, init) => {
    receivedInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const { requestJson } = await loadApiClient();
    await requestJson("/login", { method: "POST", includeBaseHeaders: false });
    assert.equal(receivedInit.headers.Authorization, undefined);
    assert.equal(receivedInit.headers["Content-Type"], "application/json");
    assert.equal(receivedInit.headers["X-Athena-Client-Id"], "client-api-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestJson maps timeoutMs aborts to API_TIMEOUT_ERROR", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (init.signal.aborted) throw new DOMException("Aborted", "AbortError");
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      );
    });
  };

  try {
    const { requestJson } = await loadApiClient();
    await assert.rejects(
      requestJson("/slow", { timeoutMs: 1 }),
      (error) =>
        error.code === apiError.API_ERROR_CODES.API_TIMEOUT_ERROR &&
        error.details?.timeoutMs === 1 &&
        error.recovery?.classification === "retryable"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestJson preserves external AbortError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (init.signal.aborted) throw new DOMException("Aborted", "AbortError");
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      );
    });
  };

  try {
    const { requestJson } = await loadApiClient();
    const controller = new AbortController();
    const promise = requestJson("/abort", { signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, (error) => error.name === "AbortError");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unwrapJson only delegates success mapping and failure fallback", async () => {
  const { unwrapJson } = await loadApiClient();
  const mapped = await unwrapJson(
    Promise.resolve({
      data: { success: false, message: "business", value: 7 },
    }),
    () => "fallback",
    (data) => data.value
  );
  assert.equal(mapped, 7);

  const failed = await unwrapJson(
    Promise.reject({ raw: { error: "transport" } }),
    (error) => error.raw,
    () => "unused"
  );
  assert.deepEqual(failed, { error: "transport" });
});
