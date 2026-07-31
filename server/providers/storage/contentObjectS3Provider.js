const {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const fs = require("fs");
const { pipeline } = require("stream/promises");
const { Upload } = require("@aws-sdk/lib-storage");

let client = null;

function config(env = process.env) {
  return {
    bucket: String(env.ATHENA_S3_BUCKET || "").trim(),
    prefix: String(env.ATHENA_S3_PREFIX || "athena/content-objects")
      .trim()
      .replace(/^\/+|\/+$/g, ""),
    endpoint: String(env.ATHENA_S3_ENDPOINT || "").trim() || undefined,
    region: String(env.ATHENA_S3_REGION || "us-east-1").trim(),
    forcePathStyle:
      String(env.ATHENA_S3_FORCE_PATH_STYLE || "false").toLowerCase() ===
      "true",
  };
}

function s3Client() {
  if (client) return client;
  const settings = config();
  client = new S3Client({
    region: settings.region,
    endpoint: settings.endpoint,
    forcePathStyle: settings.forcePathStyle,
  });
  return client;
}

function target(objectKey) {
  const settings = config();
  if (!settings.bucket) {
    const error = new Error("content_object_s3_bucket_missing");
    error.code = "CONTENT_OBJECT_S3_BUCKET_MISSING";
    throw error;
  }
  return {
    Bucket: settings.bucket,
    Key: `${settings.prefix}/${String(objectKey).replace(/^\/+/, "")}`,
  };
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function")
    return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function objectLockSatisfies(committed, retainUntil) {
  if (!retainUntil) return true;
  const actual = new Date(committed.objectLockRetainUntilDate || 0).getTime();
  return (
    committed.objectLockMode === "COMPLIANCE" &&
    Number.isFinite(actual) &&
    actual + 5 * 60_000 >= retainUntil.getTime()
  );
}

const ContentObjectS3Provider = {
  adapterName: "content-object-s3",
  providerType: "object-storage",

  capabilities() {
    return {
      read: true,
      write: true,
      delete: true,
      rangeRead: true,
      streamToFile: true,
      immutableWrite: true,
      remote: true,
    };
  },

  summary() {
    const settings = config();
    return {
      adapterName: this.adapterName,
      providerType: this.providerType,
      provider: "s3",
      bucketConfigured: Boolean(settings.bucket),
      endpointConfigured: Boolean(settings.endpoint),
      capabilities: this.capabilities(),
    };
  },

  async putImmutable({
    objectKey,
    body,
    ciphertextSha256,
    retentionDays = null,
  }) {
    const retainUntil = retentionDays
      ? new Date(Date.now() + Number(retentionDays) * 86_400_000)
      : null;
    try {
      await s3Client().send(
        new PutObjectCommand({
          ...target(objectKey),
          Body: body,
          ContentType: "application/octet-stream",
          ChecksumSHA256: Buffer.from(ciphertextSha256, "hex").toString(
            "base64"
          ),
          IfNoneMatch: "*",
          Metadata: { "athena-cipher-sha256": ciphertextSha256 },
          ...(retainUntil
            ? {
                ObjectLockMode: "COMPLIANCE",
                ObjectLockRetainUntilDate: retainUntil,
              }
            : {}),
        })
      );
      const committed = await this.stat({ objectKey });
      if (
        !committed.exists ||
        committed.size !== body.length ||
        committed.metadataSha256 !== ciphertextSha256 ||
        !objectLockSatisfies(committed, retainUntil)
      ) {
        const error = new Error("content_object_s3_commit_verification_failed");
        error.code = "CONTENT_OBJECT_S3_COMMIT_VERIFICATION_FAILED";
        throw error;
      }
      return { created: true, bytes: body.length };
    } catch (error) {
      if (
        ["PreconditionFailed", "ConditionalRequestConflict"].includes(
          error.name
        )
      ) {
        const winner = await this.stat({ objectKey });
        if (
          !winner.exists ||
          winner.size !== body.length ||
          winner.metadataSha256 !== ciphertextSha256 ||
          !objectLockSatisfies(winner, retainUntil)
        ) {
          const collision = new Error("content_object_collision");
          collision.code = "CONTENT_OBJECT_COLLISION";
          throw collision;
        }
        return { created: false, bytes: winner.size };
      }
      throw error;
    }
  },

  async putImmutableFile({
    objectKey,
    sourcePath,
    ciphertextSha256,
    retentionDays = null,
  }) {
    const destination = target(objectKey);
    const existing = await this.stat({ objectKey });
    if (existing.exists) {
      if (
        existing.metadataSha256 !== ciphertextSha256 ||
        !objectLockSatisfies(
          existing,
          retentionDays
            ? new Date(Date.now() + Number(retentionDays) * 86_400_000)
            : null
        )
      ) {
        const error = new Error("content_object_collision");
        error.code = "CONTENT_OBJECT_COLLISION";
        throw error;
      }
      return { created: false, bytes: existing.size };
    }
    const stat = await fs.promises.stat(sourcePath);
    const retainUntil = retentionDays
      ? new Date(Date.now() + Number(retentionDays) * 86_400_000)
      : null;
    try {
      const upload = new Upload({
        client: s3Client(),
        params: {
          ...destination,
          Body: fs.createReadStream(sourcePath),
          ContentLength: stat.size,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          Metadata: { "athena-cipher-sha256": ciphertextSha256 },
          ...(retainUntil
            ? {
                ObjectLockMode: "COMPLIANCE",
                ObjectLockRetainUntilDate: retainUntil,
              }
            : {}),
        },
        partSize: 8 * 1024 * 1024,
        queueSize: 2,
        leavePartsOnError: false,
      });
      await upload.done();
    } catch (error) {
      if (
        !["PreconditionFailed", "ConditionalRequestConflict"].includes(
          error.name
        )
      )
        throw error;
      const winner = await this.stat({ objectKey });
      if (!winner.exists || winner.metadataSha256 !== ciphertextSha256)
        throw error;
      return { created: false, bytes: winner.size };
    }
    const committed = await this.stat({ objectKey });
    if (
      !committed.exists ||
      committed.size !== stat.size ||
      committed.metadataSha256 !== ciphertextSha256 ||
      !objectLockSatisfies(committed, retainUntil)
    ) {
      const error = new Error("content_object_s3_commit_verification_failed");
      error.code = "CONTENT_OBJECT_S3_COMMIT_VERIFICATION_FAILED";
      throw error;
    }
    return { created: true, bytes: stat.size };
  },

  async getRange({ objectKey, start = 0, end = null }) {
    const range = `bytes=${start}-${end == null ? "" : end}`;
    const result = await s3Client().send(
      new GetObjectCommand({ ...target(objectKey), Range: range })
    );
    return bodyToBuffer(result.Body);
  },

  async writeToFile({ objectKey, destinationPath }) {
    const result = await s3Client().send(
      new GetObjectCommand(target(objectKey))
    );
    if (!result.Body) throw new Error("content_object_s3_body_missing");
    await pipeline(
      result.Body,
      fs.createWriteStream(destinationPath, { flags: "wx", mode: 0o600 })
    );
    return { bytes: Number(result.ContentLength || 0) };
  },

  async stat({ objectKey }) {
    try {
      const result = await s3Client().send(
        new HeadObjectCommand(target(objectKey))
      );
      return {
        exists: true,
        size: Number(result.ContentLength || 0),
        lastModified: result.LastModified || null,
        checksumSha256: result.ChecksumSHA256 || null,
        metadataSha256: result.Metadata?.["athena-cipher-sha256"] || null,
        objectLockMode: result.ObjectLockMode || null,
        objectLockRetainUntilDate: result.ObjectLockRetainUntilDate || null,
      };
    } catch (error) {
      if (["NotFound", "NoSuchKey"].includes(error.name))
        return { exists: false };
      throw error;
    }
  },

  async delete({ objectKey }) {
    await s3Client().send(new DeleteObjectCommand(target(objectKey)));
    return true;
  },

  async health() {
    const settings = config();
    if (!settings.bucket) return { ready: false, provider: "s3" };
    await s3Client().send(
      new HeadBucketCommand({
        Bucket: settings.bucket,
      })
    );
    return {
      ready: true,
      provider: "s3",
      bucketConfigured: true,
      reachable: true,
    };
  },

  resetForTests() {
    client?.destroy?.();
    client = null;
  },
};

module.exports = { ContentObjectS3Provider };
