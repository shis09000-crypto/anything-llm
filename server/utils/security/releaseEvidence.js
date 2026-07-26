const fs = require("fs");
const path = require("path");
const { canonicalJson } = require("../syncV2/canonicalJson");
const {
  PURPOSES,
  SUITE_IDS,
  cryptoSuite,
  preferredCryptoSuite,
  supportsNodeSignatureSuite,
  verifyWithCryptoSuite,
} = require("./cryptoSuiteRegistry");
const {
  loadKeyDescriptor,
  signHybridEnvelope,
  verifyHybridEnvelope,
} = require("./hybridSignature");

const EVIDENCE_FORMAT = "athena-enterprise-security-evidence:v2";
const LEGACY_EVIDENCE_FORMAT = "athena-enterprise-security-evidence:v1";
const RELEASE_EVIDENCE_SUITE = preferredCryptoSuite(PURPOSES.RELEASE_EVIDENCE);
if (!RELEASE_EVIDENCE_SUITE)
  throw new Error("release_evidence_crypto_suite_unavailable");
const PROFILE_POLICIES = Object.freeze({
  edge: Object.freeze({
    maxAgeMs: 30 * 86_400_000,
    requiredControls: Object.freeze([
      "waf",
      "ddosProtection",
      "dnssec",
      "originMtls",
      "botManagement",
      "originHidden",
    ]),
  }),
  disasterRecovery: Object.freeze({
    maxAgeMs: 90 * 86_400_000,
    requiredControls: Object.freeze([
      "crossAccountBackup",
      "immutableBackup",
      "crossRegionCopy",
      "restoreTest",
      "keyRecoveryTest",
    ]),
  }),
});

function signedEvidencePayload(evidence = {}) {
  const {
    signature: _signature,
    signatureEnvelope: _signatureEnvelope,
    ...payload
  } = evidence;
  return Buffer.from(
    canonicalJson(payload, {
      excludedKeys: new Set(),
      excludeSensitive: false,
    })
  );
}

function signReleaseEvidence({ evidence, signers } = {}) {
  if (!PROFILE_POLICIES[evidence?.profile])
    throw new Error("unsupported_evidence_profile");
  const unsigned = {
    ...evidence,
    format: EVIDENCE_FORMAT,
  };
  delete unsigned.signature;
  delete unsigned.signatureEnvelope;
  const signed = {
    ...unsigned,
    signatureEnvelope: signHybridEnvelope({
      data: signedEvidencePayload(unsigned),
      signers,
      policy: {
        threshold: 2,
        classicalRequired: true,
        pqRequired: true,
      },
    }),
  };
  const trustedKeys = signed.signatureEnvelope.signatures.map((entry) => ({
    keyId: entry.keyId,
    suiteId: entry.suiteId,
    publicKey: entry.publicKey,
  }));
  const verification = verifyReleaseEvidence({
    evidence: signed,
    trustedKeys,
    profile: signed.profile,
    environment: signed.environment,
  });
  if (!verification.valid) {
    const error = new Error("release_evidence_self_verification_failed");
    error.findings = verification.findings;
    throw error;
  }
  return signed;
}

function releaseEvidenceSigners({
  ed25519KeyId,
  ed25519PrivateKeyFile,
  ed25519PublicKeyFile = null,
  mlDSA65KeyId,
  mlDSA65PrivateKeyFile,
  mlDSA65PublicKeyFile = null,
  keyOrigin = "external-release-key-provider",
  hardwareProtection = "provider-asserted",
} = {}) {
  return [
    loadKeyDescriptor({
      suiteId: SUITE_IDS.RELEASE_EVIDENCE_ED25519_V1,
      purpose: PURPOSES.RELEASE_EVIDENCE,
      keyId: ed25519KeyId,
      privateKeyFile: ed25519PrivateKeyFile,
      publicKeyFile: ed25519PublicKeyFile,
      keyOrigin,
      hardwareProtection,
    }),
    loadKeyDescriptor({
      suiteId: SUITE_IDS.RELEASE_EVIDENCE_MLDSA65_V1,
      purpose: PURPOSES.RELEASE_EVIDENCE,
      keyId: mlDSA65KeyId,
      privateKeyFile: mlDSA65PrivateKeyFile,
      publicKeyFile: mlDSA65PublicKeyFile,
      keyOrigin,
      hardwareProtection,
    }),
  ];
}

