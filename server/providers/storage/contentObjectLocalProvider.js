const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { FileStorageProvider } = require("./fileStorageProvider");

const ROOT = "content-objects";

function objectPath(objectKey) {
  return FileStorageProvider.resolvePath(path.join(ROOT, objectKey));
}

async function fsyncFile(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory) {
  const handle = await fs.promises.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fileDigest(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

const ContentObjectLocalProvider = {
  adapterName: "content-object-local",
  providerType: "object-storage",

  capabilities() {
    return {
      read: true,
      write: true,
      delete: true,
      rangeRead: true,
      streamToFile: true,
      immutableWrite: true,
      remote: false,
    };
  },

  summary() {
    return {
      adapterName: this.adapterName,
      providerType: this.providerType,
      provider: "local",
      capabilities: this.capabilities(),
    };
  },

  async putImmutable({ objectKey, body, ciphertextSha256 }) {
    const target = objectPath(objectKey);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const existing = await fs.promises.readFile(target);
      const digest = crypto.createHash("sha256").update(existing).digest("hex");
      if (digest !== ciphertextSha256)
        throw Object.assign(new Error("content_object_collision"), {
          code: "CONTENT_OBJECT_COLLISION",
        });
      return { created: false, bytes: existing.length };
    }
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, body, { flag: "wx", mode: 0o600 });
    await fsyncFile(temporary);
    let created = true;
    try {
      // link() is an atomic create-if-absent operation. rename() is not safe
      // here because POSIX rename may silently replace an immutable object.
      await fs.promises.link(temporary, target);
      await fsyncDirectory(path.dirname(target));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      created = false;
      const existing = await fs.promises.readFile(target);
      const digest = crypto.createHash("sha256").update(existing).digest("hex");
      if (digest !== ciphertextSha256) {
        throw Object.assign(new Error("content_object_collision"), {
          code: "CONTENT_OBJECT_COLLISION",
        });
      }
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
    return { created, bytes: body.length };
  },

  async putImmutableFile({ objectKey, sourcePath, ciphertextSha256 }) {
    const target = objectPath(objectKey);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fsyncFile(sourcePath);
    let created = true;
    try {
      await fs.promises.link(sourcePath, target);
      await fsyncDirectory(path.dirname(target));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      created = false;
      if ((await fileDigest(target)) !== ciphertextSha256) {
        throw Object.assign(new Error("content_object_collision"), {
          code: "CONTENT_OBJECT_COLLISION",
        });
      }
    }
    const stat = await fs.promises.stat(target);
    return { created, bytes: stat.size };
  },

  async getRange({ objectKey, start = 0, end = null }) {
    const target = objectPath(objectKey);
    const stat = await fs.promises.stat(target);
    const safeEnd = Math.min(end == null ? stat.size - 1 : end, stat.size - 1);
    if (safeEnd < start) return Buffer.alloc(0);
    const length = safeEnd - start + 1;
    const buffer = Buffer.alloc(length);
    const handle = await fs.promises.open(target, "r");
    try {
      await handle.read(buffer, 0, length, start);
    } finally {
      await handle.close();
    }
    return buffer;
  },

  async writeToFile({ objectKey, destinationPath }) {
    const source = objectPath(objectKey);
    await pipeline(
      fs.createReadStream(source),
      fs.createWriteStream(destinationPath, { flags: "wx", mode: 0o600 })
    );
    return { bytes: (await fs.promises.stat(destinationPath)).size };
  },

  async stat({ objectKey }) {
    try {
      const stat = await fs.promises.stat(objectPath(objectKey));
      return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (error) {
      if (error.code === "ENOENT") return { exists: false };
      throw error;
    }
  },

  async delete({ objectKey }) {
    await fs.promises.rm(objectPath(objectKey), { force: true });
    return true;
  },

  async health() {
    const root = FileStorageProvider.resolvePath(ROOT, { allowRoot: false });
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.access(root, fs.constants.R_OK | fs.constants.W_OK);
    return { ready: true, provider: "local" };
  },
};

module.exports = { ContentObjectLocalProvider, fileDigest };
