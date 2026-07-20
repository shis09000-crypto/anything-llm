jest.mock("../../utils/security/encryption", () => ({
  encryptSecret: (value) => `wrapped:${value}`,
  decryptSecret: (value) => String(value).replace(/^wrapped:/, ""),
}));

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  decryptContentRange,
  encryptContentBuffer,
  encryptContentFileParts,
  encryptedRangeForPlaintext,
} = require("../../utils/contentObjects/crypto");

describe("content object chunked encryption", () => {
  it("decrypts exact cross-chunk ranges", () => {
    const objectId = crypto.randomUUID();
    const source = Buffer.from("Athena-跨设备-".repeat(2_000), "utf8");
    const packed = encryptContentBuffer({
      objectId,
      plaintext: source,
      chunkSize: 1_024,
    });

    for (const [start, end] of [
      [0, 0],
      [997, 2_050],
      [source.length - 37, source.length - 1],
      [0, source.length - 1],
    ]) {
      const range = encryptedRangeForPlaintext({
        start,
        end,
        chunkSize: packed.metadata.chunkSize,
        plaintextSize: source.length,
      });
      const encrypted = packed.encrypted.subarray(
        range.encryptedStart,
        range.encryptedEnd + 1
      );
      expect(
        decryptContentRange({
          objectId,
          encrypted,
          encryptedStart: range.encryptedStart,
          wrappedDek: packed.wrappedDek,
          metadata: packed.metadata,
          start,
          end,
        })
      ).toEqual(source.subarray(start, end + 1));
    }
  });

  it("rejects ciphertext tampering", () => {
    const objectId = crypto.randomUUID();
    const source = Buffer.from("security-ledger");
    const packed = encryptContentBuffer({
      objectId,
      plaintext: source,
      chunkSize: 8,
    });
    const tampered = Buffer.from(packed.encrypted);
    tampered[tampered.length - 1] ^= 1;

    expect(() =>
      decryptContentRange({
        objectId,
        encrypted: tampered,
        encryptedStart: 0,
        wrappedDek: packed.wrappedDek,
        metadata: packed.metadata,
        start: 0,
        end: source.length - 1,
      })
    ).toThrow();
  });

  it("streams multiple upload parts into the same range-decryptable format", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "athena-stream-crypto-")
    );
    const source = Buffer.from("跨分片流式加密".repeat(5_000), "utf8");
    const first = path.join(root, "1.part");
    const second = path.join(root, "2.part");
    const output = path.join(root, "object.athobj");
    fs.writeFileSync(first, source.subarray(0, 13_337));
    fs.writeFileSync(second, source.subarray(13_337));
    try {
      const packed = await encryptContentFileParts({
        objectId: "stream-object",
        filePaths: [first, second],
        plaintextSize: source.length,
        chunkSize: 4_096,
        outputPath: output,
      });
      const encrypted = fs.readFileSync(output);
      expect(encrypted.length).toBe(packed.encryptedSize);
      expect(
        decryptContentRange({
          objectId: "stream-object",
          encrypted,
          encryptedStart: 0,
          wrappedDek: packed.wrappedDek,
          metadata: packed.metadata,
          start: 0,
          end: source.length - 1,
        })
      ).toEqual(source);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
