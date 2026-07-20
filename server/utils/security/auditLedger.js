const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const prisma = require("../prisma");
const { storagePath } = require("../environment");
const { canonicalJson } = require("../syncV2/canonicalJson");
const { redactLogObject } = require("./redaction");
const { resolveActiveKey, resolveKey } = require("./keyCustody");
const { metrics } = require("../observability/metrics");

const CHAIN_ID = "security-v1";
const GENESIS_HASH = "0".repeat(64);
const ED25519_PKCS8_SEED_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);
const SECURITY_EVENT =
  /(login|logout|session|passkey|trusted.?device|zk_|security|key_|vault|admin|delete|deletion|permission|role|invite|password|recovery|multi_user|plugin|mcp|scheduled|file_access_shell|token_revok)/i;
const durabilityState = {
  lastFatalAt: null,
  lastFatalCode: null,
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ledgerCanonical(value) {
  return canonicalJson(value, {
    excludedKeys: new Set(),
    excludeSensitive: false,
  });
}

function isSecurityRelevantEvent(event) {
  return SECURITY_EVENT.test(String(event || ""));
}

function normalizeMetadata(metadata) {
  const redacted =
    !metadata || typeof metadata !== "object" || Array.isArray(metadata)
      ? { value: metadata ?? null }
      : redactLogObject(metadata);
  return boundAuditValue(redacted);
}

function boundAuditValue(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string")
    return value.length > 1_000 ? `${value.slice(0, 1_000)}…` : value;
  if (["number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((entry) => boundAuditValue(entry, depth + 1));
  if (typeof value !== "object") return String(value).slice(0, 1_000);
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, entry]) => [key, boundAuditValue(entry, depth + 1)])
  );
}

function entryEnvelope({
  chainId,
  sequence,
  eventId,
  event,
  metadata,
  userId,
  requestId,
  traceId,
  occurredAt,
  previousHash,
}) {
  return {
    chainId,
    sequence,
    eventId,
    event,
    metadata,
    userId: Number(userId) || null,
    requestId: requestId || null,
    traceId: traceId || null,
    occurredAt: new Date(occurredAt).toISOString(),
    previousHash,
  };
}

function signingKey(keyId = null) {
  const descriptor = keyId ? resolveKey(keyId) : resolveActiveKey();
  if (!descriptor?.material || !descriptor?.keyId) {
    const error = new Error("security_audit_signing_key_unavailable");
    error.code = "SECURITY_AUDIT_SIGNING_KEY_UNAVAILABLE";
    throw error;
  }
  const seed = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      descriptor.material,
      Buffer.from("athena-security-audit-v1", "utf8"),
      Buffer.from(descriptor.keyId, "utf8"),
      32
    )
  );
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    keyId: descriptor.keyId,
    privateKey,
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

function checkpointEnvelope({ chainId, throughSequence, throughHash, keyId }) {
  return { chainId, throughSequence, throughHash, keyId };
}

async function maybeCreateCheckpoint(tx, row, now = new Date()) {
  const interval = Math.max(
    Number(process.env.ATHENA_SECURITY_AUDIT_CHECKPOINT_INTERVAL || 100),
    1
  );
  const maxAgeMs = Math.max(
    Number(
      process.env.ATHENA_SECURITY_AUDIT_CHECKPOINT_MAX_AGE_MS || 3_600_000
    ),
    60_000
  );
  const latest = await tx.security_audit_checkpoints.findFirst({
    where: { chainId: row.chainId },
    orderBy: { throughSequence: "desc" },
  });
  const due =
    row.sequence === 1 ||
    row.sequence % interval === 0 ||
    !latest ||
    now.getTime() - latest.createdAt.getTime() >= maxAgeMs;
  if (!due) return null;
  const key = signingKey();
  const payload = checkpointEnvelope({
    chainId: row.chainId,
    throughSequence: row.sequence,
    throughHash: row.entryHash,
    keyId: key.keyId,
  });
  const signature = crypto
    .sign(null, Buffer.from(ledgerCanonical(payload), "utf8"), key.privateKey)
    .toString("base64");
  return await tx.security_audit_checkpoints.create({
    data: {
      ...payload,
      algorithm: "ed25519",
      publicKey: key.publicKey,
      signature,
      createdAt: now,
    },
  });
}

