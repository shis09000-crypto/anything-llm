const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const prisma = require("../prisma");
const { storagePath } = require("../environment");
const { resolveActiveKey } = require("./keyCustody");

const LEGACY_PREFIX = "enc:v1:";
const FIELD_SPECS = [
  { table: "api_keys", field: "secret", purpose: "database-secrets" },
  {
    table: "browser_extension_api_keys",
    field: "key",
    purpose: "database-secrets",
  },
  { table: "system_settings", field: "value", purpose: "database-secrets" },
  {
    table: "system_prompt_variables",
    field: "value",
    purpose: "database-secrets",
  },
  {
    table: "user_memory_blocks",
    field: "encryptedPayload",
    purpose: "account-memory",
  },
  { table: "workspace_chats", field: "prompt", purpose: "chat-history" },
  { table: "workspace_chats", field: "response", purpose: "chat-history" },
  {
    table: "workspace_chat_conversation_keys",
    field: "wrapped_key",
    purpose: "chat-key-wraps",
  },
  {
    table: "workspace_chat_compactions",
    field: "summary",
    purpose: "chat-history",
  },
  {
    table: "workspace_chat_compactions",
    field: "capsule_json",
    purpose: "chat-history",
  },
  {
    table: "athena_clients",
    field: "signingSecretEncrypted",
    purpose: "request-signing",
  },
];

function shortFingerprint(material) {
  return crypto
    .createHash("sha256")
    .update(material.toString("hex"))
    .digest("hex")
    .slice(0, 12);
}

function decryptLegacy(value, material) {
  const parts = String(value || "").split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}:` !== LEGACY_PREFIX) {
    throw new Error("unsupported_legacy_envelope");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    material,
    Buffer.from(parts[2], "base64url")
  );
  decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[4], "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function encryptV2(plaintext, descriptor, purpose) {
  const iv = crypto.randomBytes(12);
  const encodedPurpose = Buffer.from(purpose, "utf8").toString("base64url");
  const aad = Buffer.from(
    JSON.stringify({ version: "enc:v2", keyId: descriptor.keyId, purpose }),
    "utf8"
  );
  const cipher = crypto.createCipheriv("aes-256-gcm", descriptor.material, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  return [
    "enc:v2",
    descriptor.keyId,
    encodedPurpose,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function readCandidateMaterials(candidateSource, activeDescriptor) {
  const source = path.resolve(candidateSource);
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error("candidate_source_must_be_file");
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("candidate_source_permissions_must_be_0400_or_0600");
  }
  const matches =
    fs.readFileSync(source, "utf8").match(/\b[a-fA-F0-9]{64}\b/g) || [];
  const unique = new Map();
  for (const match of matches) {
    const material = Buffer.from(match.toLowerCase(), "hex");
    if (material.equals(activeDescriptor.material)) continue;
    unique.set(shortFingerprint(material), material);
  }
  return { source, candidates: unique };
}

async function rowsForSpec(spec) {
  return prisma.$queryRawUnsafe(
    `SELECT "id", "${spec.field}" AS "value" FROM "${spec.table}"
     WHERE "${spec.field}" LIKE 'enc:v1:%' ORDER BY "id" ASC`
  );
}

function privateWrite(filePath, payload) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
  return target;
}

function defaultBackupPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return storagePath(
    "backups",
    `key-custody-mixed-database-recovery-${stamp}.json`
  );
}

async function scanMixedKeyDatabase({ candidateSource }) {
  const active = resolveActiveKey();
  if (!active?.material) throw new Error("active_key_missing");
  const { source, candidates } = readCandidateMaterials(
    candidateSource,
    active
  );
  if (!candidates.size) throw new Error("no_distinct_candidate_keys_found");

  const mutations = [];
  const unresolved = [];
  const ambiguous = [];
  const byField = [];
  const recoveryFingerprints = new Map();

  for (const spec of FIELD_SPECS) {
    const rows = await rowsForSpec(spec);
    let activeReadable = 0;
    let recoverable = 0;
    for (const row of rows) {
      try {
        const plaintext = decryptLegacy(row.value, active.material);
        activeReadable += 1;
        mutations.push({
          ...spec,
          id: row.id,
          previousValue: row.value,
          nextValue: encryptV2(plaintext, active, spec.purpose),
          sourceFingerprint: active.fingerprint,
        });
        continue;
      } catch {}

      const matches = [];
      for (const [fingerprint, material] of candidates.entries()) {
        try {
          matches.push({
            fingerprint,
            plaintext: decryptLegacy(row.value, material),
          });
        } catch {}
      }
      if (matches.length === 0) {
        unresolved.push({ table: spec.table, field: spec.field, id: row.id });
        continue;
      }
      if (matches.length > 1) {
        ambiguous.push({ table: spec.table, field: spec.field, id: row.id });
        continue;
      }
      const [match] = matches;
      recoverable += 1;
      recoveryFingerprints.set(
        match.fingerprint,
        (recoveryFingerprints.get(match.fingerprint) || 0) + 1
      );
      mutations.push({
        ...spec,
        id: row.id,
        previousValue: row.value,
        nextValue: encryptV2(match.plaintext, active, spec.purpose),
        sourceFingerprint: match.fingerprint,
      });
    }
    byField.push({
      table: spec.table,
      field: spec.field,
      legacyRows: rows.length,
      activeReadable,
      recoverable,
    });
  }

  return {
    active,
    candidateSource: source,
    candidateCount: candidates.size,
    mutations,
    unresolved,
    ambiguous,
    byField,
    recoveryFingerprints: Object.fromEntries(recoveryFingerprints),
  };
}

async function recoverMixedKeyDatabase({
  candidateSource,
  apply = false,
  backupPath = null,
} = {}) {
  const scan = await scanMixedKeyDatabase({ candidateSource });
  const safeReport = {
    success: scan.unresolved.length === 0 && scan.ambiguous.length === 0,
    mode: apply ? "apply" : "dry-run",
    activeKeyId: scan.active.keyId,
    activeFingerprint: scan.active.fingerprint,
    candidateCount: scan.candidateCount,
    legacyRows:
      scan.mutations.length + scan.unresolved.length + scan.ambiguous.length,
    migrationCount: scan.mutations.length,
    recoveredByFingerprint: scan.recoveryFingerprints,
    unresolved: scan.unresolved,
    ambiguous: scan.ambiguous,
    fields: scan.byField,
    backup: null,
  };
  if (!safeReport.success) return safeReport;
  if (!apply || scan.mutations.length === 0) return safeReport;

  const backup = {
    format: "athena-key-custody-database-ciphertext-backup:v1",
    createdAt: new Date().toISOString(),
    activeKeyId: scan.active.keyId,
    records: scan.mutations.map((item) => ({
      table: item.table,
      field: item.field,
      id: item.id,
      ciphertext: item.previousValue,
      sourceFingerprint: item.sourceFingerprint,
    })),
  };
  safeReport.backup = privateWrite(backupPath || defaultBackupPath(), backup);

  await prisma.$transaction(async (transaction) => {
    for (const item of scan.mutations) {
      const changed = await transaction.$executeRawUnsafe(
        `UPDATE "${item.table}" SET "${item.field}" = ?
         WHERE "id" = ? AND "${item.field}" = ?`,
        item.nextValue,
        item.id,
        item.previousValue
      );
      if (Number(changed) !== 1) {
        throw new Error(
          `recovery_write_conflict:${item.table}.${item.field}:${item.id}`
        );
      }
    }
  });
  return safeReport;
}

module.exports = {
  FIELD_SPECS,
  recoverMixedKeyDatabase,
  scanMixedKeyDatabase,
};
