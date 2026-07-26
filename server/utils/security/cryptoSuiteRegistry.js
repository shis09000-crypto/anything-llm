const nodeCrypto = require("crypto");
const nodeSignatureSupportCache = new Map();

const REGISTRY_VERSION = "athena-crypto-suites:v1";

const PURPOSES = Object.freeze({
  REQUEST_SIGNATURE: "request-signature",
  DEVICE_KEY: "device-key",
  SECURITY_AUDIT_CHECKPOINT: "security-audit-checkpoint",
  RELEASE_EVIDENCE: "release-evidence",
  SESSION_JWT: "session-jwt",
  APNS_PROVIDER_JWT: "apns-provider-jwt",
  COLLECTOR_IPC_SIGNATURE: "collector-ipc-signature",
  COLLECTOR_PAYLOAD_AEAD: "collector-payload-aead",
  DEVICE_KEY_ESTABLISHMENT: "device-key-establishment",
  VAULT_DEVICE_AUTHORIZATION: "vault-device-authorization",
  PASSWORD_CREDENTIAL: "password-credential",
  USER_KEY_DERIVATION: "user-key-derivation",
  OPAQUE_LOGIN: "opaque-login",
  SECRET_ENVELOPE: "secret-envelope",
  CONTENT_OBJECT_AEAD: "content-object-aead",
  CHAT_HISTORY_AEAD: "chat-history-aead",
  CLIENT_CACHE_AEAD: "client-cache-aead",
  CLIENT_VAULT_AEAD: "client-vault-aead",
  PLUGIN_CAPABILITY: "plugin-capability",
  AGENT_REGISTRY: "agent-registry",
  SERVICE_IDENTITY: "service-identity",
  EDGE_TLS_KEY_ESTABLISHMENT: "edge-tls-key-establishment",
  SECURITY_SIEM_DELIVERY: "security-siem-delivery",
});

const SUITE_IDS = Object.freeze({
  REQUEST_DEVICE_P256_V2: "v2-device-p256",
  REQUEST_HMAC_V1: "v1",
  DEVICE_P256_SOFTWARE_V1: "p256-software-v1",
  DEVICE_P256_SECURE_ENCLAVE_V1: "p256-secure-enclave-v1",
  DEVICE_P256_WEBCRYPTO_V1: "p256-v1",
  AUDIT_ED25519_V1: "audit-ed25519-v1",
  RELEASE_EVIDENCE_ED25519_V1: "release-evidence-ed25519-v1",
  SESSION_JWT_HS256_V1: "jwt-hs256-v1",
  APNS_JWT_ES256_V1: "apns-es256-v1",
  COLLECTOR_RSA_SHA256_V2: "collector-rsa-sha256-v2",
  COLLECTOR_AES256_GCM_HKDF_V2: "collector-aes256gcm-hkdf-v2",
  IOS_SE_MLDSA65_EXPERIMENT_V1: "ios-se-mldsa65-exp-v1",
  MLKEM768_EXPERIMENT_V1: "ml-kem-768-exp-v1",
  XWING_MLKEM768_X25519_EXPERIMENT_V1: "x-wing-mlkem768-x25519-exp-v1",
  VAULT_XWING_MLDSA65_EXPERIMENT_V1: "vault-xwing-mldsa65-exp-v1",
  VAULT_XWING_MLDSA65_V1: "vault-xwing-mldsa65-v1",
  PASSWORD_ARGON2ID_V1: "password-argon2id-v1",
  USER_ROOT_HKDF_SHA256_V1: "user-root-hkdf-sha256-v1",
  OPAQUE_RISTRETTO255_V1: "opaque-ristretto255-v1",
  SECRET_AES256_GCM_V2: "secret-aes256gcm-v2",
  CONTENT_OBJECT_AES256_GCM_V1: "content-object-aes256gcm-v1",
  CHAT_AES256_GCM_CHAIN_V2: "chat-aes256gcm-chain-v2",
  CLIENT_CACHE_AES256_GCM_V1: "client-cache-aes256gcm-v1",
  CLIENT_VAULT_AES256_GCM_AESKW_V1: "client-vault-aes256gcm-aeskw-v1",
  PLUGIN_CAPABILITY_HMAC_V1: "plugin-capability-hmac-v1",
  SECURITY_SIEM_HMAC_MTLS_V1: "security-siem-hmac-mtls-v1",
  AUDIT_MLDSA65_V1: "audit-mldsa65-v1",
  RELEASE_EVIDENCE_MLDSA65_V1: "release-evidence-mldsa65-v1",
  REQUEST_DEVICE_MLDSA65_V1: "request-device-mldsa65-v1",
  DEVICE_HYBRID_P256_MLDSA65_V1: "device-hybrid-p256-mldsa65-v1",
  AUDIT_HYBRID_ED25519_MLDSA65_V1: "audit-hybrid-ed25519-mldsa65-v1",
  RELEASE_HYBRID_ED25519_MLDSA65_V1: "release-hybrid-ed25519-mldsa65-v1",
  AGENT_REGISTRY_MLDSA65_V1: "agent-registry-mldsa65-v1",
  SERVICE_IDENTITY_MTLS_V1: "service-identity-mtls-v1",
  EDGE_TLS_X25519_MLKEM768_V1: "edge-tls-x25519mlkem768-v1",
  WEB_PQ_DEVICE_CREDENTIAL_V1: "web-pq-device-credential-v1",
});