async function appendSecurityAudit({
  event,
  metadata = {},
  userId = null,
  requestId = null,
  traceId = null,
  occurredAt = new Date(),
  eventId = uuidv4(),
  chainId = CHAIN_ID,
} = {}) {
  const normalizedEvent = String(event || "")
    .trim()
    .slice(0, 160);
  if (!normalizedEvent) throw new Error("security_audit_event_required");
  const safeMetadata = normalizeMetadata(metadata);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const duplicate = await tx.security_audit_ledger.findUnique({
          where: { eventId: String(eventId) },
        });
        if (duplicate)
          return { entry: duplicate, checkpoint: null, duplicate: true };
        const tail = await tx.security_audit_ledger.findFirst({
          where: { chainId },
          orderBy: { sequence: "desc" },
        });
        const sequence = Number(tail?.sequence || 0) + 1;
        const previousHash = tail?.entryHash || GENESIS_HASH;
        const envelope = entryEnvelope({
          chainId,
          sequence,
          eventId: String(eventId),
          event: normalizedEvent,
          metadata: safeMetadata,
          userId,
          requestId,
          traceId,
          occurredAt,
          previousHash,
        });
        const entryHash = sha256(ledgerCanonical(envelope));
        const entry = await tx.security_audit_ledger.create({
          data: {
            chainId,
            sequence,
            eventId: String(eventId),
            event: normalizedEvent,
            metadataJson: JSON.stringify(safeMetadata),
            userId: Number(userId) || null,
            requestId: requestId ? String(requestId).slice(0, 160) : null,
            traceId: traceId ? String(traceId).slice(0, 64) : null,
            previousHash,
            entryHash,
            occurredAt: new Date(occurredAt),
          },
        });
        const checkpoint = await maybeCreateCheckpoint(tx, entry, new Date());
        return { entry, checkpoint, duplicate: false };
      });
    } catch (error) {
      if (error?.code !== "P2002" || attempt === 2) throw error;
    }
  }
  throw new Error("security_audit_append_failed");
}

function spoolPath() {
  return storagePath("logs", "security-audit-failures.jsonl");
}

function spoolCursorPath() {
  return `${spoolPath()}.cursor`;
}

function appendFailureSpool(record) {
  const target = spoolPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(target, "a", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(target, 0o600);
  } catch {}
  return target;
}

async function appendSecurityAuditDurably(options = {}) {
  const record = {
    ...options,
    eventId: options.eventId || uuidv4(),
    occurredAt: new Date(options.occurredAt || Date.now()).toISOString(),
    metadata: normalizeMetadata(options.metadata),
  };
  try {
    const result = { ...(await appendSecurityAudit(record)), spooled: false };
    metrics.securityAuditEvents.inc({ outcome: "appended" });
    return result;
  } catch (error) {
    let target;
    try {
      target = appendFailureSpool({
        ...record,
        ledgerErrorCode: error?.code || "security_audit_append_failed",
      });
    } catch (spoolError) {
      durabilityState.lastFatalAt = new Date().toISOString();
      durabilityState.lastFatalCode =
        spoolError?.code || "security_audit_spool_failed";
      metrics.securityAuditEvents.inc({ outcome: "failed" });
      console.error("[SecurityAudit] ledger and durable spool unavailable", {
        event: record.event,
        eventId: record.eventId,
        code: durabilityState.lastFatalCode,
      });
      throw spoolError;
    }
    console.error("[SecurityAudit] ledger append failed; durably spooled", {
      event: record.event,
      eventId: record.eventId,
      path: target,
      code: error?.code || "security_audit_append_failed",
    });
    metrics.securityAuditEvents.inc({ outcome: "spooled" });
    return { entry: null, checkpoint: null, spooled: true, spoolPath: target };
  }
}

function securityAuditDurabilitySnapshot() {
  return {
    healthy: durabilityState.lastFatalAt === null,
    ...durabilityState,
  };
}

