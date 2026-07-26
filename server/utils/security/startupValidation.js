const { MASTER_KEY_ENV } = require("./constants");
const {
  allowedOrigins,
  assertProductionTransportConfig,
  envFlag,
} = require("./transportSecurity");
const {
  requiredPostQuantumFindings,
  runtimeCapabilities,
} = require("./cryptoRuntimeCapabilities");
const { passwordPepper } = require("./passwordCredential");

const WEAK_SECRET_VALUES = new Set([
  "secret",
  "password",
  "changeme",
  "change-me",
  "my-random-string-for-seeding",
  "anythingllm",
  "jwt_secret",
  "jwt-secret",
]);

function present(value) {
  return String(value || "").trim();
}

function validateStrongSecret(name, value, minLength = 32) {
  const normalized = present(value);
  if (!normalized) return `${name} is required in production.`;
  if (normalized.length < minLength) {
    return `${name} must be at least ${minLength} characters in production.`;
  }
  if (WEAK_SECRET_VALUES.has(normalized.toLowerCase())) {
    return `${name} uses a known weak development value.`;
  }
  return null;
}

function validateMasterKey(env = process.env) {
  if (
    ["external-lease", "vault-agent", "kms-sidecar"].includes(
      present(env.ATHENA_KEY_PROVIDER).toLowerCase()
    )
  ) {
    return present(env.ATHENA_KEY_LEASE_FILE)
      ? null
      : "ATHENA_KEY_LEASE_FILE is required for an external key provider.";
  }
  if (
    env.ATHENA_KEY_PROVIDER === "secret-file" ||
    String(env.ATHENA_MASTER_KEY_FILE || "").trim()
  ) {
    return null;
  }
  const value = present(env[MASTER_KEY_ENV]);
  if (!value) return `${MASTER_KEY_ENV} is required in production.`;
  if (!/^[a-fA-F0-9]+$/.test(value)) {
    return `${MASTER_KEY_ENV} must be a 64-character hex string.`;
  }
  if (value.length !== 64) return `${MASTER_KEY_ENV} must be exactly 32 bytes.`;
  if (/^(.)\1+$/.test(value)) return `${MASTER_KEY_ENV} is not random enough.`;
  return null;
}

