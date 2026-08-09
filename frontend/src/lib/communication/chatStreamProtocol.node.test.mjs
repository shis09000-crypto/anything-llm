import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceUrl = new URL("./chatStreamProtocol.js", import.meta.url);

test("foreground terminal and persistence events remain separate", async () => {
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
    const { normalizeChatStreamEvent } = await import(
      `${pathToFileURL(target).href}?${Date.now()}`
    );

    const terminal = normalizeChatStreamEvent({
      type: "finalizeResponseStream",
      clientTurnId: "turn-1",
      persistenceStatus: "pending",
      close: false,
    });
    assert.equal(terminal.type, "final");
    assert.equal(terminal.payload.persistenceStatus, "pending");
    assert.equal(terminal.payload.close, false);

    const saved = normalizeChatStreamEvent({
      type: "chatPersistence",
      clientTurnId: "turn-1",
      status: "saved",
      chatId: 42,
      publicChatId: "public-42",
    });
    assert.equal(saved.type, "persistence");
    assert.equal(saved.payload.status, "saved");
    assert.equal(saved.payload.chatId, 42);
    assert.equal(saved.payload.publicChatId, "public-42");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
