/* eslint-env jest */
const crypto = require("crypto");

const mockLedger = [];
const mockCheckpoints = [];
const mockKeyDescriptor = {
  keyId: "audit-test-key",
  material: Buffer.alloc(32, 7),
};
const mockKeyDescriptors = new Map([
  [mockKeyDescriptor.keyId, mockKeyDescriptor],
]);
const mockRemoteKeyCustodyEnabled = jest.fn(() => false);
const mockRemoteAuditKeyDescriptor = jest.fn();
const mockRemoteSignAuditCheckpoint = jest.fn();

const mockLedgerApi = {
  findUnique: jest.fn(async ({ where }) =>
    mockLedger.find((row) => row.eventId === where.eventId)
  ),
  findFirst: jest.fn(async ({ where }) => {
    const rows = mockLedger.filter((row) => row.chainId === where.chainId);
    return (
      rows.sort((left, right) => right.sequence - left.sequence)[0] || null
    );
  }),
  create: jest.fn(async ({ data }) => {
    const row = { id: mockLedger.length + 1, ...data };
    mockLedger.push(row);
    return row;
  }),
  findMany: jest.fn(async ({ where, take }) =>
    mockLedger
      .filter(
        (row) =>
          row.chainId === where.chainId &&
          (!where.sequence || row.sequence > Number(where.sequence.gt))
      )
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, take)
  ),
};

const mockCheckpointApi = {
  findFirst: jest.fn(
    async ({ where }) =>
      mockCheckpoints
        .filter((row) => row.chainId === where.chainId)
        .sort(
          (left, right) => right.throughSequence - left.throughSequence
        )[0] || null
  ),
  create: jest.fn(async ({ data }) => {
    const row = { id: mockCheckpoints.length + 1, ...data };
    mockCheckpoints.push(row);
    return row;
  }),
  findMany: jest.fn(async ({ where }) =>
    mockCheckpoints
      .filter(
        (row) =>
          (!where.chainId || row.chainId === where.chainId) &&
          (!where.keyId || row.keyId === where.keyId)
      )
      .sort((left, right) => left.throughSequence - right.throughSequence)
  ),
  updateMany: jest.fn(async ({ where, data }) => {
    const row = mockCheckpoints.find(
      (checkpoint) =>
        checkpoint.id === where.id && checkpoint.keyId === where.keyId
    );
    if (!row) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  }),
};

jest.mock("../../utils/prisma", () => ({
  $transaction: jest.fn(async (callback) =>
    callback({
      security_audit_ledger: mockLedgerApi,
      security_audit_checkpoints: mockCheckpointApi,
    })
  ),
  security_audit_ledger: mockLedgerApi,
  security_audit_checkpoints: mockCheckpointApi,
}));

jest.mock("../../utils/security/keyCustody", () => ({
  resolveActiveKey: jest.fn(() => mockKeyDescriptor),
  resolveKey: jest.fn((keyId) => mockKeyDescriptors.get(keyId) || null),
}));

jest.mock("../../utils/security/keyCustody/remoteClient", () => ({
  remoteKeyCustodyEnabled: mockRemoteKeyCustodyEnabled,
  remoteAuditKeyDescriptor: mockRemoteAuditKeyDescriptor,
  remoteSignAuditCheckpoint: mockRemoteSignAuditCheckpoint,
}));

jest.mock("../../utils/environment", () => ({
  storagePath: (...parts) => `/tmp/athena-audit-test/${parts.join("/")}`,
}));

const {
  appendSecurityAudit,
  rebindSecurityAuditCheckpointMetadata,
  resignSecurityAuditCheckpoints,
  verifySecurityAudit,
  _internals,
} = require("../../utils/security/auditLedger");

