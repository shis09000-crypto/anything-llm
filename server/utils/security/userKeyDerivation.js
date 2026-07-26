const crypto = require("crypto");
const { SUITE_IDS, registeredCryptoSuite } = require("./cryptoSuiteRegistry");

const USER_ROOT_KEY_BYTES = 32;
const DERIVED_KEY_BYTES = 32;
const USER_ROOT_ENVELOPE_VERSION = "athena-user-root-key-envelope:v2";
const USER_ROOT_DERIVATION_SUITE_ID = SUITE_IDS.USER_ROOT_HKDF_SHA256_V1;
const USER_ROOT_TRANSPORT_SUITE_ID = SUITE_IDS.VAULT_XWING_MLDSA65_V1;

const USER_KEY_DOMAINS = Object.freeze({
  DATA: "data",
  FILE: "file",
  AGENT: "agent",
  VAULT: "vault",
});

function positiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1)
    throw new Error(`invalid_${field}`);
  return normalized;
}

function normalizedClientId(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(normalized))
    throw new Error("invalid_target_client_id");
  return normalized;
}

function normalizedRootKey(value) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (key.length !== USER_ROOT_KEY_BYTES)
    throw new Error("invalid_user_root_key");
  return key;
}

function normalizedDomain(value) {
  const domain = String(value || "")
    .trim()
    .toLowerCase();
  if (!Object.values(USER_KEY_DOMAINS).includes(domain))
    throw new Error("invalid_user_key_domain");
  return domain;
}

function generateUserRootKey() {
  return crypto.randomBytes(USER_ROOT_KEY_BYTES);
}

/**
 * Derive a domain key from a random, persistent User Root Key.
 *
 * A password-derived KEK or X-Wing KEM shared secret is a wrapping key and must
 * never be passed as userRootKey. Those inputs rotate independently from this
 * hierarchy and are intentionally kept outside this function.
 */
function deriveUserDomainKey({ userRootKey, authUserId, keyEpoch, domain }) {
  const root = normalizedRootKey(userRootKey);
  const userId = positiveInteger(authUserId, "auth_user_id");
  const epoch = positiveInteger(keyEpoch, "key_epoch");
  const normalizedKeyDomain = normalizedDomain(domain);
  const salt = crypto
    .createHash("sha256")
    .update(`athena-user-root-salt:v1\u0000${userId}\u0000${epoch}`, "utf8")
    .digest();
  const info = Buffer.from(
    `athena-user-root-domain:v1\u0000${USER_ROOT_DERIVATION_SUITE_ID}\u0000${normalizedKeyDomain}`,
    "utf8"
  );
  return Buffer.from(
    crypto.hkdfSync("sha256", root, salt, info, DERIVED_KEY_BYTES)
  );
}

/**
 * Canonical public context bound into a future User Root Key device envelope.
 * The active Vault X-Wing + ML-DSA suite is deliberately reused as transport.
 */
function userRootEnvelopeContext({
  authUserId,
  keyEpoch,
  targetClientId,
  transportSuiteId = USER_ROOT_TRANSPORT_SUITE_ID,
}) {
  const suite = registeredCryptoSuite(transportSuiteId);
  if (
    transportSuiteId !== USER_ROOT_TRANSPORT_SUITE_ID ||
    !suite ||
    suite.status !== "active"
  ) {
    throw new Error("unsupported_user_root_transport_suite");
  }
  return Object.freeze({
    version: "athena-user-root-envelope-context:v1",
    derivationSuiteId: USER_ROOT_DERIVATION_SUITE_ID,
    transportSuiteId,
    authUserId: positiveInteger(authUserId, "auth_user_id"),
    keyEpoch: positiveInteger(keyEpoch, "key_epoch"),
    targetClientId: normalizedClientId(targetClientId),
  });
}

module.exports = {
  DERIVED_KEY_BYTES,
  USER_KEY_DOMAINS,
  USER_ROOT_DERIVATION_SUITE_ID,
  USER_ROOT_ENVELOPE_VERSION,
  USER_ROOT_KEY_BYTES,
  USER_ROOT_TRANSPORT_SUITE_ID,
  deriveUserDomainKey,
  generateUserRootKey,
  userRootEnvelopeContext,
};
