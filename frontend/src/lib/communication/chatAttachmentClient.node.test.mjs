import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceUrl = new URL("./chatAttachmentClient.js", import.meta.url);

test("all images are preuploaded before the Responses turn", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chat-attachment-client-")
  );
  try {
    let source = await readFile(sourceUrl, "utf8");
    source = source
      .replace(
        'import { postJson } from "./apiClient";',
        `const postJson = async (url, body) => {
          globalThis.__attachmentCalls.push({ kind: "json", url, body });
          if (url.endsWith("/complete")) return { data: { attachment: { uploadId: "upload-1", contentObjectId: "object-1", mime: "image/png" } } };
          return { data: { uploadId: "upload-1", partBytes: 1024 } };
        };`
      )
      .replace(
        'import { BLOB_KINDS, requestBlob } from "./blobClient";',
        `const BLOB_KINDS = { chatAttachment: "chat" };
         const requestBlob = async (url, options) => globalThis.__attachmentCalls.push({ kind: "blob", url, options });`
      );
    const target = path.join(temporaryDirectory, "chatAttachmentClient.mjs");
    await writeFile(target, source, "utf8");
    globalThis.__attachmentCalls = [];
    const mod = await import(`${pathToFileURL(target).href}?${Date.now()}`);

    const tinyImage = {
      name: "tiny.png",
      mime: "image/png",
      file: new Blob([Buffer.from("tiny")], { type: "image/png" }),
    };
    const tinyText = {
      name: "tiny.txt",
      mime: "text/plain",
      contentString: Buffer.from("tiny").toString("base64"),
    };
    const output = await mod.preuploadLargeChatAttachments("workspace", [
      tinyImage,
      tinyText,
    ]);

    assert.equal(output[0].contentObjectId, "object-1");
    assert.equal("contentString" in output[0], false);
    assert.equal(output[1], tinyText);
    assert.equal(
      globalThis.__attachmentCalls.filter((call) => call.kind === "blob")
        .length,
      1
    );
  } finally {
    delete globalThis.__attachmentCalls;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
