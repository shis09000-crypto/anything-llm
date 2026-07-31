const crypto = require("crypto");
const fs = require("fs");
const { pipeline } = require("stream/promises");

const ALGORITHM = "aes-256-gcm";

function keyBytes(value) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (key.length !== 32) throw new Error("stream_aead_key_invalid");
  return key;
}

function bytes(value, length, label) {
  const result = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (result.length !== length) throw new Error(`stream_aead_${label}_invalid`);
  return result;
}

function additionalData(value) {
  const result = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value || ""), "utf8");
  if (!result.length || result.length > 4 * 1024)
    throw new Error("stream_aead_aad_invalid");
  return result;
}

async function encryptFileAes256Gcm({
  inputPath,
  outputPath,
  key,
  aad,
  iv = crypto.randomBytes(12),
}) {
  const nonce = bytes(iv, 12, "iv");
  const cipher = crypto.createCipheriv(ALGORITHM, keyBytes(key), nonce);
  cipher.setAAD(additionalData(aad));
  try {
    await pipeline(
      fs.createReadStream(inputPath),
      cipher,
      fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 })
    );
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true });
    throw error;
  }
  return { iv: nonce, authTag: cipher.getAuthTag() };
}

async function decryptFileAes256Gcm({
  inputPath,
  outputPath,
  key,
  iv,
  authTag,
  aad,
}) {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    keyBytes(key),
    bytes(iv, 12, "iv")
  );
  decipher.setAAD(additionalData(aad));
  decipher.setAuthTag(bytes(authTag, 16, "auth_tag"));
  try {
    await pipeline(
      fs.createReadStream(inputPath),
      decipher,
      fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 })
    );
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true });
    throw error;
  }
  return { decrypted: true };
}

module.exports = {
  ALGORITHM,
  decryptFileAes256Gcm,
  encryptFileAes256Gcm,
};