describe("security audit ledger", () => {
  const originalInterval =
    process.env.ATHENA_SECURITY_AUDIT_CHECKPOINT_INTERVAL;
  beforeEach(() => {
    mockLedger.length = 0;
    mockCheckpoints.length = 0;
    mockKeyDescriptors.clear();
    mockKeyDescriptors.set(mockKeyDescriptor.keyId, mockKeyDescriptor);
    jest.clearAllMocks();
    mockRemoteKeyCustodyEnabled.mockReturnValue(false);
    process.env.ATHENA_SECURITY_AUDIT_CHECKPOINT_INTERVAL = "1";
  });

  afterAll(() => {
    if (originalInterval === undefined)
      delete process.env.ATHENA_SECURITY_AUDIT_CHECKPOINT_INTERVAL;
    else
      process.env.ATHENA_SECURITY_AUDIT_CHECKPOINT_INTERVAL = originalInterval;
  });

  test("builds a hash chain with trusted Ed25519 checkpoints", async () => {
    await appendSecurityAudit({
      eventId: "audit-1",
      event: "session_revoked",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    await appendSecurityAudit({
      eventId: "audit-2",
      event: "workspace_deleted",
      metadata: { workspaceId: 9 },
      occurredAt: new Date("2026-07-19T00:00:01.000Z"),
    });

    await expect(verifySecurityAudit({ pageSize: 50 })).resolves.toMatchObject({
      valid: true,
      entries: 2,
      checkpoints: 2,
      failures: [],
    });
    expect(mockLedger[1].previousHash).toBe(mockLedger[0].entryHash);
    expect(mockLedgerApi.findMany.mock.calls[0][0].where).toEqual({
      chainId: "security-v1",
    });
    expect(mockCheckpoints[0].algorithm).toBe("audit-ed25519-v1");
    expect(mockCheckpoints[0]).toMatchObject({
      parameterSet: "Ed25519",
      keyOrigin: "hkdf-derived-from-key-custody",
      hardwareProtection: "software-runtime-derived",
    });
    expect(JSON.parse(mockCheckpoints[0].signatureEnvelopeJson)).toMatchObject({
      format: "athena-audit-signature-envelope:v1",
      policy: { threshold: 1, pqRequired: false },
      signatures: [
        expect.objectContaining({
          suiteId: "audit-ed25519-v1",
          keyId: mockKeyDescriptor.keyId,
          postQuantum: false,
          parameterSet: "Ed25519",
          keyOrigin: "hkdf-derived-from-key-custody",
          hardwareProtection: "software-runtime-derived",
        }),
      ],
    });
  });

  test("uses remote custody for checkpoint signing and verification after cutover", async () => {
    const trusted = _internals.signingKey();
    mockRemoteKeyCustodyEnabled.mockReturnValue(true);
    mockRemoteAuditKeyDescriptor.mockResolvedValue({
      keyId: trusted.keyId,
      parameterSet: trusted.parameterSet,
      keyOrigin: trusted.keyOrigin,
      hardwareProtection: trusted.hardwareProtection,
      publicKey: trusted.publicKey,
    });
    mockRemoteSignAuditCheckpoint.mockImplementation(
      async ({ keyId, payload }) =>
        _internals.classicalCheckpointSignature({
          key: _internals.signingKey(keyId),
          payload,
          signedAt: new Date("2026-07-19T00:00:00.000Z"),
        })
    );

    await appendSecurityAudit({
      eventId: "remote-audit-1",
      event: "session_revoked",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    await expect(verifySecurityAudit()).resolves.toMatchObject({
      valid: true,
      entries: 1,
      checkpoints: 1,
    });
    expect(mockRemoteSignAuditCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockRemoteAuditKeyDescriptor).toHaveBeenCalledWith(
      trusted.keyId,
      expect.objectContaining({ throughSequence: 1 }),
      process.env
    );
  });

  test("detects ledger content tampering", async () => {
    await appendSecurityAudit({
      eventId: "audit-1",
      event: "session_revoked",
      metadata: { sessionId: "session-1" },
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    mockLedger[0].metadataJson = JSON.stringify({ sessionId: "altered" });

    const result = await verifySecurityAudit({ pageSize: 50 });
    expect(result.valid).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "entry_hash_mismatch" })
    );
  });

  test("verifies pre-classicalRequired signature envelopes without weakening policy", async () => {
    await appendSecurityAudit({
      eventId: "audit-legacy-envelope",
      event: "session_revoked",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    const checkpoint = mockCheckpoints[0];
    const envelope = JSON.parse(checkpoint.signatureEnvelopeJson);
    delete envelope.policy.classicalRequired;
    const key = _internals.signingKey(checkpoint.keyId);
    const data = Buffer.from(
      _internals.ledgerCanonical(
        _internals.checkpointSigningPayload({
          chainId: checkpoint.chainId,
          throughSequence: checkpoint.throughSequence,
          throughHash: checkpoint.throughHash,
          policy: envelope.policy,
          legacyPolicyShape: true,
        })
      ),
      "utf8"
    );
    const signature = crypto
      .sign(null, data, key.privateKey)
      .toString("base64");
    envelope.signatures[0].signature = signature;
    checkpoint.signature = signature;
    checkpoint.signatureEnvelopeJson = JSON.stringify(envelope);

    await expect(verifySecurityAudit({ pageSize: 50 })).resolves.toMatchObject({
      valid: true,
      failures: [],
    });
    expect(
      _internals.parseCheckpointSignatureEnvelope(checkpoint)
    ).toMatchObject({
      legacyPolicyShape: true,
      policy: { classicalRequired: true },
    });
  });

  test("rejects a checkpoint public key that is not anchored in key custody", async () => {
    await appendSecurityAudit({
      eventId: "audit-1",
      event: "session_revoked",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    mockCheckpoints[0].publicKey = Buffer.alloc(44, 1).toString("base64");

    const result = await verifySecurityAudit({ pageSize: 50 });
    expect(result.valid).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "checkpoint_public_key_untrusted" })
    );
  });

  test("rejects an unregistered checkpoint suite", async () => {
    await appendSecurityAudit({
      eventId: "audit-1",
      event: "session_revoked",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    mockCheckpoints[0].algorithm = "audit-unknown-v9";

    const result = await verifySecurityAudit({ pageSize: 50 });
    expect(result.valid).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "checkpoint_algorithm_mismatch" })
    );
  });

  test("rejects tampered public-key assurance metadata", async () => {
    await appendSecurityAudit({
      eventId: "audit-1",
      event: "session_revoked",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    const envelope = JSON.parse(mockCheckpoints[0].signatureEnvelopeJson);
    envelope.signatures[0].hardwareProtection = "hardware-backed";
    mockCheckpoints[0].hardwareProtection = "hardware-backed";
    mockCheckpoints[0].signatureEnvelopeJson = JSON.stringify(envelope);

    const result = await verifySecurityAudit({ pageSize: 50 });
    expect(result.valid).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "checkpoint_key_metadata_mismatch" })
    );
  });

  test("does not allow an environment flag to bypass provider-origin verification", async () => {
    await appendSecurityAudit({
      eventId: "audit-provider-migration",
      event: "key_provider_migrated",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    const checkpoint = mockCheckpoints[0];
    const envelope = JSON.parse(checkpoint.signatureEnvelopeJson);
    envelope.signatures[0].keyOrigin = "hkdf-derived-from-env-file";
    checkpoint.keyOrigin = "hkdf-derived-from-env-file";
    checkpoint.signatureEnvelopeJson = JSON.stringify(envelope);

    await expect(verifySecurityAudit({ pageSize: 50 })).resolves.toMatchObject({
      valid: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ code: "checkpoint_key_metadata_mismatch" }),
      ]),
    });

    process.env.ATHENA_AUDIT_TRUSTED_LEGACY_KEY_ORIGINS =
      "hkdf-derived-from-env-file";
    await expect(verifySecurityAudit({ pageSize: 50 })).resolves.toMatchObject({
      valid: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ code: "checkpoint_key_metadata_mismatch" }),
      ]),
    });
    delete process.env.ATHENA_AUDIT_TRUSTED_LEGACY_KEY_ORIGINS;
  });

  test("atomically rebinds provider metadata without leaving a verifier bypass", async () => {
    await appendSecurityAudit({
      eventId: "audit-provider-migration",
      event: "key_provider_migrated",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    const checkpoint = mockCheckpoints[0];
    const envelope = JSON.parse(checkpoint.signatureEnvelopeJson);
    envelope.signatures[0].keyOrigin = "hkdf-derived-from-env-file";
    checkpoint.keyOrigin = "hkdf-derived-from-env-file";
    checkpoint.signatureEnvelopeJson = JSON.stringify(envelope);

    await expect(
      rebindSecurityAuditCheckpointMetadata({
        sourceKeyOrigin: "hkdf-derived-from-env-file",
        dryRun: true,
      })
    ).resolves.toMatchObject({
      matched: 1,
      migrated: 0,
      dryRun: true,
      verified: true,
    });
    expect(checkpoint.keyOrigin).toBe("hkdf-derived-from-env-file");

    await expect(
      rebindSecurityAuditCheckpointMetadata({
        sourceKeyOrigin: "hkdf-derived-from-env-file",
        dryRun: false,
        now: new Date("2026-07-19T00:01:00.000Z"),
      })
    ).resolves.toMatchObject({
      matched: 1,
      migrated: 1,
      dryRun: false,
      verified: true,
    });

    const reboundEnvelope = JSON.parse(checkpoint.signatureEnvelopeJson);
    expect(checkpoint.keyOrigin).toBe("hkdf-derived-from-key-custody");
    expect(reboundEnvelope.signatures[0].keyOrigin).toBe(
      "hkdf-derived-from-key-custody"
    );
    expect(reboundEnvelope.metadataRebindHistory).toEqual([
      expect.objectContaining({
        format: "athena-audit-checkpoint-metadata-rebind:v1",
        sourceKeyOrigin: "hkdf-derived-from-env-file",
        targetKeyOrigin: "hkdf-derived-from-key-custody",
      }),
    ]);
    await expect(verifySecurityAudit({ pageSize: 50 })).resolves.toMatchObject({
      valid: true,
      failures: [],
    });
  });

  test("rejects a signature envelope whose threshold cannot be satisfied", async () => {
    await appendSecurityAudit({
      eventId: "audit-1",
      event: "session_revoked",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    const envelope = JSON.parse(mockCheckpoints[0].signatureEnvelopeJson);
    envelope.policy.threshold = 2;
    mockCheckpoints[0].signatureEnvelopeJson = JSON.stringify(envelope);

    const result = await verifySecurityAudit({ pageSize: 50 });
    expect(result.valid).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "checkpoint_unreadable" })
    );
  });

  test("verifies a threshold-two envelope without requiring a PQ signature", async () => {
    await appendSecurityAudit({
      eventId: "audit-1",
      event: "session_revoked",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    const secondDescriptor = {
      keyId: "audit-test-key-2",
      material: Buffer.alloc(32, 9),
    };
    mockKeyDescriptors.set(secondDescriptor.keyId, secondDescriptor);
    const firstKey = _internals.signingKey(mockKeyDescriptor.keyId);
    const secondKey = _internals.signingKey(secondDescriptor.keyId);
    const policy = { threshold: 2, pqRequired: false };
    const data = Buffer.from(
      _internals.ledgerCanonical(
        _internals.checkpointSigningPayload({
          chainId: mockCheckpoints[0].chainId,
          throughSequence: mockCheckpoints[0].throughSequence,
          throughHash: mockCheckpoints[0].throughHash,
          policy,
        })
      ),
      "utf8"
    );
    const firstSignature = crypto
      .sign(null, data, firstKey.privateKey)
      .toString("base64");
    const secondSignature = crypto
      .sign(null, data, secondKey.privateKey)
      .toString("base64");
    const signatures = [
      {
        suiteId: "audit-ed25519-v1",
        keyId: firstKey.keyId,
        publicKey: firstKey.publicKey,
        signature: firstSignature,
        signedAt: mockCheckpoints[0].createdAt.toISOString(),
        postQuantum: false,
        parameterSet: firstKey.parameterSet,
        keyOrigin: firstKey.keyOrigin,
        hardwareProtection: firstKey.hardwareProtection,
      },
      {
        suiteId: "audit-ed25519-v1",
        keyId: secondKey.keyId,
        publicKey: secondKey.publicKey,
        signature: secondSignature,
        signedAt: mockCheckpoints[0].createdAt.toISOString(),
        postQuantum: false,
        parameterSet: secondKey.parameterSet,
        keyOrigin: secondKey.keyOrigin,
        hardwareProtection: secondKey.hardwareProtection,
      },
    ];
    Object.assign(mockCheckpoints[0], {
      algorithm: signatures[0].suiteId,
      keyId: signatures[0].keyId,
      publicKey: signatures[0].publicKey,
      signature: signatures[0].signature,
      signatureEnvelopeJson: JSON.stringify({
        format: "athena-audit-signature-envelope:v1",
        policy,
        signatures,
      }),
    });

    await expect(verifySecurityAudit({ pageSize: 50 })).resolves.toMatchObject({
      valid: true,
      failures: [],
    });
  });

  test("re-signs checkpoints before a platform key is retired", async () => {
    await appendSecurityAudit({
      eventId: "audit-before-rotation",
      event: "key_rotation_started",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    const targetDescriptor = {
      keyId: "audit-target-key",
      material: Buffer.alloc(32, 11),
    };
    mockKeyDescriptors.set(targetDescriptor.keyId, targetDescriptor);

    await expect(
      resignSecurityAuditCheckpoints({
        sourceKeyId: mockKeyDescriptor.keyId,
        targetKeyId: targetDescriptor.keyId,
        now: new Date("2026-07-19T00:01:00.000Z"),
      })
    ).resolves.toMatchObject({
      migrated: 1,
      verified: true,
    });

    const envelope = JSON.parse(mockCheckpoints[0].signatureEnvelopeJson);
    expect(mockCheckpoints[0].keyId).toBe(targetDescriptor.keyId);
    expect(envelope.signatures).toEqual([
      expect.objectContaining({ keyId: targetDescriptor.keyId }),
    ]);
    expect(envelope.retiredSignatureHistory).toEqual([
      expect.objectContaining({
        format: "athena-audit-signature-migration:v1",
        sourceKeyId: mockKeyDescriptor.keyId,
        targetKeyId: targetDescriptor.keyId,
      }),
    ]);

    mockKeyDescriptors.delete(mockKeyDescriptor.keyId);
    await expect(verifySecurityAudit({ pageSize: 50 })).resolves.toMatchObject({
      valid: true,
      failures: [],
    });
  });

  test("does not migrate checkpoints when the source ledger is invalid", async () => {
    await appendSecurityAudit({
      eventId: "audit-before-failed-rotation",
      event: "key_rotation_started",
      occurredAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    const targetDescriptor = {
      keyId: "audit-target-key",
      material: Buffer.alloc(32, 11),
    };
    mockKeyDescriptors.set(targetDescriptor.keyId, targetDescriptor);
    mockLedger[0].metadataJson = JSON.stringify({ tampered: true });

    await expect(
      resignSecurityAuditCheckpoints({
        sourceKeyId: mockKeyDescriptor.keyId,
        targetKeyId: targetDescriptor.keyId,
      })
    ).rejects.toThrow("security_audit_signature_migration_source_invalid");
    expect(mockCheckpoints[0].keyId).toBe(mockKeyDescriptor.keyId);
  });
});
