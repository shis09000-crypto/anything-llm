import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceUrl = new URL("./chatStreamObservability.js", import.meta.url);

test("Agent reconnect observations preserve run kind, transport, and invocation metadata", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chat-stream-observability-")
  );
  try {
    const calls = [];
    globalThis.__chatObservationPostJson = async (...args) => {
      calls.push(args);
      return { data: { success: true } };
    };
    globalThis.window = {
      matchMedia: () => ({ matches: false }),
      setTimeout: () => 1,
      clearTimeout: () => {},
      addEventListener: () => {},
    };
    globalThis.document = {
      hidden: false,
      addEventListener: () => {},
    };

    const source = await readFile(sourceUrl, "utf8");
    const target = path.join(temporaryDirectory, "chatStreamObservability.js");
    await writeFile(
      target,
      source.replace(
        'import { postJson } from "./apiClient";',
        "const postJson = (...args) => globalThis.__chatObservationPostJson(...args);"
      ),
      "utf8"
    );
    const mod = await import(`${pathToFileURL(target).href}?${Date.now()}`);

    mod.recordChatStreamReconnect("turn-agent", "recovered", 1, {
      runKind: "agent",
      transport: "ledger_poll",
      invocationId: "invocation-agent",
    });
    await mod.flushChatStreamObservations();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1].observations, [
      {
        event: "reconnect_recovered",
        clientTurnId: "turn-agent",
        requestId: "",
        durationMs: 1,
        outcome: "recovered",
        runKind: "agent",
        transport: "ledger_poll",
        invocationId: "invocation-agent",
        platform: "desktop_web",
        visibility: "visible",
      },
    ]);
  } finally {
    delete globalThis.__chatObservationPostJson;
    delete globalThis.window;
    delete globalThis.document;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
