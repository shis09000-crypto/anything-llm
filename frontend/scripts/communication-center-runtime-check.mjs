#!/usr/bin/env node
/* global AbortController, Blob, Event, EventTarget, FormData, TextDecoder, URL, clearTimeout, console, fetch, process, setTimeout */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("../../", import.meta.url).pathname);
const communicationDir = path.join(
  repoRoot,
  "frontend",
  "src",
  "lib",
  "communication"
);

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] || fallback;
  return fallback;
}

const apiBase = argValue("api-base", "http://localhost:3002/api").replace(
  /\/$/,
  ""
);
const includeDebugSmoke = argValue("debug-smoke", "true") !== "false";
const includeRealSmoke = argValue("real-smoke", "true") !== "false";
const concurrency = Number(argValue("concurrency", "12"));
const email = process.env.ATHENA_TEST_EMAIL || process.env.EMAIL || "";
const password = process.env.ATHENA_TEST_PASSWORD || process.env.PASSWORD || "";

const summary = {
  startedAt: new Date().toISOString(),
  apiBase,
  includeDebugSmoke,
  includeRealSmoke,
  concurrency,
  results: [],
};

function record(name, passed, details = {}) {
  summary.results.push({
    name,
    passed: Boolean(passed),
    ...details,
  });
}

function redact(value) {
  if (!value) return value;
  return String(value).slice(0, 4) + "...redacted";
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function loadCommunicationModules() {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "athena-comm-runtime-")
  );
  const files = [
    "apiError.js",
    "apiClient.js",
    "uploadClient.js",
    "blobClient.js",
    "fileClient.js",
    "streamClient.js",
    "webSocketClient.js",
    "agentWebSocketProtocol.js",
    "agentWebSocketClient.js",
  ];

  await Promise.all(
    files.map(async (file) => {
      const source = await fs.readFile(
        path.join(communicationDir, file),
        "utf8"
      );
      await fs.writeFile(
        path.join(tmpDir, file),
        transformSource(file, source),
        "utf8"
      );
    })
  );

  const [
    apiClient,
    uploadClient,
    blobClient,
    fileClient,
    streamClient,
    apiError,
    agentWebSocketClient,
  ] = await Promise.all([
    import(pathToFileURL(path.join(tmpDir, "apiClient.js")).href),
    import(pathToFileURL(path.join(tmpDir, "uploadClient.js")).href),
    import(pathToFileURL(path.join(tmpDir, "blobClient.js")).href),
    import(pathToFileURL(path.join(tmpDir, "fileClient.js")).href),
    import(pathToFileURL(path.join(tmpDir, "streamClient.js")).href),
    import(pathToFileURL(path.join(tmpDir, "apiError.js")).href),
    import(pathToFileURL(path.join(tmpDir, "agentWebSocketClient.js")).href),
  ]);

  return {
    tmpDir,
    apiClient,
    uploadClient,
    blobClient,
    fileClient,
    streamClient,
    apiError,
    agentWebSocketClient,
  };
}