function readSpoolCursor() {
  try {
    const value = Number(fs.readFileSync(spoolCursorPath(), "utf8"));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeSpoolCursor(value) {
  const target = spoolCursorPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${Number(value)}\n`, { mode: 0o600 });
  const fd = fs.openSync(temporary, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

async function reconcileSecurityAuditSpool({ limit = 100 } = {}) {
  const target = spoolPath();
  if (!fs.existsSync(target)) return { scanned: 0, reconciled: 0, cursor: 0 };
  const body = fs.readFileSync(target);
  let cursor = Math.min(readSpoolCursor(), body.length);
  const remaining = body.subarray(cursor).toString("utf8");
  const lines = remaining.split("\n");
  const completeCount = remaining.endsWith("\n")
    ? lines.length - 1
    : lines.length - 1;
  const selected = lines.slice(
    0,
    Math.min(completeCount, Math.max(Number(limit) || 100, 1))
  );
  let reconciled = 0;
  for (const line of selected) {
    if (!line) {
      cursor += 1;
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      error.code = "SECURITY_AUDIT_SPOOL_CORRUPT";
      throw error;
    }
    await appendSecurityAudit({
      ...record,
      metadata: {
        ...normalizeMetadata(record.metadata),
        recoveredFromFailureSpool: true,
        originalLedgerErrorCode: record.ledgerErrorCode || null,
      },
    });
    cursor += Buffer.byteLength(`${line}\n`, "utf8");
    reconciled += 1;
  }
  if (selected.length) writeSpoolCursor(cursor);
  if (reconciled)
    metrics.securityAuditEvents.inc({ outcome: "reconciled" }, reconciled);
  return { scanned: selected.length, reconciled, cursor };
}

async function verifySecurityAudit({
  chainId = CHAIN_ID,
  pageSize = 500,
} = {}) {
  const checkpoints = await prisma.security_audit_checkpoints.findMany({
    where: { chainId },
    orderBy: { throughSequence: "asc" },
  });
  const checkpointSequences = new Set(
    checkpoints.map((checkpoint) => Number(checkpoint.throughSequence))
  );
  const checkpointEntryHashes = new Map();
  const failures = [];
  let failureOverflow = 0;
  const addFailure = (failure) => {
    if (failures.length < 1_000) failures.push(failure);
    else failureOverflow += 1;
  };
  let previousHash = GENESIS_HASH;
  let entryCount = 0;
  let afterSequence = Number.MIN_SAFE_INTEGER;
  const take = Math.min(Math.max(Number(pageSize) || 500, 50), 2_000);
  while (true) {
    const rows = await prisma.security_audit_ledger.findMany({
      where: { chainId, sequence: { gt: afterSequence } },
      orderBy: { sequence: "asc" },
      take,
    });
    if (!rows.length) break;
    for (const row of rows) {
      entryCount += 1;
      const expectedSequence = entryCount;
      let metadata;
      try {
        metadata = JSON.parse(row.metadataJson || "{}");
      } catch {
        addFailure({ sequence: row.sequence, code: "metadata_unreadable" });
        metadata = {};
      }
      const expectedHash = sha256(
        ledgerCanonical(
          entryEnvelope({
            chainId: row.chainId,
            sequence: row.sequence,
            eventId: row.eventId,
            event: row.event,
            metadata,
            userId: row.userId,
            requestId: row.requestId,
            traceId: row.traceId,
            occurredAt: row.occurredAt,
            previousHash,
          })
        )
      );
      if (row.sequence !== expectedSequence)
        addFailure({ sequence: row.sequence, code: "sequence_gap" });
      if (row.previousHash !== previousHash)
        addFailure({
          sequence: row.sequence,
          code: "previous_hash_mismatch",
        });
      if (row.entryHash !== expectedHash)
        addFailure({ sequence: row.sequence, code: "entry_hash_mismatch" });
      if (checkpointSequences.has(Number(row.sequence)))
        checkpointEntryHashes.set(Number(row.sequence), row.entryHash);
      previousHash = row.entryHash;
      afterSequence = Number(row.sequence);
    }
    if (rows.length < take) break;
  }
  if (entryCount > 0 && checkpoints.length === 0) {
    addFailure({ sequence: 1, code: "checkpoint_missing" });
  } else if (entryCount > 0) {
    const interval = Math.max(
      Number(process.env.ATHENA_SECURITY_AUDIT_CHECKPOINT_INTERVAL || 100),
      1
    );
    if (!checkpointSequences.has(1))
      addFailure({ sequence: 1, code: "checkpoint_missing" });
    for (
      let sequence = interval;
      sequence <= entryCount;
      sequence += interval
    ) {
      if (!checkpointSequences.has(sequence))
        addFailure({ sequence, code: "checkpoint_missing" });
    }
  }
  for (const checkpoint of checkpoints) {
    try {
      if (String(checkpoint.algorithm).toLowerCase() !== "ed25519")
        addFailure({
          sequence: checkpoint.throughSequence,
          code: "checkpoint_algorithm_mismatch",
        });
      const trusted = signingKey(checkpoint.keyId);
      const trustedPublicKey = trusted.publicKey;
      if (checkpoint.publicKey !== trustedPublicKey)
        addFailure({
          sequence: checkpoint.throughSequence,
          code: "checkpoint_public_key_untrusted",
        });
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(trustedPublicKey, "base64"),
        format: "der",
        type: "spki",
      });
      const valid = crypto.verify(
        null,
        Buffer.from(
          ledgerCanonical(
            checkpointEnvelope({
              chainId: checkpoint.chainId,
              throughSequence: checkpoint.throughSequence,
              throughHash: checkpoint.throughHash,
              keyId: checkpoint.keyId,
            })
          ),
          "utf8"
        ),
        publicKey,
        Buffer.from(checkpoint.signature, "base64")
      );
      if (!valid)
        addFailure({
          sequence: checkpoint.throughSequence,
          code: "checkpoint_signature_invalid",
        });
      if (
        checkpointEntryHashes.get(Number(checkpoint.throughSequence)) !==
        checkpoint.throughHash
      )
        addFailure({
          sequence: checkpoint.throughSequence,
          code: "checkpoint_hash_mismatch",
        });
    } catch {
      addFailure({
        sequence: checkpoint.throughSequence,
        code: "checkpoint_unreadable",
      });
    }
  }
  return {
    valid: failures.length === 0 && failureOverflow === 0,
    chainId,
    entries: entryCount,
    checkpoints: checkpoints.length,
    headHash: previousHash,
    failures,
    failureOverflow,
  };
}

module.exports = {
  CHAIN_ID,
  GENESIS_HASH,
  appendFailureSpool,
  appendSecurityAudit,
  appendSecurityAuditDurably,
  isSecurityRelevantEvent,
  reconcileSecurityAuditSpool,
  securityAuditDurabilitySnapshot,
  verifySecurityAudit,
  _internals: {
    checkpointEnvelope,
    boundAuditValue,
    entryEnvelope,
    ledgerCanonical,
    signingKey,
  },
};
