import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceUrl = new URL("./chatStreamClient.js", import.meta.url);

test("chat stream only reconnects recoverable initial POST failures", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chat-stream-client-")
  );
  try {
    let source = await readFile(sourceUrl, "utf8");
    source = source
      .replace(
        'import { ABORT_STREAM_EVENT, dispatchThreadRename } from "@/utils/chat";',
        'const ABORT_STREAM_EVENT = "abort"; const dispatchThreadRename = () => {};'
      )
      .replace('import { v4 } from "uuid";', 'const v4 = () => "test-id";')
      .replace(
        'import { getJson, postJson } from "./apiClient";',
        "const getJson = async () => ({}); const postJson = async () => {};"
      )
      .replace(
        'import { getJsonSse, postJsonSse } from "./streamClient";',
        "const getJsonSse = async () => {}; const postJsonSse = async () => {};"
      )
      .replace(
        /import \{[\s\S]*?\} from "\.\/chatStreamProtocol";/,
        "const normalizeChatStreamEvent = value => value; const normalizeChatTurnEvent = value => value;"
      )
      .replace(
        'import { preuploadLargeChatAttachments } from "./chatAttachmentClient";',
        "const preuploadLargeChatAttachments = async (_slug, value) => value;"
      )
      .replace(
        /import \{[\s\S]*?\} from "\.\/chatStreamObservability";/,
        "const beginChatStreamObservation = () => {}; const endChatStreamObservation = () => {}; const recordChatStreamReconnect = () => {}; const recordChatStreamRevision = () => {}; const updateChatStreamObservationRequestId = () => {};"
      );
    const target = path.join(temporaryDirectory, "chatStreamClient.mjs");
    await writeFile(target, source, "utf8");
    const mod = await import(`${pathToFileURL(target).href}?${Date.now()}`);

    assert.equal(mod.shouldReconnectInitialChatPost({ status: 0 }), true);
    assert.equal(mod.shouldReconnectInitialChatPost({ status: 503 }), true);
    assert.equal(mod.shouldReconnectInitialChatPost({ status: 429 }), true);
    assert.equal(mod.shouldReconnectInitialChatPost({ status: 401 }), false);
    assert.equal(mod.shouldReconnectInitialChatPost({ status: 403 }), false);
    assert.equal(mod.shouldReconnectInitialChatPost({ status: 404 }), false);
    assert.equal(mod.chatRunClaimProbeResult(), "claimed");
    assert.equal(mod.chatRunClaimProbeResult({ status: 404 }), "missing");
    assert.equal(
      mod.chatRunClaimProbeResult({ code: "chat_stream_run_not_found" }),
      "missing"
    );
    assert.equal(mod.chatRunClaimProbeResult({ status: 503 }), "unknown");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
