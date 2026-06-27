import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import * as apiError from "./apiError.js";

const apiClientUrl = new URL("./apiClient.js", import.meta.url);

async function loadApiClient({ dev = false, signingOverrides = {} } = {}) {
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
      /import\s+\{\s*createCommunicationRequestId,\s*withClientIdentityHeaders,\s*\}\s+from\s+"\.\/clientIdentity";/,
      "const { createCommunicationRequestId, withClientIdentityHeaders } = globalThis.__apiClientTestIdentity;"
    )
    .replace(
      /import\s+\{[\s\S]*?\}\s+from\s+"\.\/requestSigningClient";/,
      "const { clearSigningSecretCache, isRecoverableSigningError, maybeSignedRequestHeaders } = globalThis.__apiClientTestSigning;"
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
    });

    assert.equal(receivedUrl, "/api/ping");
    assert.equal(receivedInit.method, "POST");
    assert.equal(receivedInit.headers.Authorization, "Bearer test-token");
    assert.equal(receivedInit.headers["X-Athena-Client-Id"], "client-api-test");
    assert.equal(receivedInit.headers["X-Athena-Request-Id"], result.requestId);
    assert.equal(receivedInit.body, JSON.stringify({ hello: "world" }));
    assert.deepEqual(result.data, { ok: true });
    assert.equal(typeof result.requestId, "string");

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

test("requestJson maps CLIENT_REVOKED and clears signing cache", async () => {
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
        globalThis.__apiClientTestSigning.cleared === 1
    );
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
        error.details?.timeoutMs === 1
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
