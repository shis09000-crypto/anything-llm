const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const prisma = require("../prisma");
const { storagePath } = require("../environment");
const {
  contentObjectProvider,
} = require("../../providers/storage/contentObjectProvider");
const { contentStoreProvider } = require("../contentObjects/policy");
const { canonicalJson } = require("../syncV2/canonicalJson");
const { publishSecurityArchiveNotice } = require("./securitySiemSink");

function securityAuditArchiveEnabled(env = process.env) {
  return (
    String(env.ATHENA_SECURITY_AUDIT_ARCHIVE_ENABLED || "false") === "true"
  );
}

function archiveStatePath() {
  return storagePath("logs", "security-audit-archive-state.json");
}

function readArchiveState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(archiveStatePath(), "utf8"));
    return {
      throughSequence: Math.max(Number(parsed.throughSequence) || 0, 0),
      throughHash: parsed.throughHash || null,
      objectKey: parsed.objectKey || null,
      archivedAt: parsed.archivedAt || null,
    };
  } catch {
    return {
      throughSequence: 0,
      throughHash: null,
      objectKey: null,
      archivedAt: null,
    };
  }
}

function writeArchiveState(state) {
  const target = archiveStatePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  const descriptor = fs.openSync(temporary, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function archivePayload({ entries, checkpoint }) {
  return Buffer.from(
    canonicalJson(
      {
        format: "athena-security-audit-archive-v1",
        chainId: checkpoint.chainId,
        throughSequence: checkpoint.throughSequence,
        throughHash: checkpoint.throughHash,
        checkpoint: {
          algorithm: checkpoint.algorithm,
          keyId: checkpoint.keyId,
          publicKey: checkpoint.publicKey,
          signature: checkpoint.signature,
          signatureEnvelope: checkpoint.signatureEnvelopeJson
            ? JSON.parse(checkpoint.signatureEnvelopeJson)
            : null,
          createdAt: checkpoint.createdAt,
        },
        entries: entries.map((entry) => ({
          chainId: entry.chainId,
          sequence: entry.sequence,
          eventId: entry.eventId,
          event: entry.event,
          metadata: JSON.parse(entry.metadataJson || "{}"),
          userId: entry.userId,
          requestId: entry.requestId,
          traceId: entry.traceId,
          previousHash: entry.previousHash,
          entryHash: entry.entryHash,
          occurredAt: entry.occurredAt,
        })),
      },
      { excludedKeys: new Set(), excludeSensitive: false }
    ),
    "utf8"
  );
}

function archiveObjectKey({ checkpoint, payloadHash }) {
  return path.posix.join(
    "security-audit",
    "v1",
    checkpoint.chainId,
    `${checkpoint.throughSequence}-${checkpoint.throughHash.slice(0, 16)}-${payloadHash}.json`
  );
}

async function exportSecurityAuditArchive() {
  if (!securityAuditArchiveEnabled()) return { skipped: true };
  const state = readArchiveState();
  const checkpoint = await prisma.security_audit_checkpoints.findFirst({
    where: { throughSequence: { gt: state.throughSequence } },
    orderBy: { throughSequence: "desc" },
  });
  if (!checkpoint) return { skipped: true, state };
  const entries = await prisma.security_audit_ledger.findMany({
    where: {
      chainId: checkpoint.chainId,
      sequence: {
        gt: state.throughSequence,
        lte: checkpoint.throughSequence,
      },
    },
    orderBy: { sequence: "asc" },
  });
  const expected = checkpoint.throughSequence - state.throughSequence;
  if (entries.length !== expected) {
    const error = new Error("security_audit_archive_range_incomplete");
    error.code = "SECURITY_AUDIT_ARCHIVE_RANGE_INCOMPLETE";
    throw error;
  }
  const payload = archivePayload({ entries, checkpoint });
  const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
  const objectKey = archiveObjectKey({ checkpoint, payloadHash });
  const providerName =
    process.env.ATHENA_SECURITY_AUDIT_ARCHIVE_PROVIDER ||
    contentStoreProvider();
  await contentObjectProvider(providerName).putImmutable({
    objectKey,
    body: payload,
    ciphertextSha256: payloadHash,
    retentionDays:
      Number(process.env.ATHENA_SECURITY_AUDIT_OBJECT_LOCK_DAYS || 0) || null,
  });
  await publishSecurityArchiveNotice({
    format: "athena-security-audit-notice-v1",
    chainId: checkpoint.chainId,
    throughSequence: checkpoint.throughSequence,
    throughHash: checkpoint.throughHash,
    objectKey,
    provider: providerName,
    payloadSha256: payloadHash,
    entryCount: entries.length,
    createdAt: new Date().toISOString(),
  });
  const nextState = {
    throughSequence: checkpoint.throughSequence,
    throughHash: checkpoint.throughHash,
    objectKey,
    provider: providerName,
    archivedAt: new Date().toISOString(),
  };
  writeArchiveState(nextState);
  return {
    skipped: false,
    entries: entries.length,
    bytes: payload.length,
    ...nextState,
  };
}

module.exports = {
  archiveObjectKey,
  archivePayload,
  exportSecurityAuditArchive,
  readArchiveState,
  securityAuditArchiveEnabled,
  writeArchiveState,
};
