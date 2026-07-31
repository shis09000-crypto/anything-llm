const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const archiver = require("archiver");
const unzipper = require("unzipper");
const { ensureStoragePath } = require("../environment");
const {
  contentObjectProvider,
} = require("../../providers/storage/contentObjectProvider");
const {
  unwrapMaterial,
  wrapMaterial,
} = require("../security/keyCustody/remoteClient");

const PROFILE_FORMAT = "athena-browser-profile:v1";
const DEFAULT_PROFILE_LIMIT_BYTES = 512 * 1024 * 1024;

function safeId(value = "") {
  const normalized = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(normalized)) {
    const error = new Error("browser_profile_id_invalid");
    error.code = "browser_profile_id_invalid";
    throw error;
  }
  return normalized;
}

function profileContext(profileId) {
  return {
    purpose: "browser-profile-dek",
    domain: "browser-plane",
    resource: safeId(profileId),
  };
}

function roots() {
  return {
    staging:
      process.env.BROWSER_WORKER_PROFILE_ROOT ||
      ensureStoragePath("browser-plane", "profile-staging"),
  };
}

function paths(profileId) {
  const id = safeId(profileId);
  const root = roots();
  return {
    id,
    activeDir: path.join(root.staging, "active", id),
    encryptedTemp: path.join(root.staging, "encrypted", id),
  };
}

function profileObjectKey(profileId, ciphertextSha256) {
  return path.posix.join(
    "browser",
    "profiles",
    "v1",
    safeId(profileId),
    `${String(ciphertextSha256)}.profile.enc`
  );
}

function parseManifest(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function assertArchiveRef(profileId, objectRef) {
  const prefix = `browser/profiles/v1/${safeId(profileId)}/`;
  const ref = String(objectRef || "");
  if (!ref.startsWith(prefix) || !ref.endsWith(".profile.enc"))
    throw new Error("browser_profile_object_ref_invalid");
  return ref;
}

async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function removeEphemeralBrowserCaches(activeDir) {
  const pathsToRemove = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "GraphiteDawnCache",
    "GrShaderCache",
    "ShaderCache",
    path.join("Default", "Cache"),
    path.join("Default", "Code Cache"),
    path.join("Default", "GPUCache"),
  ];
  await Promise.allSettled(
    pathsToRemove.map((relative) =>
      fs.promises.rm(path.join(activeDir, relative), {
        recursive: true,
        force: true,
      })
    )
  );
}

async function createArchive(sourceDir, destinationPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destinationPath, {
      flags: "wx",
      mode: 0o600,
    });
    const archive = archiver("zip", { zlib: { level: 6 } });
    const fail = (error) => reject(error);
    output.once("close", resolve);
    output.once("error", fail);
    archive.once("error", fail);
    archive.pipe(output);
    archive.directory(sourceDir, false, (entry) =>
      entry.name === ".restore.zip" ? false : entry
    );
    void archive.finalize();
  });
}

