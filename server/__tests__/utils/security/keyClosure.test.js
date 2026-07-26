const fs = require("fs");
const os = require("os");
const path = require("path");

describe("Phase 4 key closure primitives", () => {
  let storageBase;
  const originalStorageBase = process.env.ANYTHINGLLM_STORAGE_BASE_DIR;
  const originalAppEnv = process.env.APP_ENV;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalObservation =
    process.env.ATHENA_KEY_DECRYPT_ONLY_OBSERVATION_MS;

  beforeEach(() => {
    jest.resetModules();
    storageBase = fs.mkdtempSync(path.join(os.tmpdir(), "athena-closure-"));
    process.env.ANYTHINGLLM_STORAGE_BASE_DIR = storageBase;
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "test";
    process.env.ATHENA_KEY_DECRYPT_ONLY_OBSERVATION_MS = "0";
  });

  afterEach(() => {
    fs.rmSync(storageBase, { recursive: true, force: true });
    if (originalStorageBase === undefined)
      delete process.env.ANYTHINGLLM_STORAGE_BASE_DIR;
    else process.env.ANYTHINGLLM_STORAGE_BASE_DIR = originalStorageBase;
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalObservation === undefined)
      delete process.env.ATHENA_KEY_DECRYPT_ONLY_OBSERVATION_MS;
    else
      process.env.ATHENA_KEY_DECRYPT_ONLY_OBSERVATION_MS = originalObservation;
  });

  test("persists only decrypt-only successful read observations", () => {
    const {
      observationPath,
      observationSummary,
      initializeObservation,
      recordDecryptOnlyKeyRead,
    } = require("../../../utils/security/legacyKeyReadObservation");
    const descriptor = {
      keyId: "sdk_123456789abc",
      purpose: "server-data-at-rest",
      status: "decrypt_only",
    };

    expect(
      recordDecryptOnlyKeyRead(
        { ...descriptor, status: "active" },
        { domain: "chat" }
      )
    ).toBeNull();
    const observation = initializeObservation(descriptor.keyId);
    recordDecryptOnlyKeyRead(descriptor, {
      domain: "chat",
      runtimeRole: "background-worker",
      resource: "conversation-1",
    });

    expect(
      observationSummary(descriptor.keyId, {
        observationId: observation.observationId,
        since: observation.startedAt,
      })
    ).toMatchObject({
      readHits: 1,
      logPresent: true,
      startMarkerPresent: true,
      chainValid: true,
      invalidRecords: 0,
      byDomain: { chat: 1 },
      byRuntimeRole: { "background-worker": 1 },
    });
    expect(fs.statSync(observationPath(descriptor.keyId)).mode & 0o777).toBe(
      0o600
    );
    expect(
      fs.readFileSync(observationPath(descriptor.keyId), "utf8")
    ).not.toContain("conversation-1");
    fs.appendFileSync(observationPath(descriptor.keyId), "{invalid-json\n");
    expect(
      observationSummary(descriptor.keyId, {
        observationId: observation.observationId,
        since: observation.startedAt,
      }).invalidRecords
    ).toBe(1);
  });

  test("closes enc:v1 writes irreversibly with a private policy file", () => {
    const {
      assertLegacyEnvelopeWriteAllowed,
      closeLegacyWrites,
      legacyWritesClosed,
      policyPath,
    } = require("../../../utils/security/legacyWritePolicy");
    closeLegacyWrites({
      keyId: "sdk_123456789abc",
      evidenceHash: "a".repeat(64),
    });

    expect(legacyWritesClosed()).toBe(true);
    expect(() =>
      assertLegacyEnvelopeWriteAllowed("enc:v1:a:b:c")
    ).toThrow("legacy_secret_writes_closed");
    expect(() =>
      assertLegacyEnvelopeWriteAllowed("enc:v2:key:p:a:b:c")
    ).not.toThrow();
    expect(fs.statSync(policyPath()).mode & 0o777).toBe(0o600);
  });

  test("requires fresh zero-hit drill-complete closure proof", () => {
    const {
      CLOSURE_PROOF_VERSION,
      REQUIRED_EVIDENCE_KINDS,
      assertKeyClosureRetirementProof,
    } = require("../../../utils/security/keyClosure");
    const keyId = "sdk_123456789abc";
    const proof = {
      version: CLOSURE_PROOF_VERSION,
      keyId,
      generatedAt: new Date().toISOString(),
      retirementAllowed: true,
      legacyWritesClosed: true,
      blockers: [],
      observation: {
        readHits: 0,
        logPresent: true,
        startMarkerPresent: true,
        chainValid: true,
        invalidRecords: 0,
        elapsedMs: 1,
        requiredMs: 0,
      },
      evidence: Object.fromEntries(
        REQUIRED_EVIDENCE_KINDS.map((kind) => [
          kind,
          {
            passed: true,
            bound: true,
            afterObservation: true,
            fresh: true,
          },
        ])
      ),
    };

    expect(assertKeyClosureRetirementProof(proof, keyId)).toBe(true);
    expect(() =>
      assertKeyClosureRetirementProof(
        { ...proof, observation: { readHits: 1 } },
        keyId
      )
    ).toThrow("key_closure_retirement_incomplete");
    expect(() =>
      assertKeyClosureRetirementProof(
        {
          ...proof,
          evidence: {
            ...proof.evidence,
            "backup-restore": { passed: false },
          },
        },
        keyId
      )
    ).toThrow("key_closure_retirement_incomplete");
  });

  test("binds drill evidence to the target key, environment, and age", () => {
    const {
      DRILL_EVIDENCE_FORMAT,
      validateDrillEvidence,
    } = require("../../../utils/security/keyClosure");
    const keyId = "sdk_123456789abc";
    const now = new Date();
    const evidence = {
      format: DRILL_EVIDENCE_FORMAT,
      kind: "agent-headless",
      keyId,
      keyStatus: "decrypt_only",
      environment: "development",
      success: true,
      checks: [{ name: "probe", passed: true }],
      completedAt: now.toISOString(),
    };

    expect(
      validateDrillEvidence(evidence, evidence.kind, {
        expectedKeyId: keyId,
        expectedEnvironment: "development",
        now,
      })
    ).toMatchObject({ keyId, environment: "development" });
    expect(() =>
      validateDrillEvidence(
        { ...evidence, keyId: "sdk_other_key" },
        evidence.kind,
        {
          expectedKeyId: keyId,
          expectedEnvironment: "development",
          now,
        }
      )
    ).toThrow("key_closure_drill_evidence_invalid");
    expect(() =>
      validateDrillEvidence(
        {
          ...evidence,
          completedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
        },
        evidence.kind,
        {
          expectedKeyId: keyId,
          expectedEnvironment: "development",
          now,
        }
      )
    ).toThrow("key_closure_drill_evidence_invalid");
  });
});
