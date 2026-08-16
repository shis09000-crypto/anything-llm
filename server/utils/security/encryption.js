const crypto = require("crypto");
const {
  ENCRYPTION_ALGORITHM,
  LEGACY_SECRET_PREFIX,
  SECRET_PREFIX,
} = require("./constants");
const { EncryptionFormatError, EncryptionOperationError } = require("./errors");
const { getMasterKey, getMasterKeyDescriptor } = require("./keyManager");
const { recordEncryptionBlock } = require("./encryptionDiagnostics");
const { assertEncryptionWriteAllowed } = require("./keyRuntimeState");
const { assertLegacyEnvelopeWriteAllowed } = require("./legacyWritePolicy");
const { recordDecryptOnlyKeyRead } = require("./legacyKeyReadObservation");

function isEmptySecret(value) {
  return value === null || value === undefined || value === "";
}

function isEncryptedSecret(value) {
  return (
    typeof value === "string" &&
    (value.startsWith(SECRET_PREFIX) || value.startsWith(LEGACY_SECRET_PREFIX))
  );
}

function normalizedPurpose(context = {}) {
  return String(context.purpose || context.domain || "secret-store")
    .trim()
    .slice(0, 128);
}

function v2AdditionalData(keyId, purpose) {
  return Buffer.from(
    JSON.stringify({ version: "enc:v2", keyId, purpose }),
    "utf8"
  );
}