function productionSecurityFindings(env = process.env) {
  const runtimeEnvironment = present(env.APP_ENV || env.NODE_ENV).toLowerCase();
  if (runtimeEnvironment !== "production") return [];
  const findings = [];
  const distributed = present(env.ATHENA_RUNTIME_TOPOLOGY) === "distributed";
  const enterpriseGate = envFlag(env.ATHENA_ENTERPRISE_RELEASE_GATE);

  if (!present(env.ATHENA_PASSWORD_PEPPER_FILE)) {
    findings.push(
      "Production password authentication requires ATHENA_PASSWORD_PEPPER_FILE."
    );
  } else {
    try {
      passwordPepper(env);
    } catch {
      findings.push(
        "ATHENA_PASSWORD_PEPPER_FILE must reference a readable 32+ byte file with owner-only permissions."
      );
    }
  }

  if (distributed && !enterpriseGate) {
    findings.push(
      "Distributed production requires ATHENA_ENTERPRISE_RELEASE_GATE=true."
    );
  }
  if (distributed && env.ATHENA_BROADCAST_TRANSPORT !== "nats") {
    findings.push(
      "Distributed production requires the NATS broadcast transport."
    );
  }
  if (distributed && env.ATHENA_DATABASE_PROVIDER !== "postgresql") {
    findings.push("Distributed production requires PostgreSQL authority.");
  }
  if (distributed && env.ATHENA_SERVICE_MTLS_REQUIRED !== "true") {
    findings.push("Distributed production requires workload service mTLS.");
  }

  if (env.ATHENA_BROADCAST_TRANSPORT === "nats") {
    const {
      natsSecurityFindings,
    } = require("../broadcast/transports/natsJetStreamTransport");
    findings.push(...natsSecurityFindings(env));
  }

  const iosHighRiskPQRequired = env.ATHENA_IOS_HIGH_RISK_PQ_REQUIRED === "true";
  const pqRuntimeRequired =
    enterpriseGate ||
    iosHighRiskPQRequired ||
    env.ATHENA_REQUIRE_NODE24_PQ_PROBE === "true";
  if (pqRuntimeRequired) {
    const runtimeFindings = requiredPostQuantumFindings({
      required: true,
      capabilities: runtimeCapabilities(),
    });
    for (const finding of runtimeFindings) {
      if (finding.startsWith("node24_required:")) {
        findings.push(
          "Post-quantum production requires the Node.js 24 LTS runtime."
        );
        continue;
      }
      findings.push(
        `Post-quantum runtime capability check failed: ${finding}.`
      );
    }
  }
  if (iosHighRiskPQRequired && env.ATHENA_REQUIRE_NODE24_PQ_PROBE !== "true") {
    findings.push(
      "Required iOS post-quantum request signing requires ATHENA_REQUIRE_NODE24_PQ_PROBE=true."
    );
  }

  if (enterpriseGate) {
    if (env.ATHENA_SERVICE_MTLS_REQUIRED !== "true")
      findings.push("Enterprise production requires workload service mTLS.");
    if (env.ATHENA_DEVICE_ATTESTATION_MODE !== "required")
      findings.push(
        "Enterprise production requires Apple App Attest for supported iOS devices."
      );
    if (!present(env.ATHENA_APP_ATTEST_APP_ID))
      findings.push("ATHENA_APP_ATTEST_APP_ID is required.");
    const attestationVerifier = present(env.ATHENA_APP_ATTEST_VERIFIER_URL);
    if (!attestationVerifier) {
      findings.push("ATHENA_APP_ATTEST_VERIFIER_URL is required.");
    } else {
      try {
        const verifierURL = new URL(attestationVerifier);
        if (verifierURL.protocol !== "https:")
          findings.push(
            "ATHENA_APP_ATTEST_VERIFIER_URL must use HTTPS in production."
          );
        if (verifierURL.username || verifierURL.password)
          findings.push(
            "ATHENA_APP_ATTEST_VERIFIER_URL must not contain credentials."
          );
      } catch {
        findings.push("ATHENA_APP_ATTEST_VERIFIER_URL must be a valid URL.");
      }
    }
    if (env.ATHENA_RELEASE_EVIDENCE_HYBRID_REQUIRED !== "true")
      findings.push(
        "Enterprise production requires hybrid release and disaster-recovery evidence."
      );
    if (!envFlag(env.ATHENA_SECURITY_AUDIT_ARCHIVE_ENABLED)) {
      findings.push(
        "Enterprise production requires immutable security audit archiving."
      );
    }
    if (
      !["external-lease", "vault-agent", "kms-sidecar"].includes(
        present(env.ATHENA_KEY_PROVIDER).toLowerCase()
      )
    ) {
      findings.push(
        "Enterprise production requires a Vault/KMS external key lease provider."
      );
    }
    for (const name of [
      "ATHENA_EDGE_SECURITY_EVIDENCE_FILE",
      "ATHENA_EDGE_SECURITY_EVIDENCE_PUBLIC_KEY_FILE",
      "ATHENA_EDGE_SECURITY_EVIDENCE_MLDSA65_PUBLIC_KEY_FILE",
      "ATHENA_DR_EVIDENCE_FILE",
      "ATHENA_DR_EVIDENCE_PUBLIC_KEY_FILE",
      "ATHENA_DR_EVIDENCE_MLDSA65_PUBLIC_KEY_FILE",
    ]) {
      if (!present(env[name])) findings.push(`${name} is required.`);
    }
    if (
      present(env.ATHENA_EDGE_SECURITY_EVIDENCE_FILE) &&
      present(env.ATHENA_EDGE_SECURITY_EVIDENCE_PUBLIC_KEY_FILE) &&
      present(env.ATHENA_EDGE_SECURITY_EVIDENCE_MLDSA65_PUBLIC_KEY_FILE) &&
      present(env.ATHENA_DR_EVIDENCE_FILE) &&
      present(env.ATHENA_DR_EVIDENCE_PUBLIC_KEY_FILE) &&
      present(env.ATHENA_DR_EVIDENCE_MLDSA65_PUBLIC_KEY_FILE)
    ) {
      const { verifyReleaseEvidenceFile } = require("./releaseEvidence");
      for (const evidence of [
        {
          profile: "edge",
          evidenceFile: env.ATHENA_EDGE_SECURITY_EVIDENCE_FILE,
          publicKeyFile: env.ATHENA_EDGE_SECURITY_EVIDENCE_PUBLIC_KEY_FILE,
          pqPublicKeyFile:
            env.ATHENA_EDGE_SECURITY_EVIDENCE_MLDSA65_PUBLIC_KEY_FILE,
        },
        {
          profile: "disasterRecovery",
          evidenceFile: env.ATHENA_DR_EVIDENCE_FILE,
          publicKeyFile: env.ATHENA_DR_EVIDENCE_PUBLIC_KEY_FILE,
          pqPublicKeyFile: env.ATHENA_DR_EVIDENCE_MLDSA65_PUBLIC_KEY_FILE,
        },
      ]) {
        try {
          const result = verifyReleaseEvidenceFile({
            ...evidence,
            environment: "production",
          });
          findings.push(
            ...result.findings.map(
              (finding) => `${evidence.profile} evidence: ${finding}`
            )
          );
        } catch (error) {
          findings.push(
            `${evidence.profile} evidence: ${error.code || error.message}`
          );
        }
      }
    }
  }

  if (enterpriseGate) {
    if (env.ATHENA_REQUIRE_NODE24_PQ_PROBE !== "true")
      findings.push(
        "Enterprise production requires ATHENA_REQUIRE_NODE24_PQ_PROBE=true."
      );
    const declaredCapabilities = present(
      env.ATHENA_PQ_RUNTIME_EXPECTED_CAPABILITIES
    )
      .split(",")
      .map((value) => value.trim().toLowerCase().replace(/-/g, "_"))
      .filter(Boolean);
    const expectedCapabilities = new Set(declaredCapabilities);
    const allowedCapabilities = new Set([
      "ml_kem_768",
      "ml_dsa_65",
      "encapsulation_api",
      "classical_provider_baseline",
    ]);
    for (const capability of declaredCapabilities) {
      if (!allowedCapabilities.has(capability))
        findings.push(
          `Enterprise production capability baseline contains unknown capability ${capability}.`
        );
    }
    for (const capability of allowedCapabilities) {
      if (!expectedCapabilities.has(capability))
        findings.push(
          `Enterprise production capability baseline must include ${capability}.`
        );
    }
    if (env.ATHENA_AUDIT_HYBRID_SIGNATURES !== "required")
      findings.push("Enterprise production requires hybrid audit signatures.");
    for (const name of [
      "ATHENA_AUDIT_MLDSA65_PRIVATE_KEY_FILE",
      "ATHENA_AUDIT_MLDSA65_PUBLIC_KEY_FILE",
      "ATHENA_AGENT_MLDSA65_PUBLIC_KEY_FILE",
    ]) {
      if (!present(env[name])) findings.push(`${name} is required.`);
    }
    if (envFlag(env.ATHENA_OPERATIONS_ENABLED)) {
      if (!present(env.ATHENA_AGENT_MLDSA65_PRIVATE_KEY_FILE))
        findings.push("ATHENA_AGENT_MLDSA65_PRIVATE_KEY_FILE is required.");
      if (env.ATHENA_EXTERNAL_AGENT_MLDSA_REQUIRED !== "true")
        findings.push(
          "External Agent Registry ML-DSA verification is required."
        );
    }
    if (env.ATHENA_IOS_HIGH_RISK_PQ_REQUIRED !== "true")
      findings.push("iOS high-risk hybrid request signatures are required.");
  }

  if (envFlag(env.ATHENA_SECURITY_AUDIT_ARCHIVE_ENABLED)) {
    const provider = present(env.ATHENA_SECURITY_AUDIT_ARCHIVE_PROVIDER);
    if (provider !== "s3") {
      findings.push(
        "Production security audit archives require the S3 provider."
      );
    }
    if (Number(env.ATHENA_SECURITY_AUDIT_OBJECT_LOCK_DAYS || 0) < 365) {
      findings.push(
        "ATHENA_SECURITY_AUDIT_OBJECT_LOCK_DAYS must be at least 365."
      );
    }
    const { validateSiemSettings } = require("./securitySiemSink");
    findings.push(
      ...validateSiemSettings(env).map(
        (finding) => `Security SIEM configuration: ${finding}`
      )
    );
  }

  try {
    assertProductionTransportConfig(env);
  } catch (error) {
    findings.push(error.message);
  }

  const jwtFinding = validateStrongSecret("JWT_SECRET", env.JWT_SECRET);
  if (jwtFinding) findings.push(jwtFinding);

  const authTokenFinding = validateStrongSecret("AUTH_TOKEN", env.AUTH_TOKEN);
  if (authTokenFinding) findings.push(authTokenFinding);

  const masterKeyFinding = validateMasterKey(env);
  if (masterKeyFinding) findings.push(masterKeyFinding);

  if (envFlag(env.ATHENA_SIGNING_WARN_ONLY)) {
    findings.push("ATHENA_SIGNING_WARN_ONLY cannot be true in production.");
  }
  if (
    env.REQUEST_SIGNING_DEVICE_REQUIRED === "false" ||
    env.ATHENA_DEVICE_SIGNATURE_REQUIRED === "false" ||
    envFlag(env.REQUEST_SIGNING_HMAC_COMPAT) ||
    envFlag(env.ATHENA_ALLOW_HMAC_HIGH_RISK_COMPAT)
  ) {
    findings.push(
      "Production high-risk requests require device signatures; HMAC compatibility and explicit device-signature disablement are forbidden."
    );
  }
  if (
    env.ATHENA_SESSION_V2 === "false" ||
    env.ATHENA_SESSION_V2_REQUIRE_MULTI === "false" ||
    env.ATHENA_REALTIME_REQUIRE_SESSION === "false"
  ) {
    findings.push(
      "Session V2 and authoritative realtime sessions are required in production."
    );
  }
  if (envFlag(env.ATHENA_REALTIME_LEGACY_QUERY_TOKEN)) {
    const expiresAt = Date.parse(
      present(env.ATHENA_REALTIME_LEGACY_QUERY_TOKEN_EXPIRES_AT)
    );
    const maximum = Date.now() + 30 * 24 * 60 * 60 * 1_000;
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > maximum
    ) {
      findings.push(
        "Legacy WebSocket query JWT compatibility requires ATHENA_REALTIME_LEGACY_QUERY_TOKEN_EXPIRES_AT within the next 30 days."
      );
    }
  }
  if (env.ATHENA_REALTIME_TICKET_STORE === "memory") {
    findings.push(
      "Production realtime tickets require the shared database store."
    );
  }
  if (env.ATHENA_STRICT_READY === "false") {
    findings.push("Strict readiness cannot be disabled in production.");
  }
  if (allowedOrigins(env).size === 0) {
    findings.push(
      "ATHENA_ALLOWED_ORIGINS or an HTTPS PUBLIC_APP_URL is required in production."
    );
  }
  if (
    envFlag(env.ENABLE_HTTPS) &&
    env.ATHENA_TLS_MIN_VERSION &&
    env.ATHENA_TLS_MIN_VERSION !== "TLSv1.3"
  ) {
    findings.push(
      "Direct production HTTPS must use ATHENA_TLS_MIN_VERSION=TLSv1.3."
    );
  }
  if (
    envFlag(env.VITE_CODEX_DEV_AUTH_BYPASS) ||
    present(env.CODEX_DEV_AUTH_BYPASS_KEY)
  ) {
    findings.push(
      "Codex dev auth bypass configuration must not be present in production."
    );
  }
  if (
    envFlag(env.CRYPTO_CENTER_AUTH_BYPASS) ||
    envFlag(env.VITE_CRYPTO_CENTER_AUTH_BYPASS)
  ) {
    findings.push(
      "Crypto Center auth bypass must not be enabled in production."
    );
  }

  return findings;
}

function assertProductionSecurityConfig(env = process.env) {
  const findings = productionSecurityFindings(env);
  if (!findings.length)
    return {
      production:
        present(env.APP_ENV || env.NODE_ENV).toLowerCase() === "production",
    };
  throw new Error(
    `Unsafe production security configuration:\n- ${findings.join("\n- ")}`
  );
}

module.exports = {
  assertProductionSecurityConfig,
  productionSecurityFindings,
};