function verifyReleaseEvidence({
  evidence,
  publicKey,
  trustedKeys = null,
  profile,
  environment = "production",
  now = Date.now(),
} = {}) {
  const findings = [];
  const policy = PROFILE_POLICIES[profile];
  if (!policy) findings.push("unsupported_evidence_profile");
  const legacy = evidence?.format === LEGACY_EVIDENCE_FORMAT;
  const hybridRequired =
    environment === "production" &&
    process.env.ATHENA_RELEASE_EVIDENCE_HYBRID_REQUIRED !== "false";
  if (evidence?.format !== EVIDENCE_FORMAT && !legacy)
    findings.push("evidence_format_invalid");
  if (legacy && hybridRequired) findings.push("evidence_hybrid_required");
  if (evidence?.profile !== profile) findings.push("evidence_profile_mismatch");
  if (evidence?.environment !== environment)
    findings.push("evidence_environment_mismatch");
  if (
    !String(
      evidence?.signer?.keyId ||
        evidence?.signatureEnvelope?.signatures?.[0]?.keyId ||
        ""
    ).trim()
  )
    findings.push("evidence_signer_key_id_missing");
  const issuedAt = Date.parse(evidence?.issuedAt);
  const expiresAt = Date.parse(evidence?.expiresAt);
  const evidenceSuite = cryptoSuite(
    evidence?.signer?.suiteId || evidence?.signer?.algorithm,
    {
      purpose: PURPOSES.RELEASE_EVIDENCE,
      at: Number.isFinite(issuedAt) ? issuedAt : now,
    }
  );
  if (legacy && !evidenceSuite)
    findings.push("evidence_signature_algorithm_invalid");
  if (legacy && evidenceSuite && !supportsNodeSignatureSuite(evidenceSuite))
    findings.push("evidence_signature_implementation_unavailable");
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now + 60_000 ||
    expiresAt <= now ||
    (policy &&
      (now - issuedAt > policy.maxAgeMs ||
        expiresAt - issuedAt > policy.maxAgeMs))
  ) {
    findings.push("evidence_expired_or_oversized");
  }
  for (const control of policy?.requiredControls || []) {
    if (evidence?.controls?.[control]?.status !== "verified") {
      findings.push(`control_not_verified:${control}`);
    }
  }
  if (profile === "disasterRecovery") {
    if (!Number.isFinite(Number(evidence?.metrics?.observedRpoMinutes)))
      findings.push("dr_rpo_evidence_missing");
    if (!Number.isFinite(Number(evidence?.metrics?.observedRtoMinutes)))
      findings.push("dr_rto_evidence_missing");
  }
  if (legacy) {
    try {
      if (!evidenceSuite || !supportsNodeSignatureSuite(evidenceSuite))
        throw new Error("evidence_signature_suite_missing");
      if (
        !verifyWithCryptoSuite({
          suite: evidenceSuite,
          data: signedEvidencePayload(evidence),
          publicKey,
          signature: evidence?.signature,
        })
      )
        findings.push("evidence_signature_invalid");
    } catch {
      findings.push("evidence_signature_invalid");
    }
  } else if (evidence?.format === EVIDENCE_FORMAT) {
    if (hybridRequired && (!trustedKeys || trustedKeys.length < 2))
      findings.push("evidence_trusted_hybrid_keys_missing");
    const hybrid = verifyHybridEnvelope({
      data: signedEvidencePayload(evidence),
      envelope: evidence.signatureEnvelope,
      purpose: PURPOSES.RELEASE_EVIDENCE,
      trustedKeys,
      requirePolicy: hybridRequired
        ? { threshold: 2, classicalRequired: true, pqRequired: true }
        : { classicalRequired: true, pqRequired: false },
    });
    findings.push(...hybrid.findings.map((finding) => `evidence_${finding}`));
  }
  return {
    valid: findings.length === 0,
    profile,
    environment,
    signerKeyId:
      evidence?.signer?.keyId ||
      evidence?.signatureEnvelope?.signatures?.[0]?.keyId ||
      null,
    signerSuiteId:
      evidenceSuite?.suiteId ||
      evidence?.signatureEnvelope?.signatures?.[0]?.suiteId ||
      null,
    issuedAt: evidence?.issuedAt || null,
    expiresAt: evidence?.expiresAt || null,
    findings,
  };
}

function verifyReleaseEvidenceFile({
  evidenceFile,
  publicKeyFile,
  pqPublicKeyFile = null,
  profile,
  environment = "production",
} = {}) {
  const evidence = JSON.parse(
    fs.readFileSync(path.resolve(evidenceFile), "utf8")
  );
  const publicKey = publicKeyFile
    ? fs.readFileSync(path.resolve(publicKeyFile), "utf8")
    : null;
  const trustedKeys = [];
  for (const [keyFile, family] of [
    [publicKeyFile, "classical"],
    [pqPublicKeyFile, "post-quantum"],
  ]) {
    if (!keyFile) continue;
    const publicKeyObject = require("crypto").createPublicKey(
      fs.readFileSync(path.resolve(keyFile), "utf8")
    );
    const publicKeyDer = publicKeyObject
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const signature = evidence?.signatureEnvelope?.signatures?.find(
      (entry) => entry.family === family && entry.publicKey === publicKeyDer
    );
    if (signature)
      trustedKeys.push({
        keyId: signature.keyId,
        suiteId: signature.suiteId,
        publicKey: publicKeyDer,
      });
  }
  return verifyReleaseEvidence({
    evidence,
    publicKey,
    trustedKeys: trustedKeys.length ? trustedKeys : null,
    profile,
    environment,
  });
}

module.exports = {
  EVIDENCE_FORMAT,
  LEGACY_EVIDENCE_FORMAT,
  PROFILE_POLICIES,
  RELEASE_EVIDENCE_SUITE,
  releaseEvidenceSigners,
  signReleaseEvidence,
  signedEvidencePayload,
  verifyReleaseEvidence,
  verifyReleaseEvidenceFile,
};
