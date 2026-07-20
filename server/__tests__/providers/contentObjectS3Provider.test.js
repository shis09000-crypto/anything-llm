/* eslint-env jest */

const fs = require("fs");
const os = require("os");
const path = require("path");

const mockSend = jest.fn();
const mockUploadDone = jest.fn();
const mockUploadConstruct = jest.fn();

jest.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(input) {
      this.input = input;
    }
  }
  return {
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    HeadObjectCommand: class HeadObjectCommand extends Command {},
    PutObjectCommand: class PutObjectCommand extends Command {},
    S3Client: class S3Client {
      send(command) {
        return mockSend(command);
      }
      destroy() {}
    },
  };
});

jest.mock("@aws-sdk/lib-storage", () => ({
  Upload: class Upload {
    constructor(options) {
      this.options = options;
      mockUploadConstruct(options);
    }
    async done() {
      for await (const _chunk of this.options.params.Body) {
        // Drain the stream so lifecycle behavior matches the SDK upload.
      }
      return mockUploadDone();
    }
  },
}));

const {
  ContentObjectS3Provider,
} = require("../../providers/storage/contentObjectS3Provider");

describe("ContentObjectS3Provider", () => {
  let root;
  const digest = "ab".repeat(32);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-s3-provider-"));
    process.env.ATHENA_S3_BUCKET = "athena-test";
    process.env.ATHENA_S3_PREFIX = "objects";
    mockSend.mockReset();
    mockUploadDone.mockReset();
    mockUploadConstruct.mockReset();
    ContentObjectS3Provider.resetForTests();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.ATHENA_S3_BUCKET;
    delete process.env.ATHENA_S3_PREFIX;
  });

  it("streams multipart files and verifies the committed object", async () => {
    const sourcePath = path.join(root, "encrypted.athobj");
    fs.writeFileSync(sourcePath, Buffer.alloc(9 * 1024 * 1024, 1));
    mockSend
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), { name: "NotFound" })
      )
      .mockResolvedValueOnce({
        ContentLength: fs.statSync(sourcePath).size,
        Metadata: { "athena-cipher-sha256": digest },
      });
    mockUploadDone.mockResolvedValue({});

    await expect(
      ContentObjectS3Provider.putImmutableFile({
        objectKey: "scope/object.athobj",
        sourcePath,
        ciphertextSha256: digest,
      })
    ).resolves.toMatchObject({ created: true });
    expect(mockUploadConstruct).toHaveBeenCalledWith(
      expect.objectContaining({
        partSize: 8 * 1024 * 1024,
        queueSize: 2,
        leavePartsOnError: false,
        params: expect.objectContaining({
          Bucket: "athena-test",
          Key: "objects/scope/object.athobj",
          IfNoneMatch: "*",
        }),
      })
    );
  });

  it("rejects a condition-write winner with a different digest", async () => {
    const body = Buffer.from("candidate");
    mockSend
      .mockRejectedValueOnce(
        Object.assign(new Error("conflict"), { name: "PreconditionFailed" })
      )
      .mockResolvedValueOnce({
        ContentLength: body.length,
        Metadata: { "athena-cipher-sha256": "cd".repeat(32) },
      });

    await expect(
      ContentObjectS3Provider.putImmutable({
        objectKey: "scope/object.athobj",
        body,
        ciphertextSha256: digest,
      })
    ).rejects.toMatchObject({ code: "CONTENT_OBJECT_COLLISION" });
  });

  it("fails closed when post-upload metadata verification is incomplete", async () => {
    const sourcePath = path.join(root, "encrypted.athobj");
    fs.writeFileSync(sourcePath, Buffer.alloc(1024, 1));
    mockSend
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), { name: "NotFound" })
      )
      .mockResolvedValueOnce({
        ContentLength: 1024,
        Metadata: {},
      });
    mockUploadDone.mockResolvedValue({});

    await expect(
      ContentObjectS3Provider.putImmutableFile({
        objectKey: "scope/object.athobj",
        sourcePath,
        ciphertextSha256: digest,
      })
    ).rejects.toMatchObject({
      code: "CONTENT_OBJECT_S3_COMMIT_VERIFICATION_FAILED",
    });
  });

  it("requires COMPLIANCE object lock when a retention window is requested", async () => {
    const body = Buffer.from("signed-audit-archive");
    mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({
      ContentLength: body.length,
      Metadata: { "athena-cipher-sha256": digest },
      ObjectLockMode: "COMPLIANCE",
      ObjectLockRetainUntilDate: new Date(Date.now() + 400 * 86_400_000),
    });

    await expect(
      ContentObjectS3Provider.putImmutable({
        objectKey: "security-audit/archive.json",
        body,
        ciphertextSha256: digest,
        retentionDays: 365,
      })
    ).resolves.toMatchObject({ created: true });
    expect(mockSend.mock.calls[0][0].input).toEqual(
      expect.objectContaining({
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: expect.any(Date),
      })
    );
  });
});