const STATUS = Object.freeze({
  ACTIVE: "active",
  COMPATIBILITY: "compatibility",
  PLANNED: "planned",
  DISABLED: "disabled",
});

const REQUIRED_FIELDS = Object.freeze([
  "suiteId",
  "purpose",
  "classicalAlgorithm",
  "pqAlgorithm",
  "parameterSet",
  "keyEncoding",
  "signatureEncoding",
  "minimumClientVersion",
  "status",
  "notBefore",
  "deprecatedAfter",
]);

const suites = [
  {
    suiteId: SUITE_IDS.REQUEST_DEVICE_P256_V2,
    purpose: PURPOSES.REQUEST_SIGNATURE,
    classicalAlgorithm: "ECDSA-P256-SHA256",
    pqAlgorithm: null,
    parameterSet: "secp256r1",
    keyEncoding: "jwk",
    signatureEncoding: "ieee-p1363-base64url",
    minimumClientVersion: "0.0.0",
    status: STATUS.ACTIVE,
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    protocolPrefix: "ATHENA-DEVICE-SIGN-V1",
    nodeAlgorithm: "sha256",
    dsaEncoding: "ieee-p1363",
    authentication: "device-bound",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.REQUEST_HMAC_V1,
    purpose: PURPOSES.REQUEST_SIGNATURE,
    classicalAlgorithm: "HMAC-SHA256",
    pqAlgorithm: null,
    parameterSet: "SHA-256/256-bit-key",
    keyEncoding: "raw-base64url",
    signatureEncoding: "base64url",
    minimumClientVersion: "0.0.0",
    status: STATUS.COMPATIBILITY,
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    protocolPrefix: "ATHENA-SIGN-V1",
    nodeAlgorithm: "sha256",
    authentication: "shared-secret",
    preference: 10,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.DEVICE_P256_SOFTWARE_V1,
    purpose: PURPOSES.DEVICE_KEY,
    classicalAlgorithm: "ECDSA-P256-SHA256",
    pqAlgorithm: null,
    parameterSet: "secp256r1",
    keyEncoding: "jwk",
    signatureEncoding: "ieee-p1363-base64url",
    minimumClientVersion: "0.0.0",
    status: STATUS.ACTIVE,
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "software-nonextractable",
    preference: 80,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.DEVICE_P256_SECURE_ENCLAVE_V1,
    purpose: PURPOSES.DEVICE_KEY,
    classicalAlgorithm: "ECDSA-P256-SHA256",
    pqAlgorithm: null,
    parameterSet: "secp256r1",
    keyEncoding: "jwk",
    signatureEncoding: "ieee-p1363-base64url",
    minimumClientVersion: "0.0.0",
    status: STATUS.ACTIVE,
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "apple-secure-enclave",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.DEVICE_P256_WEBCRYPTO_V1,
    purpose: PURPOSES.DEVICE_KEY,
    classicalAlgorithm: "ECDSA-P256-SHA256",
    pqAlgorithm: null,
    parameterSet: "secp256r1",
    keyEncoding: "jwk",
    signatureEncoding: "ieee-p1363-base64url",
    minimumClientVersion: "0.0.0",
    status: STATUS.COMPATIBILITY,
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "webcrypto-nonextractable",
    preference: 20,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.AUDIT_ED25519_V1,
    purpose: PURPOSES.SECURITY_AUDIT_CHECKPOINT,
    classicalAlgorithm: "Ed25519",
    pqAlgorithm: null,
    parameterSet: "Ed25519",
    keyEncoding: "spki-der-base64",
    signatureEncoding: "base64",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    nodeAlgorithm: null,
    preference: 100,
    aliases: ["ed25519"],
  },
  {
    suiteId: SUITE_IDS.RELEASE_EVIDENCE_ED25519_V1,
    purpose: PURPOSES.RELEASE_EVIDENCE,
    classicalAlgorithm: "Ed25519",
    pqAlgorithm: null,
    parameterSet: "Ed25519",
    keyEncoding: "pem-spki",
    signatureEncoding: "base64url",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    nodeAlgorithm: null,
    preference: 100,
    aliases: ["ed25519"],
  },
  {
    suiteId: SUITE_IDS.SESSION_JWT_HS256_V1,
    purpose: PURPOSES.SESSION_JWT,
    classicalAlgorithm: "HMAC-SHA256",
    pqAlgorithm: null,
    parameterSet: "SHA-256/256-bit-key",
    keyEncoding: "raw-secret",
    signatureEncoding: "jose-compact",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    joseAlgorithm: "HS256",
    preference: 100,
    aliases: ["HS256"],
  },
  {
    suiteId: SUITE_IDS.APNS_JWT_ES256_V1,
    purpose: PURPOSES.APNS_PROVIDER_JWT,
    classicalAlgorithm: "ECDSA-P256-SHA256",
    pqAlgorithm: null,
    parameterSet: "secp256r1",
    keyEncoding: "pem-pkcs8",
    signatureEncoding: "jose-compact",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    joseAlgorithm: "ES256",
    preference: 100,
    aliases: ["ES256"],
  },
  {
    suiteId: SUITE_IDS.COLLECTOR_RSA_SHA256_V2,
    purpose: PURPOSES.COLLECTOR_IPC_SIGNATURE,
    classicalAlgorithm: "RSA-PKCS1-v1_5-SHA256",
    pqAlgorithm: null,
    parameterSet: "RSA-2048",
    keyEncoding: "pem-spki/pkcs8",
    signatureEncoding: "base64",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2020-01-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "server-storage-file",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.COLLECTOR_AES256_GCM_HKDF_V2,
    purpose: PURPOSES.COLLECTOR_PAYLOAD_AEAD,
    classicalAlgorithm: "AES-256-GCM+HKDF-SHA256",
    pqAlgorithm: null,
    parameterSet: "AES-256/GCM-96/HKDF-SHA256",
    keyEncoding: "raw-256-bit-root",
    signatureEncoding: null,
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "shared-read-only-file",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.PASSWORD_ARGON2ID_V1,
    purpose: PURPOSES.PASSWORD_CREDENTIAL,
    classicalAlgorithm: "Argon2id",
    pqAlgorithm: null,
    parameterSet: "v=19,m=65536,t=3,p=1,output=32",
    keyEncoding: "PHC-string+optional-pepper",
    signatureEncoding: null,
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "auth-db-and-server-pepper-file",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.USER_ROOT_HKDF_SHA256_V1,
    purpose: PURPOSES.USER_KEY_DERIVATION,
    classicalAlgorithm: "HKDF-SHA256",
    pqAlgorithm: null,
    parameterSet: "HKDF-256/auth-user-id/domain/key-epoch",
    keyEncoding: "random-256-bit-user-root",
    signatureEncoding: null,
    minimumClientVersion: "2.4.0",
    status: STATUS.ACTIVE,
    notBefore: "2026-07-23T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage:
      "wrapped-by-password-kek-or-vault-xwing-mldsa65-device-envelope",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.OPAQUE_RISTRETTO255_V1,
    purpose: PURPOSES.OPAQUE_LOGIN,
    classicalAlgorithm: "OPAQUE-RFC9807",
    pqAlgorithm: null,
    parameterSet: "ristretto255-default-group",
    keyEncoding: "serenity-kit-opaque-record",
    signatureEncoding: null,
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "client-secret+encrypted-server-setup",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.SECRET_AES256_GCM_V2,
    purpose: PURPOSES.SECRET_ENVELOPE,
    classicalAlgorithm: "AES-256-GCM",
    pqAlgorithm: null,
    parameterSet: "AES-256/GCM-96/purpose-AAD",
    keyEncoding: "key-custody-descriptor",
    signatureEncoding: null,
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "key-custody-provider",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.CONTENT_OBJECT_AES256_GCM_V1,
    purpose: PURPOSES.CONTENT_OBJECT_AEAD,
    classicalAlgorithm: "AES-256-GCM+wrapped-random-DEK",
    pqAlgorithm: null,
    parameterSet: "chunked-GCM-96/purpose-AAD/SHA-256",
    keyEncoding: "athena-content-object:v1",
    signatureEncoding: null,
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "per-object-DEK+key-custody-wrapping-key",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.CHAT_AES256_GCM_CHAIN_V2,
    purpose: PURPOSES.CHAT_HISTORY_AEAD,
    classicalAlgorithm: "AES-256-GCM+SHA-256-Hash-Chain",
    pqAlgorithm: null,
    parameterSet: "per-conversation-DEK/GCM-96/canonical-chain",
    keyEncoding: "athena-chat-history:v2",
    signatureEncoding: null,
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "wrapped-conversation-key+key-custody-provider",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.CLIENT_CACHE_AES256_GCM_V1,
    purpose: PURPOSES.CLIENT_CACHE_AEAD,
    classicalAlgorithm: "AES-256-GCM",
    pqAlgorithm: null,
    parameterSet: "AES-256/GCM-96/namespace-AAD",
    keyEncoding: "non-extractable-webcrypto-or-keychain-key",
    signatureEncoding: null,
    minimumClientVersion: "2.3.0",
    status: STATUS.ACTIVE,
    notBefore: "2026-07-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "client-protected-storage",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.CLIENT_VAULT_AES256_GCM_AESKW_V1,
    purpose: PURPOSES.CLIENT_VAULT_AEAD,
    classicalAlgorithm: "AES-256-GCM+AES-KW-256",
    pqAlgorithm: null,
    parameterSet: "per-item-key/GCM-96/AES-KW",
    keyEncoding: "athena-vault-item:v1",
    signatureEncoding: null,
    minimumClientVersion: "2.3.0",
    status: STATUS.ACTIVE,
    notBefore: "2026-07-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "client-protected-key-hierarchy",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.PLUGIN_CAPABILITY_HMAC_V1,
    purpose: PURPOSES.PLUGIN_CAPABILITY,
    classicalAlgorithm: "HKDF-SHA256+HMAC-SHA256",
    pqAlgorithm: null,
    parameterSet: "HKDF-256/HMAC-256/ttl<=60s/one-time-nonce",
    keyEncoding: "base64url-capability-envelope",
    signatureEncoding: "base64url",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "key-custody-derived-runtime-key",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.SECURITY_SIEM_HMAC_MTLS_V1,
    purpose: PURPOSES.SECURITY_SIEM_DELIVERY,
    classicalAlgorithm: "HMAC-SHA256+optional-mTLS",
    pqAlgorithm: null,
    parameterSet: "HMAC-256/TLS-edge-provider",
    keyEncoding: "restricted-files",
    signatureEncoding: "base64url",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-01T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "server-restricted-files",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.IOS_SE_MLDSA65_EXPERIMENT_V1,
    purpose: PURPOSES.DEVICE_KEY,
    classicalAlgorithm: null,
    pqAlgorithm: "ML-DSA-65",
    parameterSet: "FIPS-204-ML-DSA-65",
    keyEncoding: "cryptokit-raw-public-key",
    signatureEncoding: "raw",
    minimumClientVersion: "2.4.0",
    status: STATUS.PLANNED,
    notBefore: null,
    deprecatedAfter: null,
    keyStorage: "apple-secure-enclave-experiment",
    preference: 0,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.MLKEM768_EXPERIMENT_V1,
    purpose: PURPOSES.DEVICE_KEY_ESTABLISHMENT,
    classicalAlgorithm: null,
    pqAlgorithm: "ML-KEM-768",
    parameterSet: "FIPS-203-ML-KEM-768",
    keyEncoding: "cryptokit-raw-public-key",
    signatureEncoding: null,
    minimumClientVersion: "2.4.0",
    status: STATUS.PLANNED,
    notBefore: null,
    deprecatedAfter: null,
    keyStorage: "apple-secure-enclave-or-ephemeral",
    preference: 0,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.XWING_MLKEM768_X25519_EXPERIMENT_V1,
    purpose: PURPOSES.DEVICE_KEY_ESTABLISHMENT,
    classicalAlgorithm: "X25519",
    pqAlgorithm: "ML-KEM-768",
    parameterSet: "X-Wing-ML-KEM-768-X25519",
    keyEncoding: "cryptokit-raw-public-key",
    signatureEncoding: null,
    minimumClientVersion: "2.4.0",
    status: STATUS.PLANNED,
    notBefore: null,
    deprecatedAfter: null,
    keyStorage: "ephemeral-software-experiment",
    preference: 0,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.VAULT_XWING_MLDSA65_EXPERIMENT_V1,
    purpose: PURPOSES.VAULT_DEVICE_AUTHORIZATION,
    classicalAlgorithm: "X25519",
    pqAlgorithm: "ML-KEM-768+ML-DSA-65",
    parameterSet: "X-Wing-ML-KEM-768-X25519+ML-DSA-65",
    keyEncoding: "athena-pq-authorization-envelope-v1",
    signatureEncoding: "raw",
    minimumClientVersion: "2.4.0",
    status: STATUS.PLANNED,
    notBefore: null,
    deprecatedAfter: null,
    keyStorage: "secure-enclave-plus-ephemeral",
    preference: 0,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.DEVICE_HYBRID_P256_MLDSA65_V1,
    purpose: PURPOSES.REQUEST_SIGNATURE,
    classicalAlgorithm: "ECDSA-P256-SHA256",
    pqAlgorithm: "ML-DSA-65",
    parameterSet: "secp256r1+ML-DSA-65",
    keyEncoding: "composite-cbor-v1",
    signatureEncoding: "composite-base64url-v1",
    minimumClientVersion: "2.4.0",
    status: STATUS.ACTIVE,
    notBefore: "2026-07-22T00:00:00.000Z",
    deprecatedAfter: null,
    preference: 0,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.VAULT_XWING_MLDSA65_V1,
    purpose: PURPOSES.VAULT_DEVICE_AUTHORIZATION,
    classicalAlgorithm: "X25519+P-256",
    pqAlgorithm: "ML-KEM-768+ML-DSA-65",
    parameterSet: "X-Wing-ML-KEM-768-X25519+P-256+ML-DSA-65",
    keyEncoding: "athena-vault-key-envelope-v1",
    signatureEncoding: "composite-base64url-v1",
    minimumClientVersion: "2.4.0",
    status: STATUS.ACTIVE,
    notBefore: "2026-07-22T00:00:00.000Z",
    deprecatedAfter: null,
    keyStorage: "secure-enclave-signing-plus-software-kem",
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.AUDIT_HYBRID_ED25519_MLDSA65_V1,
    purpose: PURPOSES.SECURITY_AUDIT_CHECKPOINT,
    classicalAlgorithm: "Ed25519",
    pqAlgorithm: "ML-DSA-65",
    parameterSet: "Ed25519+ML-DSA-65",
    keyEncoding: "composite-cbor-v1",
    signatureEncoding: "composite-base64url-v1",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-22T00:00:00.000Z",
    deprecatedAfter: null,
    preference: 0,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.RELEASE_HYBRID_ED25519_MLDSA65_V1,
    purpose: PURPOSES.RELEASE_EVIDENCE,
    classicalAlgorithm: "Ed25519",
    pqAlgorithm: "ML-DSA-65",
    parameterSet: "Ed25519+ML-DSA-65",
    keyEncoding: "composite-cbor-v1",
    signatureEncoding: "composite-base64url-v1",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-22T00:00:00.000Z",
    deprecatedAfter: null,
    preference: 0,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.AUDIT_MLDSA65_V1,
    purpose: PURPOSES.SECURITY_AUDIT_CHECKPOINT,
    classicalAlgorithm: null,
    pqAlgorithm: "ML-DSA-65",
    parameterSet: "ML-DSA-65",
    keyEncoding: "spki-der-base64",
    signatureEncoding: "base64",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-22T00:00:00.000Z",
    deprecatedAfter: null,
    nodeAlgorithm: null,
    preference: 0,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.RELEASE_EVIDENCE_MLDSA65_V1,
    purpose: PURPOSES.RELEASE_EVIDENCE,
    classicalAlgorithm: null,
    pqAlgorithm: "ML-DSA-65",
    parameterSet: "ML-DSA-65",
    keyEncoding: "spki-der-base64",
    signatureEncoding: "base64",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-22T00:00:00.000Z",
    deprecatedAfter: null,
    nodeAlgorithm: null,
    preference: 0,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.REQUEST_DEVICE_MLDSA65_V1,
    purpose: PURPOSES.REQUEST_SIGNATURE,
    classicalAlgorithm: null,
    pqAlgorithm: "ML-DSA-65",
    parameterSet: "ML-DSA-65",
    keyEncoding: "raw-base64url",
    signatureEncoding: "raw-base64url",
    minimumClientVersion: "2.4.0",
    status: STATUS.ACTIVE,
    notBefore: "2026-07-22T00:00:00.000Z",
    deprecatedAfter: null,
    nodeAlgorithm: null,
    preference: 0,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.AGENT_REGISTRY_MLDSA65_V1,
    purpose: PURPOSES.AGENT_REGISTRY,
    classicalAlgorithm: null,
    pqAlgorithm: "ML-DSA-65",
    parameterSet: "ML-DSA-65",
    keyEncoding: "spki-der-base64",
    signatureEncoding: "base64",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-22T00:00:00.000Z",
    deprecatedAfter: null,
    nodeAlgorithm: null,
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.SERVICE_IDENTITY_MTLS_V1,
    purpose: PURPOSES.SERVICE_IDENTITY,
    classicalAlgorithm: "TLS-1.3-mTLS",
    pqAlgorithm: null,
    parameterSet: "X.509-SPIFFE-SAN",
    keyEncoding: "PEM",
    signatureEncoding: "X.509",
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-22T00:00:00.000Z",
    deprecatedAfter: null,
    preference: 100,
    aliases: [],
  },
  {
    suiteId: SUITE_IDS.EDGE_TLS_X25519_MLKEM768_V1,
    purpose: PURPOSES.EDGE_TLS_KEY_ESTABLISHMENT,
    classicalAlgorithm: "X25519",
    pqAlgorithm: "ML-KEM-768",
    parameterSet: "X25519MLKEM768/TLS-1.3",
    keyEncoding: "TLS-1.3-key-share",
    signatureEncoding: null,
    minimumClientVersion: null,
    status: STATUS.ACTIVE,
    notBefore: "2026-07-22T00:00:00.000Z",
    deprecatedAfter: null,
    preference: 100,
    aliases: ["X25519MLKEM768"],
  },
  {
    suiteId: SUITE_IDS.WEB_PQ_DEVICE_CREDENTIAL_V1,
    purpose: PURPOSES.DEVICE_KEY,
    classicalAlgorithm: "WebAuthn/FIDO2",
    pqAlgorithm: "ML-DSA-65",
    parameterSet: "browser-fido-pq-profile-pending",
    keyEncoding: "COSE-pending-standard",
    signatureEncoding: "WebAuthn-assertion",
    minimumClientVersion: null,
    status: STATUS.PLANNED,
    notBefore: null,
    deprecatedAfter: null,
    preference: 0,
    aliases: [],
  },
];