async function extractArchive(zipPath, targetDir, maxBytes) {
  const archive = await unzipper.Open.file(zipPath);
  if (archive.files.length > 50_000)
    throw new Error("browser_profile_archive_entry_limit_exceeded");
  let extractedBytes = 0;
  for (const entry of archive.files) {
    const entryName = String(entry.path || "").replace(/\\/g, "/");
    if (
      !entryName ||
      path.posix.isAbsolute(entryName) ||
      entryName.split("/").includes("..")
    )
      throw new Error("browser_profile_archive_path_invalid");
    const destination = path.resolve(targetDir, entryName);
    if (!destination.startsWith(`${path.resolve(targetDir)}${path.sep}`))
      throw new Error("browser_profile_archive_path_invalid");
    if (entry.type === "Directory") {
      await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
      continue;
    }
    if (entry.type !== "File")
      throw new Error("browser_profile_archive_entry_type_invalid");
    const declaredBytes = Number(entry.uncompressedSize || 0);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      extractedBytes + declaredBytes > maxBytes
    )
      throw new Error("browser_profile_expanded_size_limit_exceeded");
    await fs.promises.mkdir(path.dirname(destination), {
      recursive: true,
      mode: 0o700,
    });
    await pipeline(
      entry.stream(),
      new Transform({
        transform(chunk, _encoding, callback) {
          extractedBytes += chunk.length;
          if (extractedBytes > maxBytes)
            return callback(
              new Error("browser_profile_expanded_size_limit_exceeded")
            );
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(destination, { flags: "wx", mode: 0o600 })
    );
  }
  return extractedBytes;
}

async function restoreProfile(
  profileId,
  { objectRef = null, manifest = null } = {}
) {
  const target = paths(profileId);
  await fs.promises.rm(target.activeDir, { recursive: true, force: true });
  await fs.promises.mkdir(target.activeDir, { recursive: true, mode: 0o700 });
  const parsedManifest = parseManifest(manifest);
  if (!objectRef || !parsedManifest) {
    return {
      profileId: target.id,
      activeDir: target.activeDir,
      restored: false,
    };
  }
  const archiveRef = assertArchiveRef(target.id, objectRef);
  if (parsedManifest.format !== PROFILE_FORMAT)
    throw new Error("browser_profile_format_invalid");
  if (parsedManifest.profileId !== target.id)
    throw new Error("browser_profile_manifest_scope_invalid");
  const ciphertextBytes = Number(parsedManifest.ciphertextBytes);
  if (
    !Number.isSafeInteger(ciphertextBytes) ||
    ciphertextBytes < 1 ||
    ciphertextBytes > DEFAULT_PROFILE_LIMIT_BYTES + 1024
  )
    throw new Error("browser_profile_ciphertext_size_invalid");
  const provider = contentObjectProvider();
  const remote = await provider.stat({ objectKey: archiveRef });
  if (!remote.exists || remote.size !== ciphertextBytes)
    throw new Error("browser_profile_object_missing");
  const encryptedPath = `${target.encryptedTemp}.${crypto.randomUUID()}.enc`;
  const zipPath = path.join(target.activeDir, ".restore.zip");
  await fs.promises.mkdir(path.dirname(encryptedPath), {
    recursive: true,
    mode: 0o700,
  });
  try {
    await provider.writeToFile({
      objectKey: archiveRef,
      destinationPath: encryptedPath,
    });
    if ((await hashFile(encryptedPath)) !== parsedManifest.ciphertextSha256)
      throw new Error("browser_profile_ciphertext_hash_mismatch");
    const dek = Buffer.from(
      await unwrapMaterial(
        parsedManifest.wrappedDek,
        profileContext(target.id)
      ),
      "base64url"
    );
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      dek,
      Buffer.from(parsedManifest.iv, "base64url")
    );
    decipher.setAAD(Buffer.from(`${PROFILE_FORMAT}:${target.id}`, "utf8"));
    decipher.setAuthTag(Buffer.from(parsedManifest.authTag, "base64url"));
    await pipeline(
      fs.createReadStream(encryptedPath),
      decipher,
      fs.createWriteStream(zipPath, { flags: "wx", mode: 0o600 })
    );
    if ((await hashFile(zipPath)) !== parsedManifest.plaintextSha256)
      throw new Error("browser_profile_plaintext_hash_mismatch");
    await extractArchive(
      zipPath,
      target.activeDir,
      DEFAULT_PROFILE_LIMIT_BYTES
    );
  } catch (error) {
    await fs.promises.rm(target.activeDir, { recursive: true, force: true });
    throw error;
  } finally {
    await Promise.allSettled([
      fs.promises.rm(zipPath, { force: true }),
      fs.promises.rm(encryptedPath, { force: true }),
    ]);
  }
  return { profileId: target.id, activeDir: target.activeDir, restored: true };
}

async function checkpointProfile(
  profileId,
  {
    maxBytes = Number(
      process.env.BROWSER_PROFILE_MAX_BYTES || DEFAULT_PROFILE_LIMIT_BYTES
    ),
  } = {}
) {
  const target = paths(profileId);
  if (!fs.existsSync(target.activeDir))
    return { checkpointed: false, reason: "inactive" };
  await fs.promises.mkdir(path.dirname(target.encryptedTemp), {
    recursive: true,
    mode: 0o700,
  });
  const zipPath = `${target.encryptedTemp}.${crypto.randomUUID()}.zip`;
  const encryptedPath = `${target.encryptedTemp}.${crypto.randomUUID()}.tmp`;
  try {
    await removeEphemeralBrowserCaches(target.activeDir);
    await createArchive(target.activeDir, zipPath);
    const size = (await fs.promises.stat(zipPath)).size;
    if (size > maxBytes) {
      const error = new Error("browser_profile_size_limit_exceeded");
      error.code = "browser_profile_size_limit_exceeded";
      throw error;
    }
    const dek = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(Buffer.from(`${PROFILE_FORMAT}:${target.id}`, "utf8"));
    const plaintextSha256 = await hashFile(zipPath);
    await pipeline(
      fs.createReadStream(zipPath),
      cipher,
      fs.createWriteStream(encryptedPath, { flags: "wx", mode: 0o600 })
    );
    const wrappedDek = await wrapMaterial(
      dek.toString("base64url"),
      profileContext(target.id)
    );
    const ciphertextSha256 = await hashFile(encryptedPath);
    const ciphertextBytes = (await fs.promises.stat(encryptedPath)).size;
    const manifest = {
      format: PROFILE_FORMAT,
      profileId: target.id,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      wrappedDek,
      plaintextBytes: size,
      plaintextSha256,
      ciphertextBytes,
      ciphertextSha256,
      checkpointedAt: new Date().toISOString(),
    };
    const objectRef = profileObjectKey(target.id, ciphertextSha256);
    await contentObjectProvider().putImmutableFile({
      objectKey: objectRef,
      sourcePath: encryptedPath,
      ciphertextSha256,
    });
    return {
      checkpointed: true,
      profileId: target.id,
      bytes: size,
      ciphertextSha256,
      checkpointedAt: manifest.checkpointedAt,
      objectRef,
      manifest,
    };
  } finally {
    await Promise.allSettled([
      fs.promises.rm(zipPath, { force: true }),
      fs.promises.rm(encryptedPath, { force: true }),
    ]);
  }
}

async function releaseProfile(profileId, { checkpoint = true } = {}) {
  const target = paths(profileId);
  let result = { checkpointed: false };
  try {
    if (checkpoint) result = await checkpointProfile(profileId);
  } finally {
    await fs.promises.rm(target.activeDir, { recursive: true, force: true });
  }
  return result;
}

async function deleteProfile(profileId, { objectRef = null } = {}) {
  const target = paths(profileId);
  await fs.promises.rm(target.activeDir, { recursive: true, force: true });
  if (objectRef)
    await contentObjectProvider().delete({
      objectKey: assertArchiveRef(target.id, objectRef),
    });
  return { deleted: true, profileId: target.id };
}

module.exports = {
  DEFAULT_PROFILE_LIMIT_BYTES,
  PROFILE_FORMAT,
  checkpointProfile,
  deleteProfile,
  paths,
  releaseProfile,
  restoreProfile,
  safeId,
  profileObjectKey,
};
