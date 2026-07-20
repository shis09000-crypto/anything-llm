const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("ContentObjectLocalProvider", () => {
  let root;
  let provider;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-content-provider-"));
    jest.resetModules();
    jest.doMock("../../providers/storage/fileStorageProvider", () => ({
      FileStorageProvider: {
        resolvePath: (value) => path.join(root, value),
      },
    }));
    provider =
      require("../../providers/storage/contentObjectLocalProvider").ContentObjectLocalProvider;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    jest.dontMock("../../providers/storage/fileStorageProvider");
  });

  it("creates once and never replaces an immutable object", async () => {
    const body = Buffer.from("immutable-object");
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    const [first, second] = await Promise.all([
      provider.putImmutable({
        objectKey: "a/object.bin",
        body,
        ciphertextSha256: digest,
      }),
      provider.putImmutable({
        objectKey: "a/object.bin",
        body,
        ciphertextSha256: digest,
      }),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    await expect(
      provider.putImmutable({
        objectKey: "a/object.bin",
        body: Buffer.from("different"),
        ciphertextSha256: crypto
          .createHash("sha256")
          .update("different")
          .digest("hex"),
      })
    ).rejects.toMatchObject({ code: "CONTENT_OBJECT_COLLISION" });
    await expect(
      provider.getRange({ objectKey: "a/object.bin", start: 2, end: 7 })
    ).resolves.toEqual(body.subarray(2, 8));
  });

  it("atomically commits an encrypted staging file without buffering it", async () => {
    const source = path.join(root, "staging.athobj");
    const body = crypto.randomBytes(2 * 1024 * 1024);
    fs.writeFileSync(source, body);
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    await expect(
      provider.putImmutableFile({
        objectKey: "stream/object.athobj",
        sourcePath: source,
        ciphertextSha256: digest,
      })
    ).resolves.toMatchObject({ created: true, bytes: body.length });
    await expect(
      provider.putImmutableFile({
        objectKey: "stream/object.athobj",
        sourcePath: source,
        ciphertextSha256: digest,
      })
    ).resolves.toMatchObject({ created: false, bytes: body.length });
  });
});
