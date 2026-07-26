const crypto = require("crypto");
const {
  EVIDENCE_FORMAT,
  LEGACY_EVIDENCE_FORMAT,
  RELEASE_EVIDENCE_SUITE,
  signedEvidencePayload,
  verifyReleaseEvidence,
} = require("../../utils/security/releaseEvidence");

function signedEvidence(
  profile,
  controls,
  metrics = {},
  { legacy = false } = {}
) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const evidence = {
    format: LEGACY_EVIDENCE_FORMAT,
    profile,
    environment: "production",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    controls: Object.fromEntries(
      controls.map((control) => [control, { status: "verified" }])
    ),
    metrics,
    signer: legacy
      ? { algorithm: "ed25519", keyId: "release-security-1" }
      : {
          suiteId: RELEASE_EVIDENCE_SUITE.suiteId,
          keyId: "release-security-1",
        },
  };
  evidence.signature = crypto
    .sign(null, signedEvidencePayload(evidence), privateKey)
    .toString("base64url");
  return { evidence, publicKey };
}

describe("enterprise release evidence", () => {
  const originalHybridRequired =
    process.env.ATHENA_RELEASE_EVIDENCE_HYBRID_REQUIRED;

  beforeAll(() => {
    process.env.ATHENA_RELEASE_EVIDENCE_HYBRID_REQUIRED = "false";
  });

  afterAll(() => {
    if (originalHybridRequired === undefined)
      delete process.env.ATHENA_RELEASE_EVIDENCE_HYBRID_REQUIRED;
    else
      process.env.ATHENA_RELEASE_EVIDENCE_HYBRID_REQUIRED =
        originalHybridRequired;
  });
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
    ).toMatchObject({
      valid: true,
      signerSuiteId: "release-evidence-ed25519-v1",
      findings: [],
    });
    evidence.controls.waf.status = "unverified";
    expect(
      verifyReleaseEvidence({ evidence, publicKey, profile: "edge" })
    ).toMatchObject({ valid: false });
  });

  it("keeps legacy Ed25519 evidence verifiable through its registry alias", () => {
    const { evidence, publicKey } = signedEvidence(
      "edge",
      [
        "waf",
        "ddosProtection",
        "dnssec",
        "originMtls",
        "botManagement",
        "originHidden",
      ],
      {},
      { legacy: true }
    );
    expect(
      verifyReleaseEvidence({ evidence, publicKey, profile: "edge" })
    ).toMatchObject({
      valid: true,
      signerSuiteId: "release-evidence-ed25519-v1",
    });
  });

  it("rejects an unregistered release evidence suite", () => {
    const { evidence, publicKey } = signedEvidence("edge", [
      "waf",
      "ddosProtection",
      "dnssec",
      "originMtls",
      "botManagement",
      "originHidden",
    ]);
    evidence.signer.suiteId = "release-evidence-unknown-v9";
    expect(
      verifyReleaseEvidence({ evidence, publicKey, profile: "edge" }).findings
    ).toContain("evidence_signature_algorithm_invalid");
  });

  it("rejects a v2 evidence document without a hybrid envelope", () => {
    const { evidence, publicKey } = signedEvidence("edge", [
      "waf",
      "ddosProtection",
      "dnssec",
      "originMtls",
      "botManagement",
      "originHidden",
    ]);
    evidence.format = EVIDENCE_FORMAT;
    expect(
      verifyReleaseEvidence({ evidence, publicKey, profile: "edge" }).valid
    ).toBe(false);
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
