#!/usr/bin/env node
const crypto = require("crypto");
process.env.NODE_ENV ||= "development";

const prisma = require("../utils/prisma");

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const MAX_FAILURE_DETAILS_PER_FIELD = 20;
const ROTATION_BATCH_SIZE = 250;
const FIELD_SPECS = [
  { table: "api_keys", field: "secret" },
  { table: "browser_extension_api_keys", field: "key" },
  { table: "system_settings", field: "value" },
  { table: "user_memory_blocks", field: "encryptedPayload" },
  { table: "workspace_chats", field: "prompt" },
  { table: "workspace_chats", field: "response" },
  { table: "athena_clients", field: "signingSecretEncrypted" },
];

function usage() {
  return [
    "Usage:",
    "  OLD_ENCRYPTION_MASTER_KEY=<old 64 hex> NEW_ENCRYPTION_MASTER_KEY=<new 64 hex> node server/scripts/rotate-encryption-master-key.js [--apply]",
    "",
    "Default mode is dry-run. The script rotates enc:v1 database fields only.",
    "It does not rotate client-side Vault payloads or raw environment variables.",
  ].join("\n");
}

function parseKey(name) {
  const value = String(process.env[name] || "").trim();
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a 64-character hex string.`);
  }
  return Buffer.from(value, "hex");
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function decryptWithKey(value, key) {
  if (!isEncrypted(value)) return value;
  const parts = value.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}:` !== PREFIX) {
    throw new Error("unsupported_encrypted_secret_format");
  }
  const iv = Buffer.from(parts[2], "base64url");
  const authTag = Buffer.from(parts[3], "base64url");
  const cipherText = Buffer.from(parts[4], "base64url");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(cipherText),
    decipher.final(),
  ]).toString("utf8");
}

function encryptWithKey(value, key) {
  if (value === null || value === undefined || value === "") return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const cipherText = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  return [
    PREFIX.slice(0, -1),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    cipherText.toString("base64url"),
  ].join(":");
}

function countValue(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

async function rowsForField({ table, field, cursor = null }) {
  const delegate = prisma[table];
  if (!delegate?.findMany) throw new Error(`unsupported_table:${table}`);
  const rows = await delegate.findMany({
    where: {
      [field]: { startsWith: PREFIX },
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    select: { id: true, [field]: true },
    orderBy: { id: "asc" },
    take: ROTATION_BATCH_SIZE,
  });
  return rows.map((row) => ({ id: row.id, value: row[field] }));
}

async function updateField({ table, field, id, value }) {
  const delegate = prisma[table];
  if (!delegate?.update) throw new Error(`unsupported_table:${table}`);
  return delegate.update({
    where: { id },
    data: { [field]: value },
  });
}

async function rotateField(spec, { oldKey, newKey, apply }) {
  let cursor = null;
  let matched = 0;
  let rotated = 0;
  let failureCount = 0;
  const failures = [];

  while (true) {
    const rows = await rowsForField({ ...spec, cursor });
    if (!rows.length) break;
    matched += rows.length;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      try {
        const plaintext = decryptWithKey(row.value, oldKey);
        const next = encryptWithKey(plaintext, newKey);
        if (apply) await updateField({ ...spec, id: row.id, value: next });
        rotated += 1;
      } catch (error) {
        failureCount += 1;
        if (failures.length < MAX_FAILURE_DETAILS_PER_FIELD) {
          failures.push({
            id: countValue(row.id),
            error: error?.message || String(error),
          });
        }
      }
    }
  }

  return {
    table: spec.table,
    field: spec.field,
    matched,
    rotated,
    failureCount,
    failureDetailsTruncated: failureCount > failures.length,
    failures,
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const apply = process.argv.includes("--apply");
  const oldKey = parseKey("OLD_ENCRYPTION_MASTER_KEY");
  const newKey = parseKey("NEW_ENCRYPTION_MASTER_KEY");
  if (oldKey.equals(newKey)) {
    throw new Error(
      "OLD_ENCRYPTION_MASTER_KEY and NEW_ENCRYPTION_MASTER_KEY must differ."
    );
  }

  const results = [];
  for (const spec of FIELD_SPECS) {
    try {
      results.push(await rotateField(spec, { oldKey, newKey, apply }));
    } catch (error) {
      results.push({
        table: spec.table,
        field: spec.field,
        matched: 0,
        rotated: 0,
        failureCount: 1,
        failureDetailsTruncated: false,
        failures: [{ id: null, error: error?.message || String(error) }],
      });
    }
  }

  const failureCount = results.reduce(
    (sum, result) =>
      sum + (result.failureCount ?? result.failures?.length ?? 0),
    0
  );
  const report = {
    success: failureCount === 0,
    mode: apply ? "apply" : "dry-run",
    generatedAt: new Date().toISOString(),
    results,
    notes: [
      "Update ENCRYPTION_MASTER_KEY to NEW_ENCRYPTION_MASTER_KEY only after a successful --apply run.",
      "Vault item payloads are client-encrypted and are not rotated by this server master-key script.",
      "Raw encrypted environment variables such as GATE_API_KEY_ENCRYPTED must be rotated separately.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.success ? 0 : 1);
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: error?.message || String(error),
          usage: usage(),
        },
        null,
        2
      )
    );
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect?.().catch(() => null);
  });
