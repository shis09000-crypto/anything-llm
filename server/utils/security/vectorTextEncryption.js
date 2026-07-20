const {
  decryptSecretIfNeeded,
  encryptSecret,
  isEncryptedSecret,
} = require("./encryption");
const { resolveActiveKey } = require("./keyCustody");

const VECTOR_TEXT_CRYPTO_VERSION = "athena-vector-text:v1";
const VECTOR_TEXT_ALGORITHM = "AES-GCM-256";
const VECTOR_TEXT_DEFAULT_DOMAIN = "vector-provider-text";

function vectorTextEncryptionEnabled(env = process.env) {
  if (String(env.VECTOR_TEXT_ENCRYPTION || "").toLowerCase() === "false")
    return false;
  if (
    String(env.VECTOR_TEXT_ENCRYPTION_DISABLED || "").toLowerCase() === "true"
  )
    return false;
  try {
    return Boolean(resolveActiveKey());
  } catch {
    return false;
  }
}

function encryptVectorText(text, { domain = VECTOR_TEXT_DEFAULT_DOMAIN } = {}) {
  if (text === null || text === undefined) return text;
  const value = String(text);
  if (isEncryptedVectorText(value)) return value;
  if (!vectorTextEncryptionEnabled()) return value;

  return JSON.stringify({
    cryptoVersion: VECTOR_TEXT_CRYPTO_VERSION,
    algorithm: VECTOR_TEXT_ALGORITHM,
    encryptedPayload: encryptSecret(
      JSON.stringify({
        domain: normalizeDomain(domain),
        text: value,
      }),
      { domain }
    ),
  });
}

function decryptVectorText(
  value,
  { domain = VECTOR_TEXT_DEFAULT_DOMAIN } = {}
) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const payload = parseEncryptedVectorTextPayload(text);
  if (!payload) return text;

  const decrypted = JSON.parse(
    decryptSecretIfNeeded(payload.encryptedPayload, { domain })
  );
  const expectedDomain = normalizeDomain(domain);
  if (decrypted?.domain && decrypted.domain !== expectedDomain) {
    throw new Error("vector_text_domain_mismatch");
  }
  return typeof decrypted?.text === "string" ? decrypted.text : "";
}

function encryptVectorMetadataText(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (!Object.prototype.hasOwnProperty.call(metadata, "text")) return metadata;
  return {
    ...metadata,
    text: encryptVectorText(metadata.text),
  };
}

function decryptVectorMetadataText(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (!Object.prototype.hasOwnProperty.call(metadata, "text")) return metadata;
  return {
    ...metadata,
    text: decryptVectorText(metadata.text),
  };
}

function isEncryptedVectorText(value) {
  return Boolean(parseEncryptedVectorTextPayload(value));
}

function parseEncryptedVectorTextPayload(value) {
  if (typeof value !== "string") return null;
  if (!value.includes(VECTOR_TEXT_CRYPTO_VERSION)) return null;

  try {
    const parsed = JSON.parse(value);
    if (
      parsed?.cryptoVersion === VECTOR_TEXT_CRYPTO_VERSION &&
      parsed?.algorithm === VECTOR_TEXT_ALGORITHM &&
      isEncryptedSecret(parsed?.encryptedPayload)
    ) {
      return parsed;
    }
  } catch {}

  return null;
}

function normalizeDomain(domain = "") {
  return String(domain || VECTOR_TEXT_DEFAULT_DOMAIN)
    .trim()
    .slice(0, 128);
}

module.exports = {
  VECTOR_TEXT_ALGORITHM,
  VECTOR_TEXT_CRYPTO_VERSION,
  decryptVectorMetadataText,
  decryptVectorText,
  encryptVectorMetadataText,
  encryptVectorText,
  isEncryptedVectorText,
  vectorTextEncryptionEnabled,
};
