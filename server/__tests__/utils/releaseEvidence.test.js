const crypto = require("crypto");
const {
  EVIDENCE_FORMAT,
  signedEvidencePayload,
  verifyReleaseEvidence,
} = require("../../utils/security/releaseEvidence");

function signedEvidence(profile, controls, metrics = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const evidence = {
    format: EVIDENCE_FORMAT,
    profile,
    environment: "production",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    controls: Object.fromEntries(
      controls.map((control) => [control, { status: "verified" }])
    ),
    metrics,
    signer: { algorithm: "ed25519", keyId: "release-security-1" },
  };
  evidence.signature = crypto
    .sign(null, signedEvidencePayload(evidence), privateKey)
    .toString("base64url");
  return { evidence, publicKey };
}

describe("enterprise release evidence", () => {
  it("verifies complete edge evidence and detects tampering", () => {
    const { evidence, publicKey } = signedEvidence("edge", [
      "waf",
      "ddosProtection",
      "dnssec",
      "originMtls",
      "botManagement",
      "originHidden",
    ]);
    expect(
      verifyReleaseEvidence({ evidence, publicKey, profile: "edge" })
    ).toMatchObject({ valid: true, findings: [] });
    evidence.controls.waf.status = "unverified";
    expect(
      verifyReleaseEvidence({ evidence, publicKey, profile: "edge" })
    ).toMatchObject({ valid: false });
  });

  it("requires observed RPO and RTO in disaster recovery evidence", () => {
    const { evidence, publicKey } = signedEvidence("disasterRecovery", [
      "crossAccountBackup",
      "immutableBackup",
      "crossRegionCopy",
      "restoreTest",
      "keyRecoveryTest",
    ]);
    expect(
      verifyReleaseEvidence({
        evidence,
        publicKey,
        profile: "disasterRecovery",
      }).findings
    ).toEqual(
      expect.arrayContaining([
        "dr_rpo_evidence_missing",
        "dr_rto_evidence_missing",
      ])
    );
  });
});
