const crypto = require("crypto");
const { ENCRYPTION_ALGORITHM, SECRET_PREFIX } = require("./constants");
const { EncryptionFormatError, EncryptionOperationError } = require("./errors");
const { getMasterKey } = require("./keyManager");

function isEmptySecret(value) {
  return value === null || value === undefined || value === "";
}

function isEncryptedSecret(value) {
  return typeof value === "string" && value.startsWith(SECRET_PREFIX);
}

function encryptSecret(plainText) {
  if (isEmptySecret(plainText)) return plainText;
  if (isEncryptedSecret(plainText)) return plainText;

  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
      ENCRYPTION_ALGORITHM,
      getMasterKey(),
      iv
    );
    const cipherText = Buffer.concat([
      cipher.update(String(plainText), "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      SECRET_PREFIX.slice(0, -1),
      iv.toString("base64url"),
      authTag.toString("base64url"),
      cipherText.toString("base64url"),
    ].join(":");
  } catch (error) {
    if (error.name === "EncryptionConfigError") throw error;
    throw new EncryptionOperationError("Failed to encrypt secret.");
  }
}

function parseEncryptedSecret(encryptedText) {
  if (!isEncryptedSecret(encryptedText)) {
    throw new EncryptionFormatError("Secret is not in enc:v1 format.");
  }

  const parts = encryptedText.split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new EncryptionFormatError("Encrypted secret format is invalid.");
  }

  const [, , iv, authTag, cipherText] = parts;
  if (!iv || !authTag || !cipherText) {
    throw new EncryptionFormatError("Encrypted secret format is incomplete.");
  }

  return {
    iv: Buffer.from(iv, "base64url"),
    authTag: Buffer.from(authTag, "base64url"),
    cipherText: Buffer.from(cipherText, "base64url"),
  };
}

function decryptSecret(encryptedText) {
  const payload = parseEncryptedSecret(encryptedText);

  try {
    const decipher = crypto.createDecipheriv(
      ENCRYPTION_ALGORITHM,
      getMasterKey(),
      payload.iv
    );
    decipher.setAuthTag(payload.authTag);
    return Buffer.concat([
      decipher.update(payload.cipherText),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error.name === "EncryptionConfigError") throw error;
    throw new EncryptionOperationError("Failed to decrypt secret.");
  }
}

function decryptSecretIfNeeded(value) {
  if (!isEncryptedSecret(value)) return value;
  return decryptSecret(value);
}

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  decryptSecretIfNeeded,
};
