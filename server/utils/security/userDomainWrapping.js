const crypto = require("crypto");

const USER_DOMAIN_WRAP_VERSION = "athena-user-domain-key-wrap:v1";
const USER_DOMAIN_TRANSPORT_VERSION = "athena-user-domain-material-envelope:v1";
const USER_DOMAIN_WRAP_ALGORITHM = "aes-256-gcm";
const USER_DOMAIN_TRANSPORT_SUITE = "vault-xwing-mldsa65-v1";
const USER_DOMAIN_KEY_VERSION = 1;
const USER_DOMAIN_TRANSPORT_TTL_MS = 2 * 60 * 1000;
const USER_DOMAIN_DOMAINS = Object.freeze(["data", "file", "agent", "vault"]);
const USER_DOMAIN_RESOURCE_TYPES = Object.freeze([
  "chat-conversation-key",
  "content-object",
  "vault-master-key",
  "direct-field-dek",
]);

const MLKEM768_PUBLIC_KEY_BYTES = 1184;
const X25519_PUBLIC_KEY_BYTES = 32;
const XWING_PUBLIC_KEY_BYTES =
  MLKEM768_PUBLIC_KEY_BYTES + X25519_PUBLIC_KEY_BYTES;
const XWING_CIPHERTEXT_BYTES = 1120;
const MLKEM768_SPKI_PREFIX = Buffer.from(
  "308204b2300b0609608648016503040402038204a100",
  "hex"
);
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const XWING_LABEL = Buffer.from("5c2e2f2f5e5c", "hex");

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function parseBase64Url(value, expectedBytes = null) {
  const raw = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64url");
  if (base64Url(decoded) !== raw) return null;
  if (expectedBytes !== null && decoded.length !== expectedBytes) return null;
  return decoded;
}

function normalizedIdentifier(value, maxLength = 256) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9._:-]+$/.test(normalized) && normalized.length <= maxLength
    ? normalized
    : null;
}

function normalizedUserDomainMetadata(input = {}) {
  const authUserId = Number(input.authUserId);
  const rootEpoch = Number(input.rootEpoch);
  const domainKeyVersion = Number(
    input.domainKeyVersion || USER_DOMAIN_KEY_VERSION
  );
  const rootKeyId = String(input.rootKeyId || "");
  const domain = String(input.domain || "");
  const resourceType = String(input.resourceType || "");
  const resourceId = normalizedIdentifier(input.resourceId, 512);
  if (
    !Number.isSafeInteger(authUserId) ||
    authUserId < 1 ||
    !Number.isSafeInteger(rootEpoch) ||
    rootEpoch < 1 ||
    !Number.isSafeInteger(domainKeyVersion) ||
    domainKeyVersion < 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(rootKeyId) ||
    !USER_DOMAIN_DOMAINS.includes(domain) ||
    !USER_DOMAIN_RESOURCE_TYPES.includes(resourceType) ||
    !resourceId
  )
    throw new Error("user_domain_wrap_metadata_invalid");
  return {
    authUserId,
    rootKeyId,
    rootEpoch,
    domainKeyVersion,
    domain,
    resourceType,
    resourceId,
  };
}

function userDomainWrapAAD(input = {}) {
  const metadata = normalizedUserDomainMetadata(input);
  return Buffer.from(
    canonicalJson({
      version: USER_DOMAIN_WRAP_VERSION,
      algorithm: USER_DOMAIN_WRAP_ALGORITHM,
      ...metadata,
    }),
    "utf8"
  );
}

function validateUserDomainWrapEnvelope(envelope = {}, expected = {}) {
  const metadata = normalizedUserDomainMetadata(envelope);
  const expectedMetadata = normalizedUserDomainMetadata({
    ...metadata,
    ...expected,
  });
  if (
    envelope.version !== USER_DOMAIN_WRAP_VERSION ||
    envelope.algorithm !== USER_DOMAIN_WRAP_ALGORITHM ||
    canonicalJson(metadata) !== canonicalJson(expectedMetadata) ||
    !parseBase64Url(envelope.iv, 12) ||
    !parseBase64Url(envelope.authTag, 16) ||
    !parseBase64Url(envelope.ciphertext, 32) ||
    !parseBase64Url(envelope.keyCommitment, 32)
  )
    throw new Error("user_domain_wrap_envelope_invalid");
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024)
    throw new Error("user_domain_wrap_envelope_too_large");
  return {
    ...metadata,
    envelopeJson: serialized,
    keyCommitment: envelope.keyCommitment,
  };
}

