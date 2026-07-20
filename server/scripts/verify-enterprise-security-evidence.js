#!/usr/bin/env node
const {
  verifyReleaseEvidenceFile,
} = require("../utils/security/releaseEvidence");

const environment = process.env.APP_ENV || process.env.NODE_ENV || "production";
const checks = [
  {
    profile: "edge",
    evidenceFile: process.env.ATHENA_EDGE_SECURITY_EVIDENCE_FILE,
    publicKeyFile: process.env.ATHENA_EDGE_SECURITY_EVIDENCE_PUBLIC_KEY_FILE,
  },
  {
    profile: "disasterRecovery",
    evidenceFile: process.env.ATHENA_DR_EVIDENCE_FILE,
    publicKeyFile: process.env.ATHENA_DR_EVIDENCE_PUBLIC_KEY_FILE,
  },
];

const results = checks.map((check) => {
  if (!check.evidenceFile || !check.publicKeyFile) {
    return {
      valid: false,
      profile: check.profile,
      findings: ["evidence_or_public_key_file_missing"],
    };
  }
  try {
    return verifyReleaseEvidenceFile({ ...check, environment });
  } catch (error) {
    return {
      valid: false,
      profile: check.profile,
      findings: [error.code || error.message],
    };
  }
});
const valid = results.every((result) => result.valid);
console.log(JSON.stringify({ success: valid, environment, results }, null, 2));
if (!valid) process.exitCode = 1;
