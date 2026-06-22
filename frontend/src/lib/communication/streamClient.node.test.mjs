import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const streamClientUrl = new URL("./streamClient.js", import.meta.url);
const apiErrorUrl = new URL("./apiError.js", import.meta.url);

async function loadStreamClient() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "stream-client-"));
  await writeFile(
    path.join(tmpDir, "apiError.js"),
    await readFile(apiErrorUrl, "utf8"),
    "utf8"
  );
  const source = await readFile(streamClientUrl, "utf8");
  await writeFile(
    path.join(tmpDir, "streamClient.js"),
    source
      .replace(
        /import\s+\{\s*fetchEventSource\s*\}\s+from\s+"@microsoft\/fetch-event-source";/,
        "const fetchEventSource = (...args) => globalThis.__streamClientFetchEventSource(...args);"
      )
      .replace(
        /import\s+\{\s*apiUrl,\s*jsonHeaders\s*\}\s+from\s+"\.\/apiClient";/,
        'const apiUrl = (path) => `/api${path.startsWith("/") ? path : `/${path}`}`; const jsonHeaders = () => ({ "Content-Type": "application/json" });'
      )
      .replaceAll('from "./apiError"', 'from "./apiError.js"'),
    "utf8"
  );
  const mod = await import(
    `${pathToFileURL(path.join(tmpDir, "streamClient.js")).href}?${Date.now()}`
  );
  const apiError = await import(
    `${pathToFileURL(path.join(tmpDir, "apiError.js")).href}?${Date.now()}`
  );
  return { mod, apiError, tmpDir };
}

test("postJsonSse maps HTTP open errors", async () => {
  const { mod, apiError, tmpDir } = await loadStreamClient();
  try {
    globalThis.__streamClientFetchEventSource = async (_url, options) => {
      await options.onopen({ ok: false, status: 503 });
    };
    await assert.rejects(
      mod.postJsonSse({
        path: "/debug/stream",
      }),
      (error) => error.code === apiError.API_ERROR_CODES.HTTP_OPEN_ERROR
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("postJsonSse maps malformed messages to STREAM_PARSE_ERROR", async () => {
  const { mod, apiError, tmpDir } = await loadStreamClient();
  try {
    globalThis.__streamClientFetchEventSource = async (_url, options) => {
      await options.onopen({ ok: true, status: 200 });
      await options.onmessage({ data: "{bad-json" });
    };
    await assert.rejects(
      mod.postJsonSse({
        path: "/debug/stream",
      }),
      (error) => error.code === apiError.API_ERROR_CODES.STREAM_PARSE_ERROR
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("postJsonSse maps runtime errors and ignores aborts", async () => {
  const { mod, apiError, tmpDir } = await loadStreamClient();
  try {
    globalThis.__streamClientFetchEventSource = async (_url, options) => {
      options.onerror(new Error("network closed"));
    };
    const errors = [];
    await assert.rejects(
      mod.postJsonSse({
        path: "/debug/stream",
        onError: (error) => errors.push(error),
      }),
      (error) => error.code === apiError.API_ERROR_CODES.STREAM_RUNTIME_ERROR
    );
    assert.equal(errors.length, 1);

    const controller = new AbortController();
    controller.abort();
    globalThis.__streamClientFetchEventSource = async (_url, options) => {
      options.onerror(new DOMException("aborted", "AbortError"));
    };
    await mod.postJsonSse({
      path: "/debug/stream",
      signal: controller.signal,
      onError: () => errors.push("unexpected"),
    });
    assert.equal(errors.length, 1);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("getJsonSse uses GET, forwards raw messages, and supports retry intervals", async () => {
  const { mod, apiError, tmpDir } = await loadStreamClient();
  try {
    const rawMessages = [];
    let receivedUrl;
    let receivedOptions;

    globalThis.__streamClientFetchEventSource = async (url, options) => {
      receivedUrl = url;
      receivedOptions = options;
      await options.onopen({ ok: true, status: 200 });
      await options.onmessage({ data: JSON.stringify({ type: "ready" }) });
      options.onclose();
    };

    const events = [];
    await mod.getJsonSse({
      path: "/debug/get-stream",
      onRawMessage: (msg) => rawMessages.push(msg),
      onMessage: (event) => events.push(event),
    });

    assert.equal(receivedUrl, "/api/debug/get-stream");
    assert.equal(receivedOptions.method, "GET");
    assert.equal(receivedOptions.body, undefined);
    assert.deepEqual(events, [{ type: "ready" }]);
    assert.equal(rawMessages.length, 1);

    globalThis.__streamClientFetchEventSource = async (_url, options) => {
      const retry = options.onerror(
        Object.assign(new Error("temporary"), {
          code: apiError.API_ERROR_CODES.STREAM_RUNTIME_ERROR,
        })
      );
      assert.equal(retry, 3_000);
    };

    await mod.getJsonSse({
      path: "/debug/retry",
      retryOnError: true,
      onError: () => 3_000,
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
