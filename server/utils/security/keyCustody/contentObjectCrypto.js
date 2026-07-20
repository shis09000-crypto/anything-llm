const crypto = require("crypto");
const fs = require("fs");
const { encryptSecret, decryptSecret } = require("../encryption");

const MAGIC = Buffer.from("ATHOBJ01", "ascii");
const HEADER_BYTES = 20;
const RECORD_OVERHEAD = 4 + 12 + 16;
const ENCRYPTION_VERSION = "athena-content-object:v1";
const DEK_PURPOSE = "content-object-dek";

function additionalData({ objectId, chunkIndex, plaintextSize }) {
  return Buffer.from(
    JSON.stringify({
      version: ENCRYPTION_VERSION,
      objectId,
      chunkIndex,
      plaintextSize,
    }),
    "utf8"
  );
}

function chunkIv(prefix, index) {
  const iv = Buffer.alloc(12);
  prefix.copy(iv, 0);
  iv.writeUInt32BE(index, 8);
  return iv;
}

function encryptContentBuffer({ objectId, plaintext, chunkSize }) {
  const source = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(plaintext);
  const dek = crypto.randomBytes(32);
  const noncePrefix = crypto.randomBytes(8);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(chunkSize, 8);
  header.writeBigUInt64BE(BigInt(source.length), 12);
  const parts = [header];
  const chunkCount = Math.ceil(source.length / chunkSize);

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * chunkSize;
    const chunk = source.subarray(
      start,
      Math.min(start + chunkSize, source.length)
    );
    const iv = chunkIv(noncePrefix, chunkIndex);
    const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(
      additionalData({ objectId, chunkIndex, plaintextSize: source.length })
    );
    const ciphertext = Buffer.concat([cipher.update(chunk), cipher.final()]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(ciphertext.length, 0);
    parts.push(length, iv, cipher.getAuthTag(), ciphertext);
  }

  const encrypted = Buffer.concat(parts);
  return {
    encrypted,
    wrappedDek: encryptSecret(dek.toString("base64url"), {
      purpose: DEK_PURPOSE,
      domain: "content-object",
      resource: objectId,
    }),
    metadata: {
      version: ENCRYPTION_VERSION,
      algorithm: "aes-256-gcm-chunked",
      chunkSize,
      chunkCount,
      noncePrefix: noncePrefix.toString("base64url"),
      plaintextSize: source.length,
    },
    plaintextSha256: crypto.createHash("sha256").update(source).digest("hex"),
    ciphertextSha256: crypto
      .createHash("sha256")
      .update(encrypted)
      .digest("hex"),
  };
}

async function encryptContentFileParts({
  objectId,
  filePaths,
  plaintextSize,
  chunkSize,
  outputPath,
}) {
  const dek = crypto.randomBytes(32);
  const noncePrefix = crypto.randomBytes(8);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(chunkSize, 8);
  header.writeBigUInt64BE(BigInt(plaintextSize), 12);
  const ciphertextHash = crypto.createHash("sha256");
  const output = await fs.promises.open(outputPath, "wx", 0o600);
  let pending = Buffer.alloc(0);
  let chunkIndex = 0;
  let consumed = 0;

  const writeEncryptedChunk = async (chunk) => {
    const iv = chunkIv(noncePrefix, chunkIndex);
    const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(additionalData({ objectId, chunkIndex, plaintextSize }));
    const ciphertext = Buffer.concat([cipher.update(chunk), cipher.final()]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(ciphertext.length, 0);
    const record = Buffer.concat([length, iv, cipher.getAuthTag(), ciphertext]);
    await output.write(record);
    ciphertextHash.update(record);
    chunkIndex += 1;
  };

  try {
    await output.write(header);
    ciphertextHash.update(header);
    for (const filePath of filePaths) {
      for await (const value of fs.createReadStream(filePath)) {
        const incoming = Buffer.from(value);
        consumed += incoming.length;
        pending = pending.length
          ? Buffer.concat([pending, incoming])
          : incoming;
        while (pending.length >= chunkSize) {
          await writeEncryptedChunk(pending.subarray(0, chunkSize));
          pending = pending.subarray(chunkSize);
        }
      }
    }
    if (pending.length) await writeEncryptedChunk(pending);
    if (consumed !== Number(plaintextSize)) {
      const error = new Error("content_object_plaintext_size_mismatch");
      error.code = "CONTENT_OBJECT_PLAINTEXT_SIZE_MISMATCH";
      throw error;
    }
    await output.sync();
  } catch (error) {
    await output.close().catch(() => null);
    await fs.promises.rm(outputPath, { force: true });
    throw error;
  }
  await output.close();
  return {
    outputPath,
    encryptedSize: HEADER_BYTES + plaintextSize + chunkIndex * RECORD_OVERHEAD,
    wrappedDek: encryptSecret(dek.toString("base64url"), {
      purpose: DEK_PURPOSE,
      domain: "content-object",
      resource: objectId,
    }),
    metadata: {
      version: ENCRYPTION_VERSION,
      algorithm: "aes-256-gcm-chunked",
      chunkSize,
      chunkCount: chunkIndex,
      noncePrefix: noncePrefix.toString("base64url"),
      plaintextSize,
    },
    ciphertextSha256: ciphertextHash.digest("hex"),
  };
}

function parseHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES)
    throw new Error("content_object_header_invalid");
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error("content_object_magic_invalid");
  return {
    chunkSize: buffer.readUInt32BE(8),
    plaintextSize: Number(buffer.readBigUInt64BE(12)),
  };
}

