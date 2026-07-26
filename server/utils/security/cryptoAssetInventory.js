const { SUITE_IDS, registeredCryptoSuite } = require("./cryptoSuiteRegistry");
const { CONFIDENTIALITY_HORIZONS } = require("../dataAccess/dataAccessPolicy");

const INVENTORY_VERSION = "athena-crypto-assets:v1";

const CRYPTO_ASSETS = Object.freeze(
  [
    {
      assetId: "collector.ipc.request-signature",
      owner: "collector-platform",
      purpose: "Authenticate API-to-Collector control requests",
      suiteIds: [SUITE_IDS.COLLECTOR_RSA_SHA256_V2],
      keySource: "server-generated persisted key pair",
      keyLocation: "storage/comkey; Collector receives public key only",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.ONE_TO_FIVE_YEARS,
      lifecycle: "service-instance",
      status: "active",
      pqReadiness: "hybrid-signature-candidate",
      sourceFiles: ["server/utils/comKey", "collector/utils/comKey"],
    },
    {
      assetId: "collector.source-payload-aead",
      owner: "collector-platform",
      purpose: "Protect source connector parameters at rest and in replay URLs",
      suiteIds: [SUITE_IDS.COLLECTOR_AES256_GCM_HKDF_V2],
      keySource: "local persisted 256-bit root with purpose HKDF",
      keyLocation: "read-only storage/comkey/ipc-payload.key",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "service-instance",
      status: "active",
      pqReadiness: "symmetric-256-sufficient",
      sourceFiles: ["collector/utils/EncryptionWorker"],
    },
    {
      assetId: "collector.source-payload-cbc-legacy-read",
      owner: "collector-platform",
      purpose: "Explicit migration-only read compatibility",
      suiteIds: [],
      algorithms: ["AES-256-CBC (legacy, unauthenticated)"],
      keySource: "legacy derived root",
      keyLocation: "read-only storage/comkey/ipc-payload.key",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "time-bounded-migration",
      status: "disabled-by-default",
      pqReadiness: "must-retire-not-upgrade",
      sourceFiles: ["collector/utils/EncryptionWorker"],
    },
    {
      assetId: "request-signing.device",
      owner: "identity-platform",
      purpose: "Bind high-risk API requests to registered devices",
      suiteIds: [
        SUITE_IDS.REQUEST_DEVICE_P256_V2,
        SUITE_IDS.REQUEST_DEVICE_MLDSA65_V1,
        SUITE_IDS.REQUEST_HMAC_V1,
      ],
      keySource: "client generated; HMAC compatibility issued by server",
      keyLocation: "client secure storage and encrypted server metadata",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.FIVE_TO_TEN_YEARS,
      lifecycle: "device-registration",
      status: "active",
      pqReadiness: "ios26-high-risk-hybrid-active",
      sourceFiles: [
        "server/utils/requestSigning",
        "server/utils/clientIdentity",
      ],
    },
    {
      assetId: "identity.passkey",
      owner: "identity-platform",
      purpose: "Phishing-resistant user authentication",
      suiteIds: [],
      algorithms: ["WebAuthn COSE algorithm selected by authenticator"],
      keySource: "platform or roaming authenticator",
      keyLocation:
        "public key in Auth DB; private key remains in authenticator",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "credential",
      status: "active",
      pqReadiness: "standards-ecosystem-dependent",
      sourceFiles: ["server/endpoints/authPasskeys.js"],
    },
    {
      assetId: "identity.password-credential",
      owner: "identity-platform",
      purpose: "Verify password credentials with memory-hard hashing",
      suiteIds: [SUITE_IDS.PASSWORD_ARGON2ID_V1],
      algorithms: ["bcrypt (read-and-upgrade compatibility only)"],
      keySource: "user password with optional server-side pepper",
      keyLocation: "PHC hash in Auth DB; pepper in restricted file",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "credential",
      status: "active-with-bcrypt-read-migration",
      pqReadiness: "password-hardening-independent-of-pq-public-key-crypto",
      sourceFiles: ["server/utils/security/passwordCredential.js"],
    },
    {
      assetId: "identity.user-root-key-hierarchy",
      owner: "identity-platform",
      purpose:
        "Derive isolated Data, File and Agent keys from a random per-user root",
      suiteIds: [SUITE_IDS.USER_ROOT_HKDF_SHA256_V1],
      keySource: "client-generated random 256-bit User Root Key",
      keyLocation:
        "device-only protected client storage; X-Wing v2 envelopes carry only encrypted Root material",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "user-root-key-epoch",
      status: "phase1-client-root-and-shared-auth-envelope-active",
      pqReadiness:
        "symmetric-256-derivation; X-Wing hybrid KEM transports but never derives the persistent root",
      sourceFiles: [
        "server/utils/security/userKeyDerivation.js",
        "server/repositories/vaultRepository.js",
        "ios/Athena/Athena/Core/Security/VaultHybridKeyDistribution.swift",
      ],
    },
    {
      assetId: "identity.opaque-trusted-device",
      owner: "identity-platform",
      purpose: "Password-authenticated trusted-device quick login",
      suiteIds: [SUITE_IDS.OPAQUE_RISTRETTO255_V1],
      keySource: "client secret and server OPAQUE setup",
      keyLocation:
        "encrypted Auth DB registration record and managed server setup",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.FIVE_TO_TEN_YEARS,
      lifecycle: "trusted-device-registration",
      status: "active",
      pqReadiness: "hybrid-device-authorization-candidate-not-kem-replacement",
      sourceFiles: ["server/endpoints/authZkLogin.js"],
    },
    {
      assetId: "session.jwt",
      owner: "identity-platform",
      purpose: "Short-lived authenticated session assertion",
      suiteIds: [SUITE_IDS.SESSION_JWT_HS256_V1],
      keySource: "server secret custody",
      keyLocation: "server runtime only",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.LESS_THAN_ONE_YEAR,
      lifecycle: "session",
      status: "active",
      pqReadiness: "not-priority-short-lived-symmetric",
      sourceFiles: ["server/utils/http"],
    },
    {
      assetId: "security-audit.checkpoint",
      owner: "security-platform",
      purpose: "Tamper-evident ledger checkpoint signatures",
      suiteIds: [SUITE_IDS.AUDIT_ED25519_V1, SUITE_IDS.AUDIT_MLDSA65_V1],
      keySource: "HKDF-separated key custody material",
      keyLocation: "server key provider; public verification evidence in DB",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "audit-retention",
      status: "active-multisignature-envelope",
      pqReadiness: "ed25519-plus-ml-dsa65-required-in-enterprise-production",
      sourceFiles: ["server/utils/security/auditLedger.js"],
    },
    {
      assetId: "release.evidence",
      owner: "release-engineering",
      purpose: "Sign release provenance evidence",
      suiteIds: [
        SUITE_IDS.RELEASE_EVIDENCE_ED25519_V1,
        SUITE_IDS.RELEASE_EVIDENCE_MLDSA65_V1,
      ],
      keySource: "release signing provider",
      keyLocation: "release environment",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "release-retention",
      status: "active",
      pqReadiness: "hybrid-signature-required-in-production-gate",
      sourceFiles: ["server/utils/security/releaseEvidence.js"],
    },
    {
      assetId: "push.apns-provider-token",
      owner: "mobile-platform",
      purpose: "Authenticate APNs provider requests",
      suiteIds: [SUITE_IDS.APNS_JWT_ES256_V1],
      keySource: "Apple developer key",
      keyLocation: "server secret provider",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.ONE_TO_FIVE_YEARS,
      lifecycle: "provider-credential",
      status: "active",
      pqReadiness: "vendor-controlled",
      sourceFiles: ["server/utils/nativePush/apnsProvider.js"],
    },
    {
      assetId: "data-at-rest.secret-envelope",
      owner: "data-platform",
      purpose: "Encrypt sensitive server-side row and configuration secrets",
      suiteIds: [SUITE_IDS.SECRET_AES256_GCM_V2],
      keySource: "Key Custody provider",
      keyLocation: "provider-controlled key; key ID stored with ciphertext",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "data-lifecycle",
      status: "active",
      pqReadiness: "symmetric-256-sufficient",
      sourceFiles: ["server/utils/security/encryption.js"],
    },
    {
      assetId: "data-at-rest.content-object",
      owner: "data-platform",
      purpose: "Encrypt large immutable content outside relational storage",
      suiteIds: [SUITE_IDS.CONTENT_OBJECT_AES256_GCM_V1],
      keySource: "per-object random DEK wrapped by Key Custody",
      keyLocation: "wrapped DEK metadata and protected object provider",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "content-object-reference-lifecycle",
      status: "active",
      pqReadiness: "symmetric-256-sufficient; wrapping agility preserved",
      sourceFiles: [
        "server/utils/security/keyCustody/contentObjectCrypto.js",
        "server/models/contentObject.js",
      ],
    },
    {
      assetId: "data-at-rest.chat-history",
      owner: "conversation-platform",
      purpose: "Encrypt chat fields and make ordered history tamper-evident",
      suiteIds: [SUITE_IDS.CHAT_AES256_GCM_CHAIN_V2],
      keySource: "per-conversation random key wrapped by Key Custody",
      keyLocation: "wrapped conversation key and crypto metadata tables",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "conversation",
      status: "active",
      pqReadiness: "symmetric-256-sufficient; key wrapping remains agile",
      sourceFiles: ["server/utils/security/chatHistorySerialEncryption.js"],
    },
    {
      assetId: "client.sync-cache-archive",
      owner: "sync-platform",
      purpose: "Protect persisted cross-device cache and descriptor archives",
      suiteIds: [SUITE_IDS.CLIENT_CACHE_AES256_GCM_V1],
      keySource: "client-generated non-exportable or protected key",
      keyLocation: "Web IndexedDB or iOS protected secure storage",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.ONE_TO_FIVE_YEARS,
      lifecycle: "account-and-device-cache",
      status: "active-with-web-plaintext-fallback-for-unsupported-platforms",
      pqReadiness: "symmetric-256-sufficient",
      sourceFiles: [
        "frontend/src/utils/security/localCacheCrypto.js",
        "ios/Athena/Athena/Core/State/PersistentServerStateStore.swift",
      ],
    },
    {
      assetId: "client.vault-key-hierarchy",
      owner: "vault-platform",
      purpose: "Encrypt Vault items with isolated per-item keys",
      suiteIds: [SUITE_IDS.CLIENT_VAULT_AES256_GCM_AESKW_V1],
      algorithms: ["PBKDF2-SHA256 recovery wrapping"],
      keySource: "client-generated VMK and per-item random keys",
      keyLocation: "non-exportable WebCrypto hierarchy in IndexedDB",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "account-vault",
      status: "active",
      pqReadiness: "new-device-authorization-hybrid-kem-experiment",
      sourceFiles: ["frontend/src/utils/security/vaultCrypto.js"],
    },
    {
      assetId: "vault.cross-device-key-distribution",
      owner: "vault-platform",
      purpose: "Distribute UMK and VMK to an authorized new device",
      suiteIds: [SUITE_IDS.VAULT_XWING_MLDSA65_V1],
      keySource: "iOS Secure Enclave signatures and per-device X-Wing KEM key",
      keyLocation:
        "device secure storage; server stores only opaque envelopes and public keys",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "vault-key-epoch",
      status: "active-ios26",
      pqReadiness: "hybrid-kem-and-dual-signature-active",
      sourceFiles: [
        "ios/Athena/Athena/Core/Security/VaultHybridKeyDistribution.swift",
        "server/endpoints/vault.js",
      ],
    },
    {
      assetId: "agent.plugin-capability-credential",
      owner: "agent-platform",
      purpose: "Authorize a bounded one-time plugin tool invocation",
      suiteIds: [SUITE_IDS.PLUGIN_CAPABILITY_HMAC_V1],
      keySource: "purpose-derived Key Custody material",
      keyLocation: "server process memory only",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.LESS_THAN_ONE_YEAR,
      lifecycle: "single-invocation-up-to-60-seconds",
      status: "active",
      pqReadiness: "not-priority-short-lived-symmetric",
      sourceFiles: ["server/utils/plugins/capabilityBroker.js"],
    },
    {
      assetId: "agent.external-registry-manifest",
      owner: "agent-platform",
      purpose: "Authenticate external Agent Registry and capability manifests",
      suiteIds: [SUITE_IDS.AGENT_REGISTRY_MLDSA65_V1],
      keySource: "external ML-DSA-65 signing provider",
      keyLocation: "restricted provider files; public trust anchor in verifier",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.FIVE_TO_TEN_YEARS,
      lifecycle: "agent-release",
      status: "active-when-external-registry-enabled",
      pqReadiness: "ml-dsa65-required-in-production",
      sourceFiles: ["server/utils/security/agentManifestSignature.js"],
    },
    {
      assetId: "service.workload-identity",
      owner: "platform-security",
      purpose:
        "Mutually authenticate Collector, Gateway, Background Worker and API",
      suiteIds: [SUITE_IDS.SERVICE_IDENTITY_MTLS_V1],
      keySource: "workload CA or service mesh certificate provider",
      keyLocation: "read-only per-service certificate mounts",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.ONE_TO_FIVE_YEARS,
      lifecycle: "short-lived-workload-certificate",
      status: "required-in-distributed-production",
      pqReadiness: "transport-certificate-agility-preserved",
      sourceFiles: ["server/utils/security/serviceIdentity.js"],
    },
    {
      assetId: "security.siem-delivery",
      owner: "security-platform",
      purpose: "Authenticate security archive notices to an external SIEM",
      suiteIds: [SUITE_IDS.SECURITY_SIEM_HMAC_MTLS_V1],
      keySource: "restricted HMAC and optional mTLS credential files",
      keyLocation: "server filesystem with owner-only permissions",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.FIVE_TO_TEN_YEARS,
      lifecycle: "security-integration-credential",
      status: "active-when-configured",
      pqReadiness: "edge-and-siem-provider-dependent",
      sourceFiles: ["server/utils/security/securitySiemSink.js"],
    },
    {
      assetId: "legacy.server-encryption-manager",
      owner: "security-platform",
      purpose: "Compatibility decrypt for legacy secrets",
      suiteIds: [],
      algorithms: ["scrypt", "AES-256-CBC (legacy, unauthenticated)"],
      keySource: "SIG_KEY and SIG_SALT",
      keyLocation: "server runtime environment",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "migration-only-target",
      status: "legacy-requires-envelope-migration",
      pqReadiness: "must-retire-not-upgrade",
      sourceFiles: ["server/utils/EncryptionManager"],
    },
    {
      assetId: "transport.edge-tls",
      owner: "edge-platform",
      purpose: "Protect client-to-edge transport",
      suiteIds: [SUITE_IDS.EDGE_TLS_X25519_MLKEM768_V1],
      keySource: "edge certificate provider",
      keyLocation: "edge proxy only",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "certificate",
      status: "production-edge-profile-available",
      pqReadiness: "standardized-hybrid-kem-release-gated",
      sourceFiles: ["docker/edge/envoy-pq.yaml"],
    },
    {
      assetId: "ios26.post-quantum-device-vault-experiment",
      owner: "mobile-security-platform",
      purpose:
        "Evaluate ML-DSA-65, ML-KEM-768 and X-Wing device enrollment and Vault authorization envelopes",
      suiteIds: [
        SUITE_IDS.IOS_SE_MLDSA65_EXPERIMENT_V1,
        SUITE_IDS.MLKEM768_EXPERIMENT_V1,
        SUITE_IDS.XWING_MLKEM768_X25519_EXPERIMENT_V1,
        SUITE_IDS.VAULT_XWING_MLDSA65_EXPERIMENT_V1,
      ],
      keySource: "iOS 26 CryptoKit experiment",
      keyLocation:
        "ephemeral experiment session; no server authorization effect",
      confidentialityHorizon: CONFIDENTIALITY_HORIZONS.TEN_YEARS_OR_MORE,
      lifecycle: "experiment-only",
      status: "planned-disabled-by-default",
      pqReadiness: "implementation-probe",
      sourceFiles: [
        "ios/Athena/Athena/Core/Security/PostQuantumExperimentCenter.swift",
      ],
    },
  ].map((asset) => Object.freeze(asset))
);

