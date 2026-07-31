const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const prisma = require("../prisma");
const { storagePath } = require("../environment");
const { canonicalJson } = require("../syncV2/canonicalJson");
const { redactLogObject } = require("./redaction");
const { resolveActiveKey, resolveKey } = require("./keyCustody");
const { recordDecryptOnlyKeyRead } = require("./legacyKeyReadObservation");
const { metrics } = require("../observability/metrics");
const {
  PURPOSES,
  SUITE_IDS,
  cryptoSuite,
  preferredCryptoSuite,
  signatureBufferEncoding,
  signWithCryptoSuite,
  supportsNodeSignatureSuite,
  verifyWithCryptoSuite,
} = require("./cryptoSuiteRegistry");

const CHAIN_ID = "security-v1";
const GENESIS_HASH = "0".repeat(64);
const CHECKPOINT_SIGNATURE_ENVELOPE_FORMAT =
  "athena-audit-signature-envelope:v1";
const CHECKPOINT_SIGNING_PAYLOAD_FORMAT = "athena-audit-checkpoint-payload:v2";
const CHECKPOINT_SIGNATURE_MIGRATION_FORMAT =
  "athena-audit-signature-migration:v1";
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
const AUDIT_SIGNATURE_SUITE = preferredCryptoSuite(
  PURPOSES.SECURITY_AUDIT_CHECKPOINT
);
if (
  !AUDIT_SIGNATURE_SUITE ||
  !supportsNodeSignatureSuite(AUDIT_SIGNATURE_SUITE)
)
  throw new Error("security_audit_crypto_suite_unavailable");
const AUDIT_PQ_SIGNATURE_SUITE = cryptoSuite(SUITE_IDS.AUDIT_MLDSA65_V1, {
  purpose: PURPOSES.SECURITY_AUDIT_CHECKPOINT,
});

function auditHybridMode(env = process.env) {
  const configured = String(env.ATHENA_AUDIT_HYBRID_SIGNATURES || "")
    .trim()
    .toLowerCase();
  if (["required", "optional", "off"].includes(configured)) return configured;
  return env.NODE_ENV === "production" ? "required" : "optional";
}

function auditSignaturePolicy(env = process.env) {
  const mode = auditHybridMode(env);
  return {
    threshold: mode === "required" ? 2 : 1,
    classicalRequired: true,
    pqRequired: mode === "required",
  };
}

function classicalCheckpointSignature({ key, payload, signedAt }) {
  return {
    suiteId: AUDIT_SIGNATURE_SUITE.suiteId,
    keyId: key.keyId,
    publicKey: key.publicKey,
    signature: signWithCryptoSuite({
      suite: AUDIT_SIGNATURE_SUITE,
      data: payload,
      privateKey: key.privateKey,
    }).toString(signatureBufferEncoding(AUDIT_SIGNATURE_SUITE)),
    signedAt: new Date(signedAt).toISOString(),
    postQuantum: false,
    parameterSet: key.parameterSet,
    keyOrigin: key.keyOrigin,
    hardwareProtection: key.hardwareProtection,
  };
}

function postQuantumCheckpointSignature({ payload, signedAt }) {
  if (!AUDIT_PQ_SIGNATURE_SUITE)
    throw new Error("security_audit_pq_suite_unavailable");
  const key = pqSigningKey();
  return {
    suiteId: AUDIT_PQ_SIGNATURE_SUITE.suiteId,
    keyId: key.keyId,
    publicKey: key.publicKey,
    signature: signWithCryptoSuite({
      suite: AUDIT_PQ_SIGNATURE_SUITE,
      data: payload,
      privateKey: key.privateKey,
    }).toString(signatureBufferEncoding(AUDIT_PQ_SIGNATURE_SUITE)),
    signedAt: new Date(signedAt).toISOString(),
    postQuantum: true,
    parameterSet: key.parameterSet,
    keyOrigin: key.keyOrigin,
    hardwareProtection: key.hardwareProtection,
  };
}

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
    purpose: descriptor.purpose,
    status: descriptor.status,
    parameterSet: AUDIT_SIGNATURE_SUITE.parameterSet,
    keyOrigin: `hkdf-derived-from-${String(
      descriptor.providerType || "key-custody"
    )}`,
    // The Ed25519 seed is derived in application memory even when the root
    // provider has stronger protection. Do not overstate hardware assurance.
    hardwareProtection: "software-runtime-derived",
    privateKey,
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

