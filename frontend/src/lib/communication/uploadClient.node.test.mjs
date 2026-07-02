import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import * as apiError from "./apiError.js";

const uploadClientUrl = new URL("./uploadClient.js", import.meta.url);

async function loadUploadClient({ dev = false } = {}) {
  const source = await readFile(uploadClientUrl, "utf8");
  globalThis.__uploadClientTestDev = dev;
  globalThis.__uploadClientTestApiError = apiError;
  globalThis.__uploadClientTestApiClient = {
    apiUrl: (path = "") => `/api${path.startsWith("/") ? path : `/${path}`}`,
    formDataHeaders: (
      headers = {},
      { includeBaseHeaders = true, requestId } = {}
    ) => ({
      ...(includeBaseHeaders ? { Authorization: "Bearer upload-token" } : {}),
      ...headers,
      "X-Athena-Client-Id": "client-upload-test",
      "X-Athena-Request-Id": requestId,
    }),
    parseJsonResponse: async (response) => {
      const text = await response.text().catch(() => "");
      return text ? JSON.parse(text) : null;
    },
  };
  globalThis.__uploadClientTestIdentity = {
    createCommunicationRequestId: () => "req-upload-test",
  };
  globalThis.__uploadClientTestMetrics = {
    communicationResponseSize: () => 0,
    recordCommunicationEvent: () => {},
  };
  globalThis.__uploadClientTestTaskRequestMetadata = {
    runScheduledTaskRequest: (operation, request = {}) =>
      operation({ signal: request.signal, handle: null }),
  };

  const transformed = source
    .replace(
      'import { apiUrl, formDataHeaders, parseJsonResponse } from "./apiClient";',
      "const { apiUrl, formDataHeaders, parseJsonResponse } = globalThis.__uploadClientTestApiClient;"
    )
    .replace(
      'import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";',
      "const { API_ERROR_CODES, createApiError, normalizeApiError } = globalThis.__uploadClientTestApiError;"
    )
    .replace(
      'import { createCommunicationRequestId } from "./clientIdentity";',
      "const { createCommunicationRequestId } = globalThis.__uploadClientTestIdentity;"
    )
    .replace(
      /import\s+\{\s*communicationResponseSize,\s*recordCommunicationEvent,\s*\}\s+from\s+"\.\/communicationMetrics";/,
      "const { communicationResponseSize, recordCommunicationEvent } = globalThis.__uploadClientTestMetrics;"
    )
    .replace(
      'import { runScheduledTaskRequest } from "@/utils/tasks/taskRequestMetadata";',
      "const { runScheduledTaskRequest } = globalThis.__uploadClientTestTaskRequestMetadata;"
    )
    .replaceAll("import.meta.env.DEV", "globalThis.__uploadClientTestDev");

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("uploadFormData does not set Content-Type and returns requestId", async () => {
  const originalFetch = globalThis.fetch;
  let receivedUrl;
  let receivedInit;
  globalThis.fetch = async (url, init) => {
    receivedUrl = url;
    receivedInit = init;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  try {
    const { uploadFormData } = await loadUploadClient();
    const formData = new FormData();
    formData.append("file", new Blob(["hello"]), "hello.txt");
    const result = await uploadFormData("/workspace/demo/upload", formData, {
      uploadKind: "workspace_file",
    });

    assert.equal(receivedUrl, "/api/workspace/demo/upload");
    assert.equal(receivedInit.method, "POST");
    assert.equal(receivedInit.headers.Authorization, "Bearer upload-token");
    assert.equal(
      receivedInit.headers["X-Athena-Client-Id"],
      "client-upload-test"
    );
    assert.equal(receivedInit.headers["X-Athena-Request-Id"], result.requestId);
    assert.equal(receivedInit.headers["Content-Type"], undefined);
    assert.equal(receivedInit.body, formData);
    assert.equal(receivedInit.signal, undefined);
    assert.deepEqual(result.data, { success: true });
    assert.equal(typeof result.requestId, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploadFormData DEV logs include upload context", async () => {
  const originalFetch = globalThis.fetch;
  const originalDebug = console.debug;
  const logs = [];

  console.debug = (...args) => logs.push(args);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 });

  try {
    const { uploadFormData } = await loadUploadClient({ dev: true });
    const result = await uploadFormData(
      "/reader-documents/upload",
      new FormData(),
      {
        uploadKind: "reader_document",
      }
    );
    const startLog = logs.find((entry) => entry[0] === "[uploadClient] start");
    const successLog = logs.find(
      (entry) => entry[0] === "[uploadClient] success"
    );

    assert.ok(startLog);
    assert.ok(successLog);
    assert.equal(startLog[1].requestId, result.requestId);
    assert.equal(successLog[1].requestId, result.requestId);
    assert.equal(successLog[1].uploadKind, "reader_document");
    assert.equal(successLog[1].path, "/reader-documents/upload");
    assert.equal(successLog[1].result, "success");
    assert.equal(typeof successLog[1].durationMs, "number");
  } finally {
    globalThis.fetch = originalFetch;
    console.debug = originalDebug;
  }
});

test("uploadFormData preserves HTTP error body and upload context", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "bad upload" }), { status: 500 });

  try {
    const { uploadFormData } = await loadUploadClient();
    await assert.rejects(
      uploadFormData("/system/upload-logo", new FormData(), {
        uploadKind: "logo",
      }),
      (error) =>
        error.code === apiError.API_ERROR_CODES.HTTP_OPEN_ERROR &&
        error.status === 500 &&
        error.raw?.error === "bad upload" &&
        error.details?.uploadKind === "logo" &&
        error.details?.path === "/system/upload-logo" &&
        error.details?.message === "bad upload"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploadFormData can skip base headers", async () => {
  const originalFetch = globalThis.fetch;
  let receivedInit;
  globalThis.fetch = async (_url, init) => {
    receivedInit = init;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };

  try {
    const { uploadFormData } = await loadUploadClient();
    await uploadFormData("/public/upload", new FormData(), {
      includeBaseHeaders: false,
    });
    assert.equal(receivedInit.headers.Authorization, undefined);
    assert.equal(
      receivedInit.headers["X-Athena-Client-Id"],
      "client-upload-test"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploadFormData maps explicit timeoutMs to API_TIMEOUT_ERROR", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      );
    });

  try {
    const { uploadFormData } = await loadUploadClient();
    await assert.rejects(
      uploadFormData("/workspace/demo/upload", new FormData(), {
        uploadKind: "workspace_file",
        timeoutMs: 1,
      }),
      (error) =>
        error.code === apiError.API_ERROR_CODES.API_TIMEOUT_ERROR &&
        error.details?.uploadKind === "workspace_file" &&
        error.details?.timeoutMs === 1
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploadFormData preserves external AbortError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      );
    });

  try {
    const { uploadFormData } = await loadUploadClient();
    const controller = new AbortController();
    const promise = uploadFormData("/workspace/demo/upload", new FormData(), {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(promise, (error) => error.name === "AbortError");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