function recordOffset(chunkIndex, chunkSize) {
  return HEADER_BYTES + chunkIndex * (RECORD_OVERHEAD + chunkSize);
}

function encryptedRangeForPlaintext({ start, end, chunkSize, plaintextSize }) {
  const safeStart = Math.max(0, Math.min(Number(start || 0), plaintextSize));
  const safeEnd = Math.max(
    safeStart,
    Math.min(end == null ? plaintextSize - 1 : Number(end), plaintextSize - 1)
  );
  const firstChunk = Math.floor(safeStart / chunkSize);
  const lastChunk = Math.floor(safeEnd / chunkSize);
  const firstOffset = recordOffset(firstChunk, chunkSize);
  const lastPlainLength = Math.min(
    chunkSize,
    plaintextSize - lastChunk * chunkSize
  );
  const lastOffset =
    recordOffset(lastChunk, chunkSize) + RECORD_OVERHEAD + lastPlainLength - 1;
  return {
    start: safeStart,
    end: safeEnd,
    firstChunk,
    lastChunk,
    encryptedStart: firstOffset,
    encryptedEnd: lastOffset,
  };
}

function decryptContentRange({
  objectId,
  encrypted,
  encryptedStart,
  wrappedDek,
  metadata,
  start = 0,
  end = null,
}) {
  const dek = Buffer.from(
    decryptSecret(wrappedDek, {
      purpose: DEK_PURPOSE,
      domain: "content-object",
      resource: objectId,
    }),
    "base64url"
  );
  const plaintextSize = Number(metadata.plaintextSize);
  const chunkSize = Number(metadata.chunkSize);
  const range = encryptedRangeForPlaintext({
    start,
    end,
    chunkSize,
    plaintextSize,
  });
  let cursor = 0;
  const chunks = [];
  for (
    let chunkIndex = range.firstChunk;
    chunkIndex <= range.lastChunk;
    chunkIndex += 1
  ) {
    const expectedRecordOffset = recordOffset(chunkIndex, chunkSize);
    const relativeOffset = expectedRecordOffset - Number(encryptedStart || 0);
    cursor = relativeOffset;
    const cipherLength = encrypted.readUInt32BE(cursor);
    cursor += 4;
    const iv = encrypted.subarray(cursor, cursor + 12);
    cursor += 12;
    const tag = encrypted.subarray(cursor, cursor + 16);
    cursor += 16;
    const ciphertext = encrypted.subarray(cursor, cursor + cipherLength);
    const decipher = crypto.createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAAD(additionalData({ objectId, chunkIndex, plaintextSize }));
    decipher.setAuthTag(tag);
    chunks.push(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }
  const joined = Buffer.concat(chunks);
  const offsetWithinFirst = range.start - range.firstChunk * chunkSize;
  return joined.subarray(
    offsetWithinFirst,
    offsetWithinFirst + (range.end - range.start + 1)
  );
}

module.exports = {
  ENCRYPTION_VERSION,
  HEADER_BYTES,
  decryptContentRange,
  encryptContentBuffer,
  encryptContentFileParts,
  encryptedRangeForPlaintext,
  parseHeader,
  recordOffset,
};
