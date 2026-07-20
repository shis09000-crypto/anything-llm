const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { canonicalJson } = require("../syncV2/canonicalJson");

const EVIDENCE_FORMAT = "athena-enterprise-security-evidence:v1";
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
  const { signature: _signature, ...payload } = evidence;
  return Buffer.from(
    canonicalJson(payload, {
      excludedKeys: new Set(),
      excludeSensitive: false,
    })
  );
}

function verifyReleaseEvidence({
  evidence,
  publicKey,
  profile,
  environment = "production",
  now = Date.now(),
} = {}) {
  const findings = [];
  const policy = PROFILE_POLICIES[profile];
  if (!policy) findings.push("unsupported_evidence_profile");
  if (evidence?.format !== EVIDENCE_FORMAT)
    findings.push("evidence_format_invalid");
  if (evidence?.profile !== profile) findings.push("evidence_profile_mismatch");
  if (evidence?.environment !== environment)
    findings.push("evidence_environment_mismatch");
  if (evidence?.signer?.algorithm !== "ed25519")
    findings.push("evidence_signature_algorithm_invalid");
  if (!String(evidence?.signer?.keyId || "").trim())
    findings.push("evidence_signer_key_id_missing");
  const issuedAt = Date.parse(evidence?.issuedAt);
  const expiresAt = Date.parse(evidence?.expiresAt);
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
  try {
    const valid = crypto.verify(
      null,
      signedEvidencePayload(evidence),
      publicKey,
      Buffer.from(String(evidence?.signature || ""), "base64url")
    );
    if (!valid) findings.push("evidence_signature_invalid");
  } catch {
    findings.push("evidence_signature_invalid");
  }
  return {
    valid: findings.length === 0,
    profile,
    environment,
    signerKeyId: evidence?.signer?.keyId || null,
    issuedAt: evidence?.issuedAt || null,
    expiresAt: evidence?.expiresAt || null,
    findings,
  };
}

function verifyReleaseEvidenceFile({
  evidenceFile,
  publicKeyFile,
  profile,
  environment = "production",
} = {}) {
  const evidence = JSON.parse(
    fs.readFileSync(path.resolve(evidenceFile), "utf8")
  );
  const publicKey = fs.readFileSync(path.resolve(publicKeyFile), "utf8");
  return verifyReleaseEvidence({ evidence, publicKey, profile, environment });
}

module.exports = {
  EVIDENCE_FORMAT,
  PROFILE_POLICIES,
  signedEvidencePayload,
  verifyReleaseEvidence,
  verifyReleaseEvidenceFile,
};