function transformSource(file, source) {
  let next = source
    .replace(
      /import\s+\{\s*API_BASE\s*\}\s+from\s+"@\/utils\/constants";/,
      `const API_BASE = ${JSON.stringify(apiBase)};`
    )
    .replace(
      /import\s+\{\s*baseHeaders\s*\}\s+from\s+"@\/utils\/request";/,
      "const baseHeaders = () => globalThis.__ATHENA_TEST_BASE_HEADERS__ || {};"
    )
    .replace(
      /import\s+\{\s*CODEX_DEV_AUTH_BYPASS_KEY,\s*CODEX_DEV_AUTH_BYPASS_QUERY,\s*isCodexDevAuthBypassEnabled,\s*\}\s+from\s+"@\/utils\/codexDevAuthBypass";/,
      `const CODEX_DEV_AUTH_BYPASS_KEY = "codexDevAuthBypass";
const CODEX_DEV_AUTH_BYPASS_QUERY = "codexDevAuthBypass";
const isCodexDevAuthBypassEnabled = () => false;`
    )
    .replace(
      /import\s+\{\s*getAuthToken\s*\}\s+from\s+"@\/utils\/authTokenStorage";/,
      `const getAuthToken = () => {
  const authorization = globalThis.__ATHENA_TEST_BASE_HEADERS__?.Authorization || "";
  return authorization.replace(/^Bearer\\s+/i, "") || null;
};`
    )
    .replace(
      /import\s+\{\s*clearSensitiveClientSession\s*\}\s+from\s+"@\/utils\/security\/clearSensitiveClientState";/,
      "const clearSensitiveClientSession = () => {};"
    )
    .replace(
      /import\s+\{\s*assertSecureHttpUrl\s*\}\s+from\s+"\.\/transportSecurity";/,
      "const assertSecureHttpUrl = (url) => url;"
    )
    .replace(
      /import\s+\{\s*assertSecureWebSocketUrl\s*\}\s+from\s+"\.\/transportSecurity";/,
      "const assertSecureWebSocketUrl = (url) => url;"
    )
    .replace(
      /import\s+\{\s*webSocketOriginForHttpBase\s*\}\s+from\s+"\.\/transportSecurity";/,
      `const webSocketOriginForHttpBase = (base) =>
  String(base || "").replace(/^https:/, "wss:").replace(/^http:/, "ws:");`
    )
    .replace(
      /import\s+\{\s*createCommunicationRequestId,\s*resetClientIdentity,\s*withClientIdentityHeaders,\s*\}\s+from\s+"\.\/clientIdentity";/,
      `const createCommunicationRequestId = () => \`runtime-req-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
const resetClientIdentity = () => {};
const withClientIdentityHeaders = (headers = {}) => ({ ...headers, "X-Athena-Client-Id": "runtime-client" });`
    )
    .replace(
      /import\s+\{\s*createCommunicationRequestId,\s*shouldAttachClientIdentityToUrl,\s*withClientIdentityHeaders,\s*\}\s+from\s+"\.\/clientIdentity";/,
      `const createCommunicationRequestId = () => \`runtime-req-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
const shouldAttachClientIdentityToUrl = () => true;
const withClientIdentityHeaders = (headers = {}) => ({ ...headers, "X-Athena-Client-Id": "runtime-client" });`
    )
    .replace(
      /import\s+\{\s*createCommunicationRequestId\s*\}\s+from\s+"\.\/clientIdentity";/,
      `const createCommunicationRequestId = () => \`runtime-req-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;`
    )
    .replace(
      /import\s+\{\s*appendClientIdentityQueryParams\s*\}\s+from\s+"\.\/clientIdentity";/,
      "const appendClientIdentityQueryParams = (url) => ({ url });"
    )
    .replace(
      /import\s+\{\s*clearSigningSecretCache,\s*isRecoverableSigningError,\s*maybeSignedRequestHeaders,\s*\}\s+from\s+"\.\/requestSigningClient";/,
      `const clearSigningSecretCache = () => {};
const isRecoverableSigningError = () => false;
const maybeSignedRequestHeaders = async ({ headers = {} } = {}) => headers;`
    )
    .replace(
      /import\s+\{\s*signedWebSocketEnvelope\s*\}\s+from\s+"\.\/requestSigningClient";/,
      "const signedWebSocketEnvelope = async ({ payload }) => ({ payload, signature: null });"
    )
    .replace(
      /import\s+\{\s*clearSigningSecretCache,\s*isRecoverableSigningError,\s*\}\s+from\s+"\.\/requestSigningClient";/,
      `const clearSigningSecretCache = () => {};
const isRecoverableSigningError = () => false;`
    )
    .replace(
      /import\s+\{\s*communicationByteLength,\s*communicationResponseSize,\s*recordCommunicationEvent,\s*\}\s+from\s+"\.\/communicationMetrics";/,
      `const communicationByteLength = (value = "") => String(value || "").length;
const communicationResponseSize = () => 0;
const recordCommunicationEvent = () => {};`
    )
    .replace(
      /import\s+\{\s*communicationByteLength,\s*recordCommunicationEvent,\s*\}\s+from\s+"\.\/communicationMetrics";/,
      `const communicationByteLength = (value = "") => String(value || "").length;
const recordCommunicationEvent = () => {};`
    )
    .replace(
      /import\s+\{\s*communicationResponseSize,\s*recordCommunicationEvent,\s*\}\s+from\s+"\.\/communicationMetrics";/,
      `const communicationResponseSize = () => 0;
const recordCommunicationEvent = () => {};`
    )
    .replaceAll("import.meta.env.DEV", "true")
    .replaceAll("import.meta.env.VITE_API_BASE", JSON.stringify(apiBase));

  if (file !== "apiError.js") {
    next = next.replaceAll('from "./apiError"', 'from "./apiError.js"');
  }
  if (file === "uploadClient.js") {
    next = next.replaceAll('from "./apiClient"', 'from "./apiClient.js"');
  }
  if (file === "blobClient.js") {
    next = next.replaceAll('from "./apiError"', 'from "./apiError.js"');
  }
  if (file === "fileClient.js") {
    next = next
      .replaceAll('from "./apiClient"', 'from "./apiClient.js"')
      .replaceAll('from "./blobClient"', 'from "./blobClient.js"')
      .replaceAll('from "./apiError"', 'from "./apiError.js"');
  }
  if (file === "streamClient.js") {
    next = next
      .replace(
        /import\s+\{\s*fetchEventSource\s*\}\s+from\s+"@microsoft\/fetch-event-source";/,
        "const fetchEventSource = (...args) => globalThis.__ATHENA_TEST_FETCH_EVENT_SOURCE__(...args);"
      )
      .replaceAll('from "./apiClient"', 'from "./apiClient.js"')
      .replaceAll('from "./apiError"', 'from "./apiError.js"');
  }
  if (file === "agentWebSocketProtocol.js") {
    next = next
      .replace(
        /import\s+\{\s*dispatchThreadRename\s*\}\s+from\s+"@\/utils\/chat";/,
        "const dispatchThreadRename = () => {};"
      )
      .replace(
        /import\s+\{\s*debugChatTurn\s*\}\s+from\s+"@\/utils\/chat\/debug";/,
        "const debugChatTurn = () => {};"
      )
      .replace(
        /import\s+\{\s*safeJsonParse\s*\}\s+from\s+"@\/utils\/request";/,
        `const safeJsonParse = (value, fallback = null) => {
          try { return JSON.parse(value); } catch { return fallback; }
        };`
      );
  }
  if (file === "agentWebSocketClient.js") {
    next = next
      .replace(
        /import\s+\{\s*useEffect,\s*useState\s*\}\s+from\s+"react";/,
        "const useEffect = () => {}; const useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}];"
      )
      .replaceAll('from "./apiClient"', 'from "./apiClient.js"')
      .replaceAll('from "./webSocketClient"', 'from "./webSocketClient.js"')
      .replaceAll(
        'from "./agentWebSocketProtocol"',
        'from "./agentWebSocketProtocol.js"'
      )
      .replaceAll("/api/agent-invocation/", "/api/debug/communication/agent/");
  }
  return next;
}

