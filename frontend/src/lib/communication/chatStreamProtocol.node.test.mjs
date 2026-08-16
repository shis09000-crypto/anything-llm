import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceUrl = new URL("./chatStreamProtocol.js", import.meta.url);

test("response.created binds the reserved public identity before deltas", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chat-stream-protocol-")
  );
  try {
    let source = await readFile(sourceUrl, "utf8");
    source = source.replace(
      /import \{[\s\S]*?\} from "@\/utils\/chat\/debug";/,
      "const debugChatTurn = () => {}; const normalizedEventSummary = value => value; const rawEventSummary = value => value;"
    );
    const target = path.join(temporaryDirectory, "chatStreamProtocol.mjs");
    await writeFile(target, source, "utf8");
    const protocol = await import(
      `${pathToFileURL(target).href}?${Date.now()}`
    );

    const event = protocol.normalizeChatTurnEvent({
      type: "response.created",
      response_id: "response-1",
      response: {
        id: "response-1",
        metadata: {
          chatId: null,
          publicChatId: "chat_88",
          clientTurnId: "turn-88",
        },
      },
    });

    assert.equal(event.type, "response_lifecycle");
    assert.equal(event.status, "response.created");
    assert.equal(event.chatId, null);
    assert.equal(event.publicChatId, "chat_88");
    assert.equal(event.clientTurnId, "turn-88");
    assert.equal(event.responseId, "response-1");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
