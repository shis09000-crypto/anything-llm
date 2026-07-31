/* eslint-env jest */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  decryptFileAes256Gcm,
  encryptFileAes256Gcm,
} = require("../../utils/security/keyCustody/streamAead");

describe("stream AEAD boundary", () => {
  let root;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "athena-aead-"));
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  test("round-trips a file and rejects a changed authentication tag", async () => {
    const inputPath = path.join(root, "input.bin");
    const encryptedPath = path.join(root, "encrypted.bin");
    const outputPath = path.join(root, "output.bin");
    const key = crypto.randomBytes(32);
    const plaintext = crypto.randomBytes(256 * 1024);
    await fs.promises.writeFile(inputPath, plaintext, { mode: 0o600 });

    const { iv, authTag } = await encryptFileAes256Gcm({
      inputPath,
      outputPath: encryptedPath,
      key,
      aad: "athena-browser-profile:v1:test",
    });
    await decryptFileAes256Gcm({
      inputPath: encryptedPath,
      outputPath,
      key,
      iv,
      authTag,
      aad: "athena-browser-profile:v1:test",
    });
    await expect(fs.promises.readFile(outputPath)).resolves.toEqual(plaintext);

    const changedTag = Buffer.from(authTag);
    changedTag[0] ^= 0xff;
    await expect(
      decryptFileAes256Gcm({
        inputPath: encryptedPath,
        outputPath: path.join(root, "tampered.bin"),
        key,
        iv,
        authTag: changedTag,
        aad: "athena-browser-profile:v1:test",
      })
    ).rejects.toThrow();
  });
});
