jest.mock("../../utils/prisma", () => ({}));

const {
  archiveObjectKey,
  archivePayload,
  securityAuditArchiveEnabled,
} = require("../../utils/security/auditArchive");

describe("security audit immutable archive", () => {
  const checkpoint = {
    chainId: "security-v1",
    throughSequence: 2,
    throughHash: "a".repeat(64),
    algorithm: "ed25519",
    keyId: "key-1",
    publicKey: "public",
    signature: "signature",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("is opt-in and never activates from an unrelated flag", () => {
    expect(securityAuditArchiveEnabled({})).toBe(false);
    expect(
      securityAuditArchiveEnabled({
        ATHENA_SECURITY_AUDIT_ARCHIVE_ENABLED: "true",
      })
    ).toBe(true);
  });

  it("produces deterministic signed archive payloads and immutable keys", () => {
    const entries = [
      {
        chainId: "security-v1",
        sequence: 2,
        eventId: "event-2",
        event: "session_revoked",
        metadataJson: '{"reason":"logout"}',
        userId: 1,
        requestId: "request",
        traceId: "trace",
        previousHash: "b".repeat(64),
        entryHash: "a".repeat(64),
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const first = archivePayload({ entries, checkpoint });
    const second = archivePayload({ entries, checkpoint });
    expect(first.equals(second)).toBe(true);
    const digest = require("crypto")
      .createHash("sha256")
      .update(first)
      .digest("hex");
    expect(archiveObjectKey({ checkpoint, payloadHash: digest })).toContain(
      `/2-${"a".repeat(16)}-${digest}.json`
    );
  });
});
