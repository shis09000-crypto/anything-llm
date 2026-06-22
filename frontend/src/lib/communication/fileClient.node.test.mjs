import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import * as apiError from "./apiError.js";

const fileClientUrl = new URL("./fileClient.js", import.meta.url);

function jsonHeaders(headers = {}, { includeBaseHeaders = true } = {}) {
  return {
    ...(includeBaseHeaders ? { Authorization: "Bearer file-token" } : {}),
    "Content-Type": "application/json",
    ...headers,
  };
}

async function loadFileClient({ dev = false } = {}) {
  const source = await readFile(fileClientUrl, "utf8");
  globalThis.__fileClientTestDev = dev;
  globalThis.__fileClientTestApiError = apiError;
  globalThis.__fileClientTestApiClient = { jsonHeaders };
  globalThis.__fileClientTestBlobClient = {
    BLOB_KINDS: {
      generatedFile: "generated_file",
      exportText: "export_text",
      modelDownloadStream: "model_download_stream",
    },
    downloadUrl: (path = "") =>
      `/api${path.startsWith("/") ? path : `/${path}`}`,
    requestBlob: async (path, options) => ({
      path,
      options,
      response: new Response("blob"),
      blob: new Blob(["blob"]),
      requestId: "blob-request",
    }),
    requestText: async (path, options) => ({
      path,
      options,
      response: new Response("text"),
      text: "text",
      requestId: "text-request",
    }),
  };

  const transformed = source
    .replace(
      'import { jsonHeaders } from "./apiClient";',
      "const { jsonHeaders } = globalThis.__fileClientTestApiClient;"
    )
    .replace(
      /import\s+\{\s*BLOB_KINDS,\s*downloadUrl,\s*requestBlob,\s*requestText,\s*\}\s+from\s+"\.\/blobClient";/,
      "const { BLOB_KINDS, downloadUrl, requestBlob, requestText } = globalThis.__fileClientTestBlobClient;"
    )
    .replace(
      'import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";',
      "const { API_ERROR_CODES, createApiError, normalizeApiError } = globalThis.__fileClientTestApiError;"
    )
    .replaceAll("import.meta.env.DEV", "globalThis.__fileClientTestDev");

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

function streamResponse(chunks, options = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (options.error) controller.error(options.error);
        else controller.close();
      },
    }),
    { status: 200 }
  );
}

test("header helpers parse filename and content type", async () => {
  const { getResponseContentType, getResponseFilename } =
    await loadFileClient();

  assert.equal(
    getResponseFilename(
      new Response("", {
        headers: { "Content-Disposition": 'attachment; filename="report.csv"' },
      })
    ),
    "report.csv"
  );
  assert.equal(
    getResponseFilename(
      new Response("", {
        headers: {
          "Content-Disposition":
            "attachment; filename*=UTF-8''hello%20world.pdf",
        },
      })
    ),
    "hello world.pdf"
  );
  assert.equal(getResponseFilename(new Response("")), null);
  assert.equal(
    getResponseContentType(
      new Response("", { headers: { "Content-Type": "text/csv" } })
    ),
    "text/csv"
  );
});

test("download wrappers pass file kinds to blob client", async () => {
  const { downloadBlobFile, downloadTextFile } = await loadFileClient();
  const blobResult = await downloadBlobFile("/files/demo.csv");
  const textResult = await downloadTextFile("/system/export-chats");

  assert.equal(blobResult.options.blobKind, "generated_file");
  assert.equal(textResult.options.blobKind, "export_text");
});

test("postJsonDownloadEventStream parses split chunks, glued events, and blank lines", async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  let receivedInit;
  globalThis.fetch = async (_url, init) => {
    receivedInit = init;
    return streamResponse([
      'data: {"type":"pro',
      'gress","percentage":10}\n\n',
      "\n",
      'data: {"type":"progress","percentage":20}\n\ndata: {"type":"success"}\n\n',
    ]);
  };

  try {
    const { postJsonDownloadEventStream } = await loadFileClient();
    const result = await postJsonDownloadEventStream(
      "/utils/dmr/download-model",
      { modelId: "demo" },
      { onEvent: (event) => events.push(event) }
    );

    assert.equal(receivedInit.method, "POST");
    assert.equal(receivedInit.headers.Authorization, "Bearer file-token");
    assert.equal(receivedInit.headers["Content-Type"], "application/json");
    assert.equal(receivedInit.body, JSON.stringify({ modelId: "demo" }));
    assert.deepEqual(events, [
      { type: "progress", percentage: 10 },
      { type: "progress", percentage: 20 },
      { type: "success" },
    ]);
    assert.equal(result.eventCount, 3);
    assert.equal(typeof result.requestId, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postJsonDownloadEventStream maps malformed JSON to STREAM_PARSE_ERROR", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamResponse(["data: {nope}\n\n"]);

  try {
    const { postJsonDownloadEventStream } = await loadFileClient();
    await assert.rejects(
      postJsonDownloadEventStream("/utils/dmr/download-model", {}),
      (error) =>
        error.code === apiError.API_ERROR_CODES.STREAM_PARSE_ERROR &&
        error.details?.blobKind === "model_download_stream" &&
        error.raw?.block.includes("{nope}")
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postJsonDownloadEventStream preserves abort and maps network close", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      );
    });

  try {
    const { postJsonDownloadEventStream } = await loadFileClient();
    const controller = new AbortController();
    const promise = postJsonDownloadEventStream(
      "/utils/dmr/download-model",
      {},
      { signal: controller.signal }
    );
    controller.abort();
    await assert.rejects(promise, (error) => error.name === "AbortError");
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () =>
    streamResponse(['data: {"type":"progress","percentage":1}\n\n'], {
      error: new Error("socket closed"),
    });

  try {
    const { postJsonDownloadEventStream } = await loadFileClient();
    await assert.rejects(
      postJsonDownloadEventStream("/utils/dmr/download-model", {}),
      (error) => error.code === apiError.API_ERROR_CODES.STREAM_RUNTIME_ERROR
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postJsonDownloadEventStream maps HTTP and timeout errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "bad stream" }), { status: 500 });

  try {
    const { postJsonDownloadEventStream } = await loadFileClient();
    await assert.rejects(
      postJsonDownloadEventStream("/utils/dmr/download-model", {}),
      (error) =>
        error.code === apiError.API_ERROR_CODES.HTTP_OPEN_ERROR &&
        error.raw?.error === "bad stream"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      );
    });

  try {
    const { postJsonDownloadEventStream } = await loadFileClient();
    await assert.rejects(
      postJsonDownloadEventStream(
        "/utils/dmr/download-model",
        {},
        { timeoutMs: 1 }
      ),
      (error) =>
        error.code === apiError.API_ERROR_CODES.API_TIMEOUT_ERROR &&
        error.details?.timeoutMs === 1
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
