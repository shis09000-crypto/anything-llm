import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const workspaceRealtimeUrl = new URL(
  "./workspaceRealtimeClient.js",
  import.meta.url
);
const quizStreamUrl = new URL("./quizStreamClient.js", import.meta.url);

async function loadWorkspaceRealtimeClient() {
  const source = await readFile(workspaceRealtimeUrl, "utf8");
  globalThis.__nonChatStreamTest = {
    getJsonSse: null,
  };
  const transformed = source.replace(
    'import { getJsonSse } from "./streamClient";',
    "const getJsonSse = (...args) => globalThis.__nonChatStreamTest.getJsonSse(...args);"
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

async function loadQuizStreamClient() {
  const source = await readFile(quizStreamUrl, "utf8");
  globalThis.__nonChatStreamTest = {
    postJsonSse: null,
  };
  const transformed = source.replace(
    'import { postJsonSse } from "./streamClient";',
    "const postJsonSse = (...args) => globalThis.__nonChatStreamTest.postJsonSse(...args);"
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("streamThreadTitleEvents filters rename events and keeps retry behavior", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const mod = await loadWorkspaceRealtimeClient();
    let receivedOptions;
    const renamed = [];
    const errors = [];
    const error = new Error("temporary title stream failure");

    globalThis.__nonChatStreamTest.getJsonSse = async (options) => {
      receivedOptions = options;
      options.onMessage({ action: "noop" });
      options.onMessage({ action: "rename_thread", thread: { slug: "t1" } });
      assert.equal(options.onError(error), 3_000);
    };

    await mod.streamThreadTitleEvents({
      workspaceSlug: "workspace-a",
      onThreadRename: (thread) => renamed.push(thread),
      onError: (err) => errors.push(err),
    });

    assert.equal(
      receivedOptions.path,
      "/workspace/workspace-a/thread-title-events"
    );
    assert.equal(receivedOptions.openWhenHidden, true);
    assert.equal(receivedOptions.retryOnError, true);
    assert.deepEqual(renamed, [{ slug: "t1" }]);
    assert.deepEqual(errors, [error]);
  } finally {
    console.warn = originalWarn;
  }
});

test("streamEmbeddingProgress forwards parsed events and raw messages", async () => {
  const mod = await loadWorkspaceRealtimeClient();
  let receivedOptions;
  const events = [];
  const rawMessages = [];
  const errors = [];
  const error = new Error("embedding stream failed");

  globalThis.__nonChatStreamTest.getJsonSse = async (options) => {
    receivedOptions = options;
    options.onMessage({ type: "chunk_progress" }, { data: "{}" });
    options.onError(error);
  };

  await mod.streamEmbeddingProgress({
    workspaceSlug: "workspace-b",
    onEvent: (event, raw) => {
      events.push(event);
      rawMessages.push(raw);
    },
    onError: (err) => errors.push(err),
  });

  assert.equal(receivedOptions.path, "/workspace/workspace-b/embed-progress");
  assert.deepEqual(events, [{ type: "chunk_progress" }]);
  assert.deepEqual(rawMessages, [{ data: "{}" }]);
  assert.deepEqual(errors, [error]);
});

test("streamQuizSubmit posts answers and forwards stream events", async () => {
  const mod = await loadQuizStreamClient();
  let receivedOptions;
  const events = [];
  const errors = [];
  const error = new Error("quiz stream failed");

  globalThis.__nonChatStreamTest.postJsonSse = async (options) => {
    receivedOptions = options;
    options.onMessage({ type: "quiz_progress" }, { data: "{}" });
    options.onError(error);
  };

  await mod.streamQuizSubmit({
    workspaceSlug: "workspace-c",
    quizId: "quiz-1",
    answers: { q1: "a" },
    onEvent: (event) => events.push(event),
    onError: (err) => errors.push(err),
  });

  assert.equal(
    receivedOptions.path,
    "/workspace/workspace-c/quiz/quiz-1/submit-stream"
  );
  assert.deepEqual(receivedOptions.body, { answers: { q1: "a" } });
  assert.equal(receivedOptions.openWhenHidden, true);
  assert.deepEqual(events, [{ type: "quiz_progress" }]);
  assert.deepEqual(errors, [error]);
});
