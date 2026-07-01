const {
  decryptSecretIfNeeded,
  encryptSecret,
  isEncryptedSecret,
} = require("./encryption");
const { MASTER_KEY_ENV } = require("./constants");

const DOCUMENT_STORE_CRYPTO_VERSION = "athena-document-store:v1";
const DOCUMENT_STORE_ALGORITHM = "AES-GCM-256";

function documentStoreEncryptionEnabled(env = process.env) {
  if (String(env.DOCUMENT_STORE_ENCRYPTION || "").toLowerCase() === "false")
    return false;
  if (
    String(env.DOCUMENT_STORE_ENCRYPTION_DISABLED || "").toLowerCase() ===
    "true"
  )
    return false;
  return Boolean(String(env[MASTER_KEY_ENV] || "").trim());
}

function isEncryptedDocumentStorePayload(value) {
  return (
    value &&
    typeof value === "object" &&
    value.cryptoVersion === DOCUMENT_STORE_CRYPTO_VERSION &&
    value.algorithm === DOCUMENT_STORE_ALGORITHM &&
    isEncryptedSecret(value.encryptedPayload)
  );
}

function encryptDocumentStorePayload(
  payload,
  { domain = "document-store" } = {}
) {
  if (!documentStoreEncryptionEnabled()) return payload;
  return {
    cryptoVersion: DOCUMENT_STORE_CRYPTO_VERSION,
    algorithm: DOCUMENT_STORE_ALGORITHM,
    encryptedPayload: encryptSecret(
      JSON.stringify({
        domain: normalizeDomain(domain),
        payload,
      })
    ),
  };
}

function decryptDocumentStorePayload(
  value,
  { domain = "document-store" } = {}
) {
  if (!isEncryptedDocumentStorePayload(value)) return value;
  const decrypted = JSON.parse(decryptSecretIfNeeded(value.encryptedPayload));
  const expectedDomain = normalizeDomain(domain);
  if (decrypted?.domain && decrypted.domain !== expectedDomain) {
    throw new Error("document_store_domain_mismatch");
  }
  return decrypted?.payload;
}

function parseDocumentStoreJson(rawText, { domain = "document-store" } = {}) {
  const parsed = JSON.parse(rawText);
  return decryptDocumentStorePayload(parsed, { domain });
}

function stringifyDocumentStoreJson(
  payload,
  { domain = "document-store" } = {}
) {
  return JSON.stringify(encryptDocumentStorePayload(payload, { domain }));
}

function normalizeDomain(domain = "") {
  return String(domain || "document-store")
    .trim()
    .slice(0, 128);
}

module.exports = {
  DOCUMENT_STORE_ALGORITHM,
  DOCUMENT_STORE_CRYPTO_VERSION,
  decryptDocumentStorePayload,
  documentStoreEncryptionEnabled,
  encryptDocumentStorePayload,
  isEncryptedDocumentStorePayload,
  parseDocumentStoreJson,
  stringifyDocumentStoreJson,
};