function encryptSecret(plainText, context = {}) {
  if (isEmptySecret(plainText)) return plainText;
  assertLegacyEnvelopeWriteAllowed(plainText);
  if (isEncryptedSecret(plainText)) return plainText;

  try {
    assertEncryptionWriteAllowed();
    const iv = crypto.randomBytes(12);
    if (process.env.ATHENA_SECRET_ENVELOPE_VERSION === "v1") {
      const cipher = crypto.createCipheriv(
        ENCRYPTION_ALGORITHM,
        getMasterKey(),
        iv
      );
      const cipherText = Buffer.concat([
        cipher.update(String(plainText), "utf8"),
        cipher.final(),
      ]);
      return [
        LEGACY_SECRET_PREFIX.slice(0, -1),
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        cipherText.toString("base64url"),
      ].join(":");
    }
    const descriptor = getMasterKeyDescriptor();
    const purpose = normalizedPurpose(context);
    const cipher = crypto.createCipheriv(
      ENCRYPTION_ALGORITHM,
      descriptor.material,
      iv
    );
    cipher.setAAD(v2AdditionalData(descriptor.keyId, purpose));
    const cipherText = Buffer.concat([
      cipher.update(String(plainText), "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      SECRET_PREFIX.slice(0, -1),
      descriptor.keyId,
      Buffer.from(purpose, "utf8").toString("base64url"),
      iv.toString("base64url"),
      authTag.toString("base64url"),
      cipherText.toString("base64url"),
    ].join(":");
  } catch (error) {
    const finalError =
      error.name === "EncryptionConfigError" ||
      error.code === "KEY_CUSTODY_QUARANTINED" ||
      error.code === "LEGACY_SECRET_WRITES_CLOSED"
        ? error
        : new EncryptionOperationError("Failed to encrypt secret.");
    recordEncryptionBlock({
      error: finalError,
      operation: context.operation || "encrypt-secret",
      domain: context.domain || "secret-store",
      resource: context.resource,
    });
    throw finalError;
  }
}

function parseEncryptedSecret(encryptedText) {
  if (!isEncryptedSecret(encryptedText)) {
    throw new EncryptionFormatError("Secret is not in enc:v1 format.");
  }

  const parts = encryptedText.split(":");
  if (parts[0] !== "enc" || !["v1", "v2"].includes(parts[1])) {
    throw new EncryptionFormatError("Encrypted secret format is invalid.");
  }
  if (parts[1] === "v1" && parts.length !== 5) {
    throw new EncryptionFormatError("Encrypted secret format is invalid.");
  }
  if (parts[1] === "v2" && parts.length !== 7) {
    throw new EncryptionFormatError("Encrypted secret format is invalid.");
  }

  const version = parts[1];
  const keyId = version === "v2" ? parts[2] : null;
  const purpose =
    version === "v2"
      ? Buffer.from(parts[3], "base64url").toString("utf8")
      : null;
  const [iv, authTag, cipherText] =
    version === "v2" ? parts.slice(4) : parts.slice(2);
  if (!iv || !authTag || !cipherText) {
    throw new EncryptionFormatError("Encrypted secret format is incomplete.");
  }

  return {
    version,
    keyId,
    purpose,
    iv: Buffer.from(iv, "base64url"),
    authTag: Buffer.from(authTag, "base64url"),
    cipherText: Buffer.from(cipherText, "base64url"),
  };
}

function decryptSecret(encryptedText, context = {}) {
  try {
    const payload = parseEncryptedSecret(encryptedText);
    const descriptor = payload.keyId
      ? getMasterKeyDescriptor(payload.keyId)
      : getMasterKeyDescriptor();
    const decipher = crypto.createDecipheriv(
      ENCRYPTION_ALGORITHM,
      descriptor.material,
      payload.iv
    );
    if (payload.version === "v2") {
      const expectedPurpose = context.purpose || context.domain;
      if (expectedPurpose && normalizedPurpose(context) !== payload.purpose) {
        throw new EncryptionFormatError("Encrypted secret purpose mismatch.");
      }
      decipher.setAAD(v2AdditionalData(payload.keyId, payload.purpose));
    }
    decipher.setAuthTag(payload.authTag);
    const plaintext = Buffer.concat([
      decipher.update(payload.cipherText),
      decipher.final(),
    ]).toString("utf8");
    recordDecryptOnlyKeyRead(descriptor, context);
    return plaintext;
  } catch (error) {
    const finalError =
      error.name === "EncryptionConfigError" ||
      error.name === "EncryptionFormatError"
        ? error
        : new EncryptionOperationError("Failed to decrypt secret.");
    recordEncryptionBlock({
      error: finalError,
      operation: context.operation || "decrypt-secret",
      domain: context.domain || "secret-store",
      resource: context.resource,
      payload: encryptedText,
    });
    throw finalError;
  }
}

function decryptSecretIfNeeded(value, context = {}) {
  if (!isEncryptedSecret(value)) return value;
  return decryptSecret(value, context);
}

function remoteContextForEncryptedValue(value, context = {}) {
  if (context.purpose || context.domain) return context;
  const payload = parseEncryptedSecret(value);
  return {
    ...context,
    purpose: payload.purpose || "secret-store",
    domain: payload.purpose || "secret-store",
  };
}

async function encryptSecretAsync(plainText, context = {}) {
  if (isEmptySecret(plainText) || isEncryptedSecret(plainText))
    return plainText;
  const {
    remoteKeyCustodyEnabled,
    wrapMaterial,
  } = require("./keyCustody/remoteClient");
  if (!remoteKeyCustodyEnabled(process.env, context))
    return encryptSecret(plainText, context);
  return wrapMaterial(String(plainText), {
    purpose: normalizedPurpose(context),
    domain: context.domain || normalizedPurpose(context),
    operation: context.operation || "encrypt-secret",
    resource: context.resource,
  });
}

async function decryptSecretAsync(encryptedText, context = {}) {
  const resolvedContext = remoteContextForEncryptedValue(
    encryptedText,
    context
  );
  const {
    remoteKeyCustodyEnabled,
    unwrapMaterial,
  } = require("./keyCustody/remoteClient");
  if (!remoteKeyCustodyEnabled(process.env, resolvedContext))
    return decryptSecret(encryptedText, context);
  return unwrapMaterial(encryptedText, {
    purpose: normalizedPurpose(resolvedContext),
    domain: resolvedContext.domain || normalizedPurpose(resolvedContext),
    operation: resolvedContext.operation || "decrypt-secret",
    resource: resolvedContext.resource,
  });
}

async function decryptSecretIfNeededAsync(value, context = {}) {
  if (!isEncryptedSecret(value)) return value;
  return decryptSecretAsync(value, context);
}

module.exports = {
  encryptSecret,
  encryptSecretAsync,
  decryptSecret,
  decryptSecretAsync,
  isEncryptedSecret,
  decryptSecretIfNeeded,
  decryptSecretIfNeededAsync,
};