function validateRegistry(entries = suites) {
  const errors = [];
  const suiteIds = new Set();
  for (const suite of entries) {
    for (const field of REQUIRED_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(suite, field))
        errors.push(`${suite.suiteId || "unknown"}:missing:${field}`);
    }
    if (!suite.suiteId || suiteIds.has(suite.suiteId))
      errors.push(`${suite.suiteId || "unknown"}:duplicate_suite_id`);
    suiteIds.add(suite.suiteId);
    if (!suite.purpose) errors.push(`${suite.suiteId}:missing_purpose`);
    if (!suite.classicalAlgorithm && !suite.pqAlgorithm)
      errors.push(`${suite.suiteId}:missing_algorithm`);
    if (!Object.values(STATUS).includes(suite.status))
      errors.push(`${suite.suiteId}:invalid_status`);
    for (const field of ["notBefore", "deprecatedAfter"]) {
      if (suite[field] && !Number.isFinite(Date.parse(suite[field])))
        errors.push(`${suite.suiteId}:invalid_${field}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

const registryValidation = validateRegistry();
if (!registryValidation.valid) {
  throw new Error(
    `crypto_suite_registry_invalid:${registryValidation.errors.join(",")}`
  );
}

const CRYPTO_SUITES = Object.freeze(
  suites.map((suite) =>
    Object.freeze({
      ...suite,
      aliases: Object.freeze([...(suite.aliases || [])]),
    })
  )
);

function parseVersion(value) {
  const match = String(value || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index])
      return leftParts[index] - rightParts[index];
  }
  return 0;
}

function suiteSupportsClient(suite, clientVersion = null) {
  if (!suite?.minimumClientVersion) return true;
  return (
    compareVersions(clientVersion || "0.0.0", suite.minimumClientVersion) >= 0
  );
}

function suiteAvailableAt(
  suite,
  at = Date.now(),
  { allowDeprecated = false } = {}
) {
  const timestamp = at instanceof Date ? at.getTime() : Number(at);
  if (!Number.isFinite(timestamp)) return false;
  if ([STATUS.PLANNED, STATUS.DISABLED].includes(suite.status)) return false;
  if (suite.notBefore && timestamp < Date.parse(suite.notBefore)) return false;
  if (
    suite.deprecatedAfter &&
    timestamp >= Date.parse(suite.deprecatedAfter) &&
    !allowDeprecated
  )
    return false;
  return true;
}

function cryptoSuite(
  identifier,
  { purpose = null, at = Date.now(), allowDeprecated = false } = {}
) {
  const value = String(identifier || "").trim();
  if (!value) return null;
  const suite = CRYPTO_SUITES.find(
    (entry) =>
      (!purpose || entry.purpose === purpose) &&
      (entry.suiteId === value || entry.aliases.includes(value))
  );
  if (!suite || !suiteAvailableAt(suite, at, { allowDeprecated })) return null;
  return suite;
}

function registeredCryptoSuite(identifier, { purpose = null } = {}) {
  const value = String(identifier || "").trim();
  if (!value) return null;
  return (
    CRYPTO_SUITES.find(
      (entry) =>
        (!purpose || entry.purpose === purpose) &&
        (entry.suiteId === value || entry.aliases.includes(value))
    ) || null
  );
}

function keyMetadataForSuite(
  identifier,
  { purpose = null, origin = null, hardwareProtection = null } = {}
) {
  const suite = registeredCryptoSuite(identifier, { purpose });
  if (!suite) return null;
  return {
    algorithm: suite.classicalAlgorithm || suite.pqAlgorithm || "unknown",
    parameterSet: suite.parameterSet,
    keyOrigin: origin || suite.keyStorage || "unknown",
    hardwareProtection:
      hardwareProtection ||
      (String(suite.keyStorage || "").includes("secure-enclave")
        ? "client-asserted-hardware-backed"
        : "not-attested"),
  };
}

function preferredCryptoSuite(
  purpose,
  { at = Date.now(), clientVersion = null } = {}
) {
  return (
    CRYPTO_SUITES.filter(
      (suite) =>
        suite.purpose === purpose &&
        suite.status === STATUS.ACTIVE &&
        suiteAvailableAt(suite, at) &&
        suiteSupportsClient(suite, clientVersion)
    ).sort(
      (left, right) =>
        Number(right.preference || 0) - Number(left.preference || 0)
    )[0] || null
  );
}

function publicCryptoSuite(suite) {
  if (!suite) return null;
  const descriptor = Object.fromEntries(
    REQUIRED_FIELDS.map((field) => [field, suite[field] ?? null])
  );
  const runtimeVerifiedPurpose = [
    PURPOSES.REQUEST_SIGNATURE,
    PURPOSES.SECURITY_AUDIT_CHECKPOINT,
    PURPOSES.RELEASE_EVIDENCE,
    PURPOSES.AGENT_REGISTRY,
  ].includes(suite.purpose);
  if (
    suite.pqAlgorithm &&
    runtimeVerifiedPurpose &&
    !supportsNodeSignatureSuite(
      suite.classicalAlgorithm === null
        ? suite
        : registeredCryptoSuite(SUITE_IDS.REQUEST_DEVICE_MLDSA65_V1, {
            purpose: PURPOSES.REQUEST_SIGNATURE,
          })
    )
  )
    descriptor.status = "runtime-unavailable";
  return descriptor;
}

function publicCryptoSuites({ purposes = null } = {}) {
  const acceptedPurposes = purposes ? new Set(purposes) : null;
  return CRYPTO_SUITES.filter(
    (suite) => !acceptedPurposes || acceptedPurposes.has(suite.purpose)
  ).map(publicCryptoSuite);
}

function joseAlgorithmsForPurpose(purpose) {
  return CRYPTO_SUITES.filter(
    (suite) =>
      suite.purpose === purpose &&
      suite.joseAlgorithm &&
      suiteAvailableAt(suite)
  ).map((suite) => suite.joseAlgorithm);
}

function signatureBufferEncoding(suite) {
  const encoding = String(suite?.signatureEncoding || "").toLowerCase();
  if (encoding.endsWith("base64url")) return "base64url";
  if (encoding.endsWith("base64")) return "base64";
  return null;
}

function supportsNodeSignatureSuite(suite) {
  if (!suite) return false;
  if (suite.classicalAlgorithm === null && suite.pqAlgorithm === "ML-DSA-65") {
    if (nodeSignatureSupportCache.has(suite.suiteId))
      return nodeSignatureSupportCache.get(suite.suiteId);
    let supported = false;
    try {
      const { publicKey } = nodeCrypto.generateKeyPairSync("ml-dsa-65");
      supported = Boolean(publicKey) && Boolean(signatureBufferEncoding(suite));
    } catch {}
    nodeSignatureSupportCache.set(suite.suiteId, supported);
    return supported;
  }
  if (suite.pqAlgorithm) return false;
  if (suite.classicalAlgorithm === "Ed25519") {
    return (
      suite.nodeAlgorithm === null && Boolean(signatureBufferEncoding(suite))
    );
  }
  if (suite.classicalAlgorithm === "ECDSA-P256-SHA256") {
    return (
      suite.nodeAlgorithm === "sha256" &&
      suite.dsaEncoding === "ieee-p1363" &&
      Boolean(signatureBufferEncoding(suite))
    );
  }
  return false;
}

function nodeSignatureKey(suite, key) {
  if (suite.classicalAlgorithm !== "ECDSA-P256-SHA256") return key;
  return { key, dsaEncoding: suite.dsaEncoding };
}

function nodeSignatureAlgorithm(suite) {
  if (suite?.pqAlgorithm === "ML-DSA-65") return null;
  return suite?.nodeAlgorithm;
}

function signWithCryptoSuite({ suite, data, privateKey }) {
  const { observeSuiteOperation } = require("./cryptoObservability");
  if (!supportsNodeSignatureSuite(suite)) {
    observeSuiteOperation(suite, "sign", "runtime_unavailable");
    throw new Error("crypto_suite_signing_implementation_unavailable");
  }
  try {
    const signature = nodeCrypto.sign(
      nodeSignatureAlgorithm(suite),
      Buffer.isBuffer(data) ? data : Buffer.from(data),
      nodeSignatureKey(suite, privateKey)
    );
    observeSuiteOperation(suite, "sign", "success");
    return signature;
  } catch (error) {
    observeSuiteOperation(suite, "sign", "failure");
    throw error;
  }
}

function verifyWithCryptoSuite({ suite, data, publicKey, signature }) {
  const {
    observeSignatureVerification,
    observeVerificationFailure,
  } = require("./cryptoObservability");
  const startedAt = process.hrtime.bigint();
  const family = suite?.pqAlgorithm ? "post_quantum" : "classical";
  if (!supportsNodeSignatureSuite(suite)) {
    observeSignatureVerification(suite, startedAt, "runtime_unavailable");
    observeVerificationFailure("runtime_unavailable", family);
    return false;
  }
  try {
    const signatureBytes = Buffer.isBuffer(signature)
      ? signature
      : Buffer.from(String(signature || ""), signatureBufferEncoding(suite));
    const valid = nodeCrypto.verify(
      nodeSignatureAlgorithm(suite),
      Buffer.isBuffer(data) ? data : Buffer.from(data),
      nodeSignatureKey(suite, publicKey),
      signatureBytes
    );
    observeSignatureVerification(suite, startedAt, valid ? "valid" : "invalid");
    if (!valid) observeVerificationFailure("invalid_signature", family);
    return valid;
  } catch {
    observeSignatureVerification(suite, startedAt, "error");
    observeVerificationFailure("corrupt_public_key", family);
    return false;
  }
}

module.exports = {
  CRYPTO_SUITES,
  PURPOSES,
  REGISTRY_VERSION,
  STATUS,
  SUITE_IDS,
  compareVersions,
  cryptoSuite,
  joseAlgorithmsForPurpose,
  preferredCryptoSuite,
  publicCryptoSuite,
  publicCryptoSuites,
  registeredCryptoSuite,
  keyMetadataForSuite,
  signatureBufferEncoding,
  signWithCryptoSuite,
  supportsNodeSignatureSuite,
  suiteAvailableAt,
  suiteSupportsClient,
  validateRegistry,
  verifyWithCryptoSuite,
};
