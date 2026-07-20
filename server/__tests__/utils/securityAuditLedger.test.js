/* eslint-env jest */

const mockLedger = [];
const mockCheckpoints = [];
const mockKeyDescriptor = {
  keyId: "audit-test-key",
  material: Buffer.alloc(32, 7),
};

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
          row.sequence > Number(where.sequence.gt)
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
      .filter((row) => row.chainId === where.chainId)
      .sort((left, right) => left.throughSequence - right.throughSequence)
  ),
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
  resolveKey: jest.fn((keyId) =>
    keyId === mockKeyDescriptor.keyId ? mockKeyDescriptor : null
  ),
}));

jest.mock("../../utils/environment", () => ({
  storagePath: (...parts) => `/tmp/athena-audit-test/${parts.join("/")}`,
}));

const {
  appendSecurityAudit,
  verifySecurityAudit,
} = require("../../utils/security/auditLedger");

describe("security audit ledger", () => {
  const originalInterval =
    process.env.ATHENA_SECURITY_AUDIT_CHECKPOINT_INTERVAL;

  beforeEach(() => {
    mockLedger.length = 0;
    mockCheckpoints.length = 0;
    jest.clearAllMocks();
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
});
