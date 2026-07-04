import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import * as apiError from "./apiError.js";

const blobClientUrl = new URL("./blobClient.js", import.meta.url);

async function loadBlobClient({ dev = false, apiBase = "/api" } = {}) {
  const source = await readFile(blobClientUrl, "utf8");
  globalThis.__blobClientTestDev = dev;
  globalThis.__blobClientTestApiBase = apiBase;
  globalThis.__blobClientTestBaseHeaders = () => ({
    Authorization: "Bearer blob-token",
  });
  globalThis.__blobClientTestApiError = apiError;
  globalThis.__blobClientTestTransportSecurity = {
    assertSecureHttpUrl: (url) => url,
  };
  globalThis.__blobClientTestIdentity = {
    createCommunicationRequestId: () => "req-blob-test",
    shouldAttachClientIdentityToUrl: (url) =>
      !String(url).startsWith("https://cdn.example.test"),
    withClientIdentityHeaders: (headers = {}, { requestId } = {}) => ({
      ...headers,
      "X-Athena-Client-Id": "client-blob-test",
      "X-Athena-Request-Id": requestId,
    }),
  };
  globalThis.__blobClientTestMetrics = {
    communicationByteLength: (value = "") => String(value || "").length,
    recordCommunicationEvent: () => {},
  };
  globalThis.__blobClientTestTaskRequestMetadata = {
    runScheduledTaskRequest: (operation, request = {}) =>
      operation({ signal: request.signal, handle: null }),
  };
  globalThis.__blobClientTestRecovery = {
    recoveryCenter: {
      handle(error, context = {}) {
        const result = {
          classification:
            error?.code === "API_TIMEOUT_ERROR" ? "retryable" : "fatal",
          shouldRetry: error?.code === "API_TIMEOUT_ERROR",
          shouldRollback: false,
          shouldToast: false,
          shouldReauth: false,
          silent: false,
          userMessage: null,
          recoveryAction: error?.code === "API_TIMEOUT_ERROR" ? "retry" : null,
        };
        error.recovery = result;
        globalThis.__blobClientTestRecovery.last = { error, context, result };
        return result;
      },
    },
  };

  const transformed = source
    .replace(
      'import { API_BASE } from "@/utils/constants";',
      "const API_BASE = globalThis.__blobClientTestApiBase;"
    )
    .replace(
      'import { baseHeaders } from "@/utils/request";',
      "const baseHeaders = globalThis.__blobClientTestBaseHeaders;"
    )
    .replace(
      'import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";',
      "const { API_ERROR_CODES, createApiError, normalizeApiError } = globalThis.__blobClientTestApiError;"
    )
    .replace(
      'import { assertSecureHttpUrl } from "./transportSecurity";',
      "const { assertSecureHttpUrl } = globalThis.__blobClientTestTransportSecurity;"
    )
    .replace(
      /import\s+\{\s*createCommunicationRequestId,\s*shouldAttachClientIdentityToUrl,\s*withClientIdentityHeaders,\s*\}\s+from\s+"\.\/clientIdentity";/,
      "const { createCommunicationRequestId, shouldAttachClientIdentityToUrl, withClientIdentityHeaders } = globalThis.__blobClientTestIdentity;"
    )
    .replace(
      /import\s+\{\s*communicationByteLength,\s*recordCommunicationEvent,\s*\}\s+from\s+"\.\/communicationMetrics";/,
      "const { communicationByteLength, recordCommunicationEvent } = globalThis.__blobClientTestMetrics;"
    )
    .replace(
      'import { runScheduledTaskRequest } from "@/utils/tasks/taskRequestMetadata";',
      "const { runScheduledTaskRequest } = globalThis.__blobClientTestTaskRequestMetadata;"
    )
    .replace(
      'import { recoveryCenter } from "@/utils/recovery/recoveryCenter";',
      "const { recoveryCenter } = globalThis.__blobClientTestRecovery;"
    )
    .replaceAll("import.meta.env.DEV", "globalThis.__blobClientTestDev");

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("requestBlob returns response, blob, and requestId with readable headers", async () => {
  const originalFetch = globalThis.fetch;
  let receivedUrl;
  let receivedInit;
  globalThis.fetch = async (url, init) => {
    receivedUrl = url;
    receivedInit = init;
    return new Response(new Blob(["avatar"], { type: "image/png" }), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "X-Is-Custom-Logo": "true",
      },
    });
  };

  try {
    const { requestBlob } = await loadBlobClient();
    const result = await requestBlob("/system/logo", { blobKind: "logo" });

    assert.equal(receivedUrl, "/api/system/logo");
    assert.equal(receivedInit.headers.Authorization, "Bearer blob-token");
    assert.equal(
      receivedInit.headers["X-Athena-Client-Id"],
      "client-blob-test"
    );
    assert.equal(receivedInit.headers["X-Athena-Request-Id"], result.requestId);
    assert.equal(result.response.headers.get("X-Is-Custom-Logo"), "true");
    assert.equal(result.response.headers.get("Content-Type"), "image/png");
    assert.equal(await result.blob.text(), "avatar");
    assert.equal(typeof result.requestId, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestText returns response, text, and DEV logs with blobKind", async () => {
  const originalFetch = globalThis.fetch;
  const originalDebug = console.debug;
  const logs = [];
  console.debug = (...args) => logs.push(args);
  globalThis.fetch = async () =>
    new Response("a,b\n1,2", {
      status: 200,
      headers: { "Content-Type": "text/csv" },
    });

  try {
    const { requestText } = await loadBlobClient({ dev: true });
    const result = await requestText("/system/export-chats", {
      blobKind: "export_text",
    });
    const startLog = logs.find((entry) => entry[0] === "[blobClient] start");
    const successLog = logs.find(
      (entry) => entry[0] === "[blobClient] success"
    );

    assert.equal(result.text, "a,b\n1,2");
    assert.ok(startLog);
    assert.ok(successLog);
    assert.equal(successLog[1].requestId, result.requestId);
    assert.equal(successLog[1].blobKind, "export_text");
    assert.equal(successLog[1].status, 200);
    assert.equal(typeof successLog[1].durationMs, "number");
  } finally {
    globalThis.fetch = originalFetch;
    console.debug = originalDebug;
  }
});

test("requestBlob preserves HTTP JSON/text error body and blob context", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "missing file" }), { status: 404 });

  try {
    const { requestBlob } = await loadBlobClient();
    await assert.rejects(
      requestBlob("/agent-skills/generated-files/demo.csv", {
        blobKind: "generated_file",
      }),
      (error) =>
        error.code === apiError.API_ERROR_CODES.HTTP_OPEN_ERROR &&
        error.status === 404 &&
        error.raw?.error === "missing file" &&
        error.details?.blobKind === "generated_file" &&
        error.details?.path === "/agent-skills/generated-files/demo.csv"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestBlob supports absolute and /api URLs without double prefix", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  const headers = [];
  globalThis.fetch = async (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    return new Response("ok", { status: 200 });
  };

  try {
    const { requestBlob } = await loadBlobClient({
      apiBase: "http://localhost:3002/api",
    });
    await requestBlob("/api/workspace/demo/visual-assets/1");
    await requestBlob("https://cdn.example.test/file.png", {
      includeBaseHeaders: false,
    });

    assert.equal(
      urls[0],
      "http://localhost:3002/api/workspace/demo/visual-assets/1"
    );
    assert.equal(urls[1], "https://cdn.example.test/file.png");
    assert.equal(headers[0]["X-Athena-Client-Id"], "client-blob-test");
    assert.equal(headers[1]["X-Athena-Client-Id"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestBlob maps explicit timeoutMs and preserves external AbortError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      );
    });

  try {
    const { requestBlob } = await loadBlobClient();
    await assert.rejects(
      requestBlob("/slow", { blobKind: "reader_preview", timeoutMs: 1 }),
      (error) =>
        error.code === apiError.API_ERROR_CODES.API_TIMEOUT_ERROR &&
        error.details?.blobKind === "reader_preview" &&
        error.details?.timeoutMs === 1 &&
        error.recovery?.classification === "retryable"
    );

    const controller = new AbortController();
    const promise = requestBlob("/abort", { signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, (error) => error.name === "AbortError");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