async function login() {
  if (!email || !password) return null;
  const response = await fetch(`${apiBase}/request-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
  });
  const data = await response.json();
  if (!data?.valid || !data?.token) {
    throw new Error(`Login failed with status ${response.status}`);
  }
  return { token: data.token, user: data.user };
}

async function runCase(name, fn) {
  const startedAt = Date.now();
  try {
    const details = await fn();
    record(name, true, { durationMs: Date.now() - startedAt, ...details });
  } catch (error) {
    record(name, false, {
      durationMs: Date.now() - startedAt,
      error: error.message,
      details: error.details || null,
      code: error.code || null,
      status: error.status || null,
    });
  }
}

async function expectReject(fn, predicate) {
  try {
    await fn();
  } catch (error) {
    assert(predicate(error), `Unexpected rejection: ${error.message}`, {
      code: error.code,
      status: error.status,
      details: error.details,
    });
    return error;
  }
  throw new Error("Expected rejection but request succeeded.");
}

function installFetchEventSourceShim() {
  globalThis.__ATHENA_TEST_FETCH_EVENT_SOURCE__ = async (url, options = {}) => {
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: options.headers,
        body: options.body,
        signal: options.signal,
      });
      await options.onopen?.(response);
      if (!response.ok) return;

      const reader = response.body?.getReader?.();
      if (!reader) return;
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          await options.onmessage?.({ data });
        }
      }
      const tail = `${buffer}${decoder.decode()}`.trim();
      if (tail) {
        const data = tail
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) await options.onmessage?.({ data });
      }
      options.onclose?.();
    } catch (error) {
      await options.onerror?.(error);
      throw error;
    }
  };
}

function installBrowserGlobals() {
  const eventTarget = new EventTarget();
  if (!globalThis.CustomEvent) {
    globalThis.CustomEvent = class CustomEvent extends Event {
      constructor(type, options = {}) {
        super(type, options);
        this.detail = options.detail;
      }
    };
  }

  globalThis.window = {
    location: {
      protocol: "http:",
      host: "localhost:3000",
    },
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
  };
}

async function runClientChecks(modules) {
  const {
    apiClient,
    uploadClient,
    blobClient,
    fileClient,
    streamClient,
    apiError,
  } = modules;
  const debug = "/debug/communication";

  await runCase("json_success_request_id", async () => {
    const result = await apiClient.postJson(`${debug}/json`, {
      scenario: "ok",
    });
    assert(result.data?.success === true, "JSON success body mismatch");
    assert(Boolean(result.requestId), "Missing client requestId");
    return {
      requestId: result.requestId,
      serverRequestId: result.data.requestId,
    };
  });

  await runCase("json_http_error", async () => {
    const error = await expectReject(
      () => apiClient.getJson(`${debug}/json?status=503`),
      (err) =>
        err.code === apiError.API_ERROR_CODES.HTTP_OPEN_ERROR &&
        err.status === 503
    );
    return { code: error.code, status: error.status };
  });

  await runCase("json_malformed_body", async () => {
    const result = await apiClient.getJson(`${debug}/json?scenario=malformed`);
    assert(
      result.data?.error === "{bad-json",
      "Malformed JSON fallback body mismatch",
      { data: result.data }
    );
    return { requestId: result.requestId, errorBody: result.data.error };
  });

  await runCase("json_timeout", async () => {
    const error = await expectReject(
      () => apiClient.getJson(`${debug}/json?delayMs=120`, { timeoutMs: 20 }),
      (err) => err.code === apiError.API_ERROR_CODES.API_TIMEOUT_ERROR
    );
    return { code: error.code };
  });

  await runCase("json_abort", async () => {
    const controller = new AbortController();
    const promise = apiClient.getJson(`${debug}/json?delayMs=200`, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    const error = await expectReject(
      () => promise,
      (err) => err.name === "AbortError"
    );
    return { abortName: error.name };
  });

  await runCase("upload_success_and_context", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new Blob(["athena upload runtime"], { type: "text/plain" }),
      "runtime.txt"
    );
    formData.append("requestId", "runtime-upload");
    const result = await uploadClient.uploadFormData(
      `${debug}/upload`,
      formData,
      { uploadKind: uploadClient.UPLOAD_KINDS.readerDocument }
    );
    assert(result.data?.success === true, "Upload did not succeed");
    assert(result.data?.size > 0, "Upload size not echoed");
    return { requestId: result.requestId, size: result.data.size };
  });

  await runCase("upload_timeout", async () => {
    const formData = new FormData();
    formData.append("file", new Blob(["slow"]), "slow.txt");
    const error = await expectReject(
      () =>
        uploadClient.uploadFormData(`${debug}/upload?delayMs=120`, formData, {
          timeoutMs: 20,
          uploadKind: "runtime_timeout",
        }),
      (err) => err.code === apiError.API_ERROR_CODES.API_TIMEOUT_ERROR
    );
    return { code: error.code, uploadKind: error.details?.uploadKind };
  });

  await runCase("upload_http_error_context", async () => {
    const formData = new FormData();
    formData.append("file", new Blob(["bad-upload"]), "bad-upload.txt");
    const error = await expectReject(
      () =>
        uploadClient.uploadFormData(`${debug}/upload?status=418`, formData, {
          uploadKind: uploadClient.UPLOAD_KINDS.workspaceFile,
        }),
      (err) =>
        err.code === apiError.API_ERROR_CODES.HTTP_OPEN_ERROR &&
        err.status === 418 &&
        err.details?.uploadKind === uploadClient.UPLOAD_KINDS.workspaceFile
    );
    return {
      code: error.code,
      status: error.status,
      uploadKind: error.details?.uploadKind,
      rawError: error.raw?.error,
    };
  });

  await runCase("blob_headers_and_size", async () => {
    const result = await blobClient.requestBlob(
      `${debug}/blob?sizeBytes=4096&contentType=application/octet-stream&filename=runtime.bin`,
      { blobKind: blobClient.BLOB_KINDS.generatedFile }
    );
    assert(result.blob.size === 4096, "Blob size mismatch");
    const filename = fileClient.getResponseFilename(result.response);
    const contentType = fileClient.getResponseContentType(result.response);
    assert(filename === "runtime.bin", "Filename parse mismatch", {
      filename,
    });
    return { requestId: result.requestId, filename, contentType };
  });

  await runCase("text_download", async () => {
    const result = await blobClient.requestText(`${debug}/text`, {
      blobKind: blobClient.BLOB_KINDS.exportText,
    });
    assert(result.text.startsWith("debug-text:"), "Text body mismatch");
    return { requestId: result.requestId, length: result.text.length };
  });

  await runCase("blob_timeout", async () => {
    const error = await expectReject(
      () =>
        blobClient.requestBlob(`${debug}/blob?delayMs=120`, {
          blobKind: blobClient.BLOB_KINDS.generatedFile,
          timeoutMs: 20,
        }),
      (err) => err.code === apiError.API_ERROR_CODES.API_TIMEOUT_ERROR
    );
    return { code: error.code, blobKind: error.details?.blobKind };
  });

  await runCase("download_stream_split_glued", async () => {
    const events = [];
    const split = await fileClient.postJsonDownloadEventStream(
      `${debug}/sse`,
      { scenario: "split" },
      { onEvent: (event) => events.push(event) }
    );
    const glued = await fileClient.postJsonDownloadEventStream(
      `${debug}/sse`,
      { scenario: "glued" },
      { onEvent: (event) => events.push(event) }
    );
    assert(events.length === 4, "Unexpected event count", { events });
    return {
      splitEvents: split.eventCount,
      gluedEvents: glued.eventCount,
      requestIds: [split.requestId, glued.requestId],
    };
  });

  await runCase("download_stream_parse_error", async () => {
    const error = await expectReject(
      () =>
        fileClient.postJsonDownloadEventStream(
          `${debug}/sse`,
          { scenario: "malformed" },
          {}
        ),
      (err) => err.code === apiError.API_ERROR_CODES.STREAM_PARSE_ERROR
    );
    return { code: error.code };
  });

  await runCase("download_stream_open_error", async () => {
    const error = await expectReject(
      () =>
        fileClient.postJsonDownloadEventStream(
          `${debug}/sse`,
          { scenario: "open_error" },
          {}
        ),
      (err) =>
        err.code === apiError.API_ERROR_CODES.HTTP_OPEN_ERROR &&
        err.status === 503
    );
    return { code: error.code, status: error.status };
  });

  await runCase("download_stream_network_close", async () => {
    const events = [];
    const error = await expectReject(
      () =>
        fileClient.postJsonDownloadEventStream(
          `${debug}/sse`,
          { scenario: "mid_close", events: 6 },
          { onEvent: (event) => events.push(event) }
        ),
      (err) => err.code === apiError.API_ERROR_CODES.STREAM_RUNTIME_ERROR
    );
    return { code: error.code, partialEvents: events.length };
  });

  await runCase("download_stream_late_error_event", async () => {
    const events = [];
    await fileClient.postJsonDownloadEventStream(
      `${debug}/sse`,
      { scenario: "late_error", events: 2 },
      { onEvent: (event) => events.push(event) }
    );
    assert(
      events.some((event) => event.type === "error"),
      "Late error event was not delivered"
    );
    return { eventCount: events.length };
  });

  await runCase("chat_sse_stream_success_and_parse_error", async () => {
    const events = [];
    await streamClient.postJsonSse({
      path: `${debug}/sse`,
      body: { events: 3 },
      onMessage: (event) => events.push(event),
    });
    assert(events.length === 3, "SSE event count mismatch", { events });
    const error = await expectReject(
      () =>
        streamClient.postJsonSse({
          path: `${debug}/sse`,
          body: { scenario: "malformed" },
        }),
      (err) => err.code === apiError.API_ERROR_CODES.STREAM_PARSE_ERROR
    );
    return { eventCount: events.length, parseCode: error.code };
  });

  await runCase("chat_sse_open_error_and_runtime_close", async () => {
    const openError = await expectReject(
      () =>
        streamClient.postJsonSse({
          path: `${debug}/sse`,
          body: { scenario: "open_error" },
        }),
      (err) =>
        err.code === apiError.API_ERROR_CODES.HTTP_OPEN_ERROR &&
        err.status === 503
    );

    const events = [];
    const runtimeError = await expectReject(
      () =>
        streamClient.postJsonSse({
          path: `${debug}/sse`,
          body: { scenario: "mid_close", events: 6 },
          onMessage: (event) => events.push(event),
        }),
      (err) => err.code === apiError.API_ERROR_CODES.STREAM_RUNTIME_ERROR
    );

    return {
      openCode: openError.code,
      runtimeCode: runtimeError.code,
      partialEvents: events.length,
    };
  });

  await runCase("mixed_concurrency", async () => {
    const tasks = Array.from({ length: concurrency }, (_, index) => {
      if (index % 3 === 0) {
        return apiClient.getJson(`${debug}/json?sizeBytes=128`);
      }
      if (index % 3 === 1) {
        return blobClient.requestText(`${debug}/text`, {
          blobKind: "runtime_concurrency",
        });
      }
      return fileClient.postJsonDownloadEventStream(
        `${debug}/sse`,
        { events: 5 },
        {}
      );
    });
    const results = await Promise.all(tasks);
    assert(
      results.every((result) => result.requestId),
      "Missing requestId"
    );
    return { requests: results.length };
  });
}

async function runAgentWebSocketChecks(modules) {
  const { agentWebSocketClient } = modules;
  const debugUuid = `debug-comm-${Date.now()}`;

  await runCase("agent_websocket_debug_final", async () => {
    if (typeof WebSocket !== "function") {
      return { skipped: true, reason: "missing_websocket_global" };
    }

    const events = [];
    const protocolEvents = [];
    const states = [];
    const finals = [];

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Agent debug websocket timed out.")),
        2_000
      );

      agentWebSocketClient.createAgentWebSocketSession({
        websocketUUID: debugUuid,
        silenceTimeoutMs: 1_000,
        onEvent: (event) => {
          events.push(event);
          return event;
        },
        onProtocolEvent: (event) => protocolEvents.push(event),
        onState: (state) => states.push(state),
        onFinal: (chatId, normalized, applied, snapshot) => {
          finals.push({ chatId, normalized, applied, snapshot });
        },
        onError: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        onClose: () => {
          clearTimeout(timeout);
          resolve();
        },
      });
    });

    const stateNames = states.map((state) => state.state);
    assert(stateNames.includes("open"), "Agent websocket never opened", {
      stateNames,
    });
    assert(stateNames.includes("closed"), "Agent websocket did not close", {
      stateNames,
    });
    assert(finals.length === 1, "Agent final count mismatch", { finals });
    assert(
      finals[0]?.chatId === "debug-chat-id",
      "Agent final chatId mismatch",
      { finals }
    );
    assert(
      events.some((event) => event.type === "assistant_delta"),
      "Agent delta was not emitted",
      { events }
    );
    assert(
      protocolEvents.every((event) => event.raw),
      "Agent protocol events did not preserve raw payload",
      { protocolEvents }
    );

    return {
      stateTransitions: stateNames,
      eventCount: events.length,
      protocolEventCount: protocolEvents.length,
      finalChatId: finals[0]?.chatId,
      finalPublicChatId: finals[0]?.snapshot?.finalPublicChatId,
    };
  });
}

async function runRealSmoke(modules, auth) {
  if (!includeRealSmoke || !auth?.token) {
    record("real_smoke_skipped", true, {
      reason: includeRealSmoke ? "missing_auth" : "disabled",
    });
    return;
  }

  globalThis.__ATHENA_TEST_BASE_HEADERS__ = {
    Authorization: `Bearer ${auth.token}`,
  };

  const { apiClient, uploadClient, blobClient } = modules;

  await runCase("real_workspaces_json", async () => {
    const result = await apiClient.getJson("/workspaces");
    const count = Array.isArray(result.data?.workspaces)
      ? result.data.workspaces.length
      : 0;
    assert(count > 0, "No workspaces returned");
    return { count, requestId: result.requestId };
  });

  await runCase("real_logo_blob", async () => {
    const result = await blobClient.requestBlob("/system/logo?theme=default", {
      includeBaseHeaders: false,
      blobKind: blobClient.BLOB_KINDS.logo,
    });
    assert(result.response.status === 200, "Logo status mismatch");
    assert(result.blob.size > 0, "Logo blob is empty");
    return {
      requestId: result.requestId,
      contentType: result.response.headers.get("content-type"),
      isCustomLogo: result.response.headers.get("x-is-custom-logo"),
    };
  });

  await runCase("real_reader_upload_blob_delete", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new Blob(["# Athena communication runtime check\n"], {
        type: "text/markdown",
      }),
      "athena-communication-runtime.md"
    );
    const upload = await uploadClient.uploadFormData(
      "/reader-documents/upload",
      formData,
      { uploadKind: uploadClient.UPLOAD_KINDS.readerDocument }
    );
    const readerDocumentId = upload.data?.readerDocumentId;
    assert(readerDocumentId, "Reader upload did not return id");

    try {
      const original = await blobClient.requestBlob(
        `/reader-documents/${readerDocumentId}/original`,
        { blobKind: blobClient.BLOB_KINDS.readerOriginal }
      );
      assert(original.blob.size > 0, "Reader original blob is empty");
      return {
        readerDocumentId,
        uploadRequestId: upload.requestId,
        originalRequestId: original.requestId,
        originalType: original.blob.type,
      };
    } finally {
      await apiClient
        .deleteJson(`/reader-documents/${readerDocumentId}`)
        .catch(() => null);
    }
  });
}

async function main() {
  if (!globalThis.fetch) {
    throw new Error("Node.js fetch is required.");
  }

  installFetchEventSourceShim();
  installBrowserGlobals();
  const modules = await loadCommunicationModules();
  let auth = null;
  try {
    auth = await login();
    record("login", true, {
      userId: auth.user?.id ?? null,
      token: redact(auth.token),
    });
  } catch (error) {
    record("login", false, { error: error.message });
  }

  globalThis.__ATHENA_TEST_BASE_HEADERS__ = auth?.token
    ? { Authorization: `Bearer ${auth.token}` }
    : {};

  if (includeDebugSmoke) {
    await runClientChecks(modules);
    await runAgentWebSocketChecks(modules);
  } else {
    record("debug_smoke_skipped", true, {
      reason: "disabled",
    });
  }
  await runRealSmoke(modules, auth);

  summary.completedAt = new Date().toISOString();
  summary.passed = summary.results.every((result) => result.passed);
  console.log(JSON.stringify(summary, null, 2));

  await fs.rm(modules.tmpDir, { recursive: true, force: true });
  process.exit(summary.passed ? 0 : 1);
}

main().catch((error) => {
  summary.completedAt = new Date().toISOString();
  summary.passed = false;
  summary.fatal = error.message;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
});