function importMLKEM768PublicKey(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([MLKEM768_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function importX25519PublicKey(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function rawX25519PublicKey(key) {
  const spki = Buffer.from(key.export({ format: "der", type: "spki" }));
  if (
    spki.length !== X25519_SPKI_PREFIX.length + X25519_PUBLIC_KEY_BYTES ||
    !spki.subarray(0, X25519_SPKI_PREFIX.length).equals(X25519_SPKI_PREFIX)
  )
    throw new Error("xwing_x25519_public_key_invalid");
  return spki.subarray(X25519_SPKI_PREFIX.length);
}

function encapsulateXWing(rawPublicKey) {
  const publicKey = Buffer.isBuffer(rawPublicKey)
    ? rawPublicKey
    : parseBase64Url(rawPublicKey, XWING_PUBLIC_KEY_BYTES);
  if (!publicKey || publicKey.length !== XWING_PUBLIC_KEY_BYTES)
    throw new Error("xwing_public_key_invalid");
  if (
    typeof crypto.encapsulate !== "function" ||
    Number(process.versions.node.split(".")[0]) !== 24
  )
    throw new Error("node24_xwing_runtime_required");

  const mlKemPublic = publicKey.subarray(0, MLKEM768_PUBLIC_KEY_BYTES);
  const x25519Public = publicKey.subarray(MLKEM768_PUBLIC_KEY_BYTES);
  const mlKem = crypto.encapsulate(importMLKEM768PublicKey(mlKemPublic));
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const ephemeralPublic = rawX25519PublicKey(ephemeral.publicKey);
  const x25519Shared = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: importX25519PublicKey(x25519Public),
  });
  const sharedKey = crypto
    .createHash("sha3-256")
    .update(
      Buffer.concat([
        Buffer.from(mlKem.sharedKey),
        x25519Shared,
        ephemeralPublic,
        x25519Public,
        XWING_LABEL,
      ])
    )
    .digest();
  const encapsulatedKey = Buffer.concat([
    Buffer.from(mlKem.ciphertext),
    ephemeralPublic,
  ]);
  if (encapsulatedKey.length !== XWING_CIPHERTEXT_BYTES)
    throw new Error("xwing_ciphertext_invalid");
  return { sharedKey, encapsulatedKey };
}

function transportBinding(input = {}) {
  const metadata = normalizedUserDomainMetadata(input);
  const targetClientId = normalizedIdentifier(input.targetClientId);
  const targetKeyGeneration = Number(input.targetKeyGeneration);
  const targetKEMPublicKey = String(input.targetKEMPublicKey || "");
  if (
    !targetClientId ||
    !Number.isSafeInteger(targetKeyGeneration) ||
    targetKeyGeneration < 1 ||
    !parseBase64Url(targetKEMPublicKey, XWING_PUBLIC_KEY_BYTES)
  )
    throw new Error("user_domain_transport_target_invalid");
  return {
    ...metadata,
    targetClientId,
    targetKeyGeneration,
    targetKEMPublicKey,
  };
}

function sealUserDomainMaterialForDevice({
  keyMaterial,
  targetClientId,
  targetKeyGeneration,
  targetKEMPublicKey,
  now = new Date(),
  ...metadataInput
} = {}) {
  const material = Buffer.from(keyMaterial || []);
  if (material.length !== 32)
    throw new Error("user_domain_key_material_invalid");
  const binding = transportBinding({
    ...metadataInput,
    targetClientId,
    targetKeyGeneration,
    targetKEMPublicKey,
  });
  const kem = encapsulateXWing(targetKEMPublicKey);
  const transportInfo = crypto
    .createHash("sha256")
    .update(
      `athena-user-domain-material-info:v1\u0000${canonicalJson(binding)}`,
      "utf8"
    )
    .digest();
  const wrappingKey = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      kem.sharedKey,
      Buffer.from("athena-user-domain-material-kem:v1", "utf8"),
      transportInfo,
      32
    )
  );
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    USER_DOMAIN_WRAP_ALGORITHM,
    wrappingKey,
    iv
  );
  cipher.setAAD(
    Buffer.from(
      `athena-user-domain-material-aad:v1\u0000${canonicalJson(binding)}`,
      "utf8"
    )
  );
  const ciphertext = Buffer.concat([cipher.update(material), cipher.final()]);
  const sealedKeyMaterial = Buffer.concat([
    iv,
    ciphertext,
    cipher.getAuthTag(),
  ]);
  return {
    version: USER_DOMAIN_TRANSPORT_VERSION,
    suiteId: USER_DOMAIN_TRANSPORT_SUITE,
    ...binding,
    encapsulatedKey: base64Url(kem.encapsulatedKey),
    sealedKeyMaterial: base64Url(sealedKeyMaterial),
    keyCommitment: base64Url(
      crypto.createHash("sha256").update(material).digest()
    ),
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + USER_DOMAIN_TRANSPORT_TTL_MS
    ).toISOString(),
  };
}

function platformWrapMetadata(value = null) {
  const text = String(value || "");
  if (!text.startsWith("enc:"))
    return { platformWrapVersion: null, platformKeyId: null };
  const parts = text.split(":");
  return {
    platformWrapVersion: `${parts[0]}:${parts[1]}`,
    platformKeyId: parts[1] === "v2" ? parts[2] || null : null,
  };
}

module.exports = {
  USER_DOMAIN_DOMAINS,
  USER_DOMAIN_KEY_VERSION,
  USER_DOMAIN_RESOURCE_TYPES,
  USER_DOMAIN_TRANSPORT_SUITE,
  USER_DOMAIN_TRANSPORT_VERSION,
  USER_DOMAIN_WRAP_ALGORITHM,
  USER_DOMAIN_WRAP_VERSION,
  XWING_CIPHERTEXT_BYTES,
  XWING_PUBLIC_KEY_BYTES,
  canonicalJson,
  encapsulateXWing,
  normalizedUserDomainMetadata,
  platformWrapMetadata,
  sealUserDomainMaterialForDevice,
  userDomainWrapAAD,
  validateUserDomainWrapEnvelope,
};