function pqSigningKey(keyId = null, { privateKeyRequired = true } = {}) {
  const configuredKeyId = String(
    process.env.ATHENA_AUDIT_MLDSA65_KEY_ID || "audit-mldsa65-primary"
  ).trim();
  if (keyId && keyId !== configuredKeyId)
    throw new Error("security_audit_pq_key_untrusted");
  const privateKeyFile = String(
    process.env.ATHENA_AUDIT_MLDSA65_PRIVATE_KEY_FILE || ""
  ).trim();
  const publicKeyFile = String(
    process.env.ATHENA_AUDIT_MLDSA65_PUBLIC_KEY_FILE || ""
  ).trim();
  if (!publicKeyFile || (privateKeyRequired && !privateKeyFile))
    throw new Error("security_audit_pq_key_unavailable");
  if (privateKeyRequired) {
    const stat = fs.statSync(path.resolve(privateKeyFile));
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error("security_audit_pq_private_key_permissions_unsafe");
  }
  const privateKey = privateKeyRequired
    ? fs.readFileSync(path.resolve(privateKeyFile), "utf8")
    : null;
  const publicKey = crypto.createPublicKey(
    fs.readFileSync(path.resolve(publicKeyFile), "utf8")
  );
  return {
    keyId: configuredKeyId,
    parameterSet: AUDIT_PQ_SIGNATURE_SUITE.parameterSet,
    keyOrigin: "external-pq-key-provider",
    hardwareProtection: String(
      process.env.ATHENA_AUDIT_MLDSA65_HARDWARE_PROTECTION ||
        "provider-asserted"
    ),
    privateKey,
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

function checkpointEnvelope({
  chainId,
  throughSequence,
  throughHash,
  keyId,
  suiteId = null,
}) {
  return {
    chainId,
    throughSequence,
    throughHash,
    keyId,
    ...(suiteId ? { suiteId } : {}),
  };
}

function checkpointSigningPayload({
  chainId,
  throughSequence,
  throughHash,
  policy,
  legacyPolicyShape = false,
}) {
  return {
    format: CHECKPOINT_SIGNING_PAYLOAD_FORMAT,
    chainId,
    throughSequence,
    throughHash,
    policy: {
      threshold: Math.max(Number(policy?.threshold) || 1, 1),
      ...(!legacyPolicyShape
        ? { classicalRequired: policy?.classicalRequired !== false }
        : {}),
      pqRequired: policy?.pqRequired === true,
    },
  };
}

function parseCheckpointSignatureEnvelope(checkpoint) {
  if (!checkpoint?.signatureEnvelopeJson) return null;
  const envelope = JSON.parse(checkpoint.signatureEnvelopeJson);
  if (
    envelope?.format !== CHECKPOINT_SIGNATURE_ENVELOPE_FORMAT ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length < 1 ||
    envelope.signatures.length > 8
  ) {
    throw new Error("security_audit_signature_envelope_invalid");
  }
  const threshold = Number(envelope.policy?.threshold);
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 1 ||
    threshold > envelope.signatures.length
  ) {
    throw new Error("security_audit_signature_threshold_invalid");
  }
  return {
    format: envelope.format,
    legacyPolicyShape: !Object.prototype.hasOwnProperty.call(
      envelope.policy || {},
      "classicalRequired"
    ),
    policy: {
      threshold,
      classicalRequired: envelope.policy?.classicalRequired !== false,
      pqRequired: envelope.policy?.pqRequired === true,
    },
    signatures: envelope.signatures,
  };
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
  const policy = auditSignaturePolicy();
  const payload = checkpointSigningPayload({
    chainId: row.chainId,
    throughSequence: row.sequence,
    throughHash: row.entryHash,
    policy,
  });
  const signingPayload = Buffer.from(ledgerCanonical(payload), "utf8");
  const signatureRecord = classicalCheckpointSignature({
    key,
    payload: signingPayload,
    signedAt: now,
  });
  const signature = signatureRecord.signature;
  const signatures = [signatureRecord];
  if (auditHybridMode() !== "off") {
    try {
      signatures.push(
        postQuantumCheckpointSignature({
          payload: signingPayload,
          signedAt: now,
        })
      );
    } catch (error) {
      if (policy.pqRequired) throw error;
    }
  }
  const signatureEnvelope = {
    format: CHECKPOINT_SIGNATURE_ENVELOPE_FORMAT,
    policy,
    signatures,
  };
  return await tx.security_audit_checkpoints.create({
    data: {
      chainId: row.chainId,
      throughSequence: row.sequence,
      throughHash: row.entryHash,
      algorithm: AUDIT_SIGNATURE_SUITE.suiteId,
      parameterSet: key.parameterSet,
      keyOrigin: key.keyOrigin,
      hardwareProtection: key.hardwareProtection,
      keyId: key.keyId,
      publicKey: key.publicKey,
      signature,
      signatureEnvelopeJson: JSON.stringify(signatureEnvelope),
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
  client = prisma,
} = {}) {
  const checkpoints = await client.security_audit_checkpoints.findMany({
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
  let afterSequence = null;
  const take = Math.min(Math.max(Number(pageSize) || 500, 50), 2_000);
  while (true) {
    const rows = await client.security_audit_ledger.findMany({
      where: {
        chainId,
        ...(afterSequence === null
          ? {}
          : { sequence: { gt: afterSequence } }),
      },
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
      const signatureEnvelope = parseCheckpointSignatureEnvelope(checkpoint);
      if (signatureEnvelope) {
        const primary = signatureEnvelope.signatures[0];
        if (primary?.suiteId !== checkpoint.algorithm) {
          addFailure({
            sequence: checkpoint.throughSequence,
            code: "checkpoint_algorithm_mismatch",
          });
        }
        if (primary?.publicKey !== checkpoint.publicKey) {
          addFailure({
            sequence: checkpoint.throughSequence,
            code: "checkpoint_public_key_untrusted",
          });
        }
        if (
          primary?.parameterSet !== checkpoint.parameterSet ||
          primary?.keyOrigin !== checkpoint.keyOrigin ||
          primary?.hardwareProtection !== checkpoint.hardwareProtection
        ) {
          addFailure({
            sequence: checkpoint.throughSequence,
            code: "checkpoint_key_metadata_mismatch",
          });
        }
        if (
          primary?.suiteId !== checkpoint.algorithm ||
          primary?.keyId !== checkpoint.keyId ||
          primary?.publicKey !== checkpoint.publicKey ||
          primary?.signature !== checkpoint.signature
        ) {
          addFailure({
            sequence: checkpoint.throughSequence,
            code: "checkpoint_signature_envelope_primary_mismatch",
          });
        }
        const payloads = [signatureEnvelope.legacyPolicyShape, false]
          .filter((legacyPolicyShape, index, values) => {
            return values.indexOf(legacyPolicyShape) === index;
          })
          .map((legacyPolicyShape) =>
            Buffer.from(
              ledgerCanonical(
                checkpointSigningPayload({
                  chainId: checkpoint.chainId,
                  throughSequence: checkpoint.throughSequence,
                  throughHash: checkpoint.throughHash,
                  policy: signatureEnvelope.policy,
                  legacyPolicyShape,
                })
              ),
              "utf8"
            )
          );
        let validSignatures = 0;
        let validPostQuantumSignatures = 0;
        let validClassicalSignatures = 0;
        const verifiedKeyIds = new Set();
        for (const signature of signatureEnvelope.signatures) {
          if (!signature?.keyId || verifiedKeyIds.has(signature.keyId)) {
            addFailure({
              sequence: checkpoint.throughSequence,
              code: "checkpoint_signature_key_duplicate_or_missing",
            });
            continue;
          }
          verifiedKeyIds.add(signature.keyId);
          const suite = cryptoSuite(signature.suiteId, {
            purpose: PURPOSES.SECURITY_AUDIT_CHECKPOINT,
            at: new Date(
              signature.signedAt || checkpoint.createdAt || Date.now()
            ),
          });
          if (!suite) {
            addFailure({
              sequence: checkpoint.throughSequence,
              code: "checkpoint_algorithm_mismatch",
            });
            continue;
          }
          if (
            !supportsNodeSignatureSuite(suite) ||
            !signatureBufferEncoding(suite)
          ) {
            addFailure({
              sequence: checkpoint.throughSequence,
              code: "checkpoint_algorithm_implementation_unavailable",
            });
            continue;
          }
          const trusted = suite.pqAlgorithm
            ? pqSigningKey(signature.keyId, { privateKeyRequired: false })
            : signingKey(signature.keyId);
          if (
            signature.parameterSet !== suite.parameterSet ||
            signature.parameterSet !== trusted.parameterSet ||
            signature.keyOrigin !== trusted.keyOrigin ||
            signature.hardwareProtection !== trusted.hardwareProtection
          ) {
            addFailure({
              sequence: checkpoint.throughSequence,
              code: "checkpoint_key_metadata_mismatch",
            });
            continue;
          }
          if (signature.publicKey !== trusted.publicKey) {
            addFailure({
              sequence: checkpoint.throughSequence,
              code: "checkpoint_public_key_untrusted",
            });
            continue;
          }
          const publicKey = crypto.createPublicKey({
            key: Buffer.from(trusted.publicKey, "base64"),
            format: "der",
            type: "spki",
          });
          const valid = payloads.some((data) =>
            verifyWithCryptoSuite({
              suite,
              data,
              publicKey,
              signature: signature.signature,
            })
          );
          if (!valid) {
            addFailure({
              sequence: checkpoint.throughSequence,
              code: "checkpoint_signature_invalid",
            });
            continue;
          }
          if (!suite.pqAlgorithm) {
            recordDecryptOnlyKeyRead(trusted, {
              domain: "security-audit-checkpoint",
              runtimeRole: process.env.ATHENA_RUNTIME_ROLE || "audit-verifier",
              resource: checkpoint.id,
            });
          }
          validSignatures += 1;
          if (suite.pqAlgorithm) validPostQuantumSignatures += 1;
          else validClassicalSignatures += 1;
        }
        if (validSignatures < signatureEnvelope.policy.threshold) {
          addFailure({
            sequence: checkpoint.throughSequence,
            code: "checkpoint_signature_threshold_not_met",
          });
        }
        if (
          signatureEnvelope.policy.pqRequired &&
          validPostQuantumSignatures < 1
        ) {
          addFailure({
            sequence: checkpoint.throughSequence,
            code: "checkpoint_post_quantum_signature_required",
          });
        }
        if (
          signatureEnvelope.policy.classicalRequired &&
          validClassicalSignatures < 1
        ) {
          addFailure({
            sequence: checkpoint.throughSequence,
            code: "checkpoint_classical_signature_required",
          });
        }
        const requiredPolicy = auditSignaturePolicy();
        if (
          requiredPolicy.pqRequired &&
          (!signatureEnvelope.policy.pqRequired ||
            signatureEnvelope.policy.threshold < requiredPolicy.threshold)
        ) {
          addFailure({
            sequence: checkpoint.throughSequence,
            code: "checkpoint_signature_policy_downgrade",
          });
        }
      } else {
        const checkpointSuite = cryptoSuite(checkpoint.algorithm, {
          purpose: PURPOSES.SECURITY_AUDIT_CHECKPOINT,
          at: new Date(checkpoint.createdAt || Date.now()),
        });
        if (!checkpointSuite) {
          addFailure({
            sequence: checkpoint.throughSequence,
            code: "checkpoint_algorithm_mismatch",
          });
        } else if (
          !supportsNodeSignatureSuite(checkpointSuite) ||
          !signatureBufferEncoding(checkpointSuite)
        ) {
          addFailure({
            sequence: checkpoint.throughSequence,
            code: "checkpoint_algorithm_implementation_unavailable",
          });
        } else {
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
          const valid = verifyWithCryptoSuite({
            suite: checkpointSuite,
            data: Buffer.from(
              ledgerCanonical(
                checkpointEnvelope({
                  chainId: checkpoint.chainId,
                  throughSequence: checkpoint.throughSequence,
                  throughHash: checkpoint.throughHash,
                  keyId: checkpoint.keyId,
                  suiteId:
                    checkpoint.algorithm === checkpointSuite.suiteId
                      ? checkpointSuite.suiteId
                      : null,
                })
              ),
              "utf8"
            ),
            publicKey,
            signature: checkpoint.signature,
          });
          if (!valid)
            addFailure({
              sequence: checkpoint.throughSequence,
              code: "checkpoint_signature_invalid",
            });
          else
            recordDecryptOnlyKeyRead(trusted, {
              domain: "security-audit-checkpoint",
              runtimeRole: process.env.ATHENA_RUNTIME_ROLE || "audit-verifier",
              resource: checkpoint.id,
            });
        }
      }
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

async function resignSecurityAuditCheckpoints({
  sourceKeyId,
  targetKeyId,
  now = new Date(),
} = {}) {
  const sourceId = String(sourceKeyId || "").trim();
  const targetId = String(targetKeyId || "").trim();
  if (!sourceId || !targetId)
    throw new Error("security_audit_signature_migration_key_required");
  if (sourceId === targetId)
    throw new Error("security_audit_signature_migration_keys_equal");

  // Fail closed before touching any signature. This proves that the old
  // custody key still anchors every checkpoint we are about to migrate.
  const before = await verifySecurityAudit();
  if (!before.valid)
    throw new Error("security_audit_signature_migration_source_invalid");

  const sourceKey = signingKey(sourceId);
  const targetKey = signingKey(targetId);
  const checkpoints = await prisma.security_audit_checkpoints.findMany({
    where: { keyId: sourceId },
    orderBy: { throughSequence: "asc" },
  });
  if (!checkpoints.length) {
    return {
      sourceKeyId: sourceId,
      targetKeyId: targetId,
      migrated: 0,
      verified: true,
    };
  }

  const migrations = checkpoints.map((checkpoint) => {
    const parsedEnvelope = parseCheckpointSignatureEnvelope(checkpoint);
    const originalEnvelope = checkpoint.signatureEnvelopeJson
      ? JSON.parse(checkpoint.signatureEnvelopeJson)
      : null;
    const legacyPolicyShape = parsedEnvelope?.legacyPolicyShape === true;
    const policy = parsedEnvelope?.policy || auditSignaturePolicy();
    const storedPolicy = legacyPolicyShape
      ? {
          threshold: policy.threshold,
          pqRequired: policy.pqRequired,
        }
      : policy;
    const payload = Buffer.from(
      ledgerCanonical(
        checkpointSigningPayload({
          chainId: checkpoint.chainId,
          throughSequence: checkpoint.throughSequence,
          throughHash: checkpoint.throughHash,
          policy,
          legacyPolicyShape,
        })
      ),
      "utf8"
    );
    const targetSignature = classicalCheckpointSignature({
      key: targetKey,
      payload,
      signedAt: now,
    });
    const retainedSignatures = (parsedEnvelope?.signatures || []).filter(
      (signature) =>
        signature?.keyId !== sourceId && signature?.keyId !== targetId
    );
    const signatures = [targetSignature, ...retainedSignatures];
    if (
      policy.pqRequired &&
      !signatures.some((signature) => signature?.postQuantum === true)
    ) {
      signatures.push(
        postQuantumCheckpointSignature({ payload, signedAt: now })
      );
    }
    if (
      signatures.length < policy.threshold ||
      (policy.classicalRequired !== false &&
        !signatures.some((signature) => signature?.postQuantum !== true)) ||
      (policy.pqRequired &&
        !signatures.some((signature) => signature?.postQuantum === true))
    ) {
      throw new Error("security_audit_signature_migration_policy_unmet");
    }

    const priorHistory = Array.isArray(
      originalEnvelope?.retiredSignatureHistory
    )
      ? originalEnvelope.retiredSignatureHistory.slice(-31)
      : [];
    const previousEnvelope = originalEnvelope
      ? Object.fromEntries(
          Object.entries(originalEnvelope).filter(
            ([key]) => key !== "retiredSignatureHistory"
          )
        )
      : null;
    const signatureEnvelope = {
      format: CHECKPOINT_SIGNATURE_ENVELOPE_FORMAT,
      policy: storedPolicy,
      signatures,
      retiredSignatureHistory: [
        ...priorHistory,
        {
          format: CHECKPOINT_SIGNATURE_MIGRATION_FORMAT,
          migratedAt: new Date(now).toISOString(),
          sourceKeyId: sourceKey.keyId,
          targetKeyId: targetKey.keyId,
          previousCheckpoint: {
            algorithm: checkpoint.algorithm,
            parameterSet: checkpoint.parameterSet,
            keyOrigin: checkpoint.keyOrigin,
            hardwareProtection: checkpoint.hardwareProtection,
            keyId: checkpoint.keyId,
            publicKey: checkpoint.publicKey,
            signature: checkpoint.signature,
          },
          previousSignatureEnvelope: previousEnvelope,
        },
      ],
    };
    return {
      id: checkpoint.id,
      previousKeyId: checkpoint.keyId,
      data: {
        algorithm: targetSignature.suiteId,
        parameterSet: targetSignature.parameterSet,
        keyOrigin: targetSignature.keyOrigin,
        hardwareProtection: targetSignature.hardwareProtection,
        keyId: targetSignature.keyId,
        publicKey: targetSignature.publicKey,
        signature: targetSignature.signature,
        signatureEnvelopeJson: JSON.stringify(signatureEnvelope),
      },
    };
  });

  await prisma.$transaction(async (tx) => {
    for (const migration of migrations) {
      const changed = await tx.security_audit_checkpoints.updateMany({
        where: {
          id: migration.id,
          keyId: migration.previousKeyId,
        },
        data: migration.data,
      });
      if (Number(changed?.count || 0) !== 1)
        throw new Error("security_audit_signature_migration_write_conflict");
    }
    const after = await verifySecurityAudit({ client: tx });
    if (!after.valid)
      throw new Error("security_audit_signature_migration_target_invalid");
  });

  return {
    sourceKeyId: sourceId,
    targetKeyId: targetId,
    migrated: migrations.length,
    verified: true,
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
  resignSecurityAuditCheckpoints,
  securityAuditDurabilitySnapshot,
  verifySecurityAudit,
  _internals: {
    CHECKPOINT_SIGNATURE_ENVELOPE_FORMAT,
    CHECKPOINT_SIGNING_PAYLOAD_FORMAT,
    CHECKPOINT_SIGNATURE_MIGRATION_FORMAT,
    checkpointEnvelope,
    checkpointSigningPayload,
    parseCheckpointSignatureEnvelope,
    boundAuditValue,
    entryEnvelope,
    ledgerCanonical,
    signingKey,
    pqSigningKey,
    auditHybridMode,
    auditSignaturePolicy,
  },
};