function validateCryptoAssetInventory(assets = CRYPTO_ASSETS) {
  const findings = [];
  const ids = new Set();
  const horizons = new Set(Object.values(CONFIDENTIALITY_HORIZONS));
  for (const asset of assets) {
    if (!asset.assetId || ids.has(asset.assetId))
      findings.push(
        `duplicate_or_missing_asset_id:${asset.assetId || "unknown"}`
      );
    ids.add(asset.assetId);
    for (const field of [
      "owner",
      "purpose",
      "keySource",
      "keyLocation",
      "lifecycle",
      "status",
      "pqReadiness",
    ]) {
      if (!asset[field]) findings.push(`${asset.assetId}:missing:${field}`);
    }
    if (!horizons.has(asset.confidentialityHorizon))
      findings.push(`${asset.assetId}:invalid_confidentiality_horizon`);
    if (!(asset.sourceFiles || []).length)
      findings.push(`${asset.assetId}:missing_source_files`);
    if (!(asset.suiteIds || []).length && !(asset.algorithms || []).length)
      findings.push(`${asset.assetId}:missing_cryptographic_primitive`);
    for (const suiteId of asset.suiteIds || []) {
      if (!registeredCryptoSuite(suiteId))
        findings.push(`${asset.assetId}:unknown_suite:${suiteId}`);
    }
  }
  return { valid: findings.length === 0, findings };
}

function publicCryptoAssetInventory() {
  return CRYPTO_ASSETS.map((asset) => ({ ...asset }));
}

module.exports = {
  CRYPTO_ASSETS,
  INVENTORY_VERSION,
  publicCryptoAssetInventory,
  validateCryptoAssetInventory,
};
