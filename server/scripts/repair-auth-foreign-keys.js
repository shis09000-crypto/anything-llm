#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
process.env.ATHENA_AUTH_INTEGRITY_REPAIR_MODE = "true";
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");
let authPrisma;
let authDatabasePath;

const FIXABLE_CHILDREN = Object.freeze({
  recovery_codes: { column: "user_id", parent: "users" },
  password_reset_tokens: { column: "user_id", parent: "users" },
  email_verification_codes: { column: "user_id", parent: "users" },
  PasskeyCredential: { column: "userId", parent: "users" },
  PasskeyChallenge: { column: "userId", parent: "users" },
  TrustedLoginDevice: { column: "userId", parent: "users" },
  ZkLoginAttempt: { column: "userId", parent: "users" },
  auth_sessions: { column: "authUserId", parent: "users" },
});

function quotedIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function violations() {
  return authPrisma.$queryRawUnsafe("PRAGMA foreign_key_check");
}

async function createBackup() {
  const dbPath = authDatabasePath();
  if (!dbPath)
    throw new Error("--fix only supports the local SQLite shared Auth DB.");
  await authPrisma.$queryRawUnsafe("PRAGMA wal_checkpoint(FULL)");
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `auth-${stamp}.db`);
  fs.copyFileSync(dbPath, target, fs.constants.COPYFILE_EXCL);
  return target;
}

async function deleteKnownOrphans(rows) {
  const touched = new Set();
  for (const row of rows) {
    const table = String(row.table || "");
    const rule = FIXABLE_CHILDREN[table];
    if (!rule || String(row.parent || "") !== rule.parent) continue;
    if (touched.has(table)) continue;
    touched.add(table);
    const tableName = quotedIdentifier(table);
    const columnName = quotedIdentifier(rule.column);
    const parentName = quotedIdentifier(rule.parent);
    await authPrisma.$executeRawUnsafe(
      `DELETE FROM ${tableName} WHERE ${columnName} IS NOT NULL AND ${columnName} NOT IN (SELECT "id" FROM ${parentName})`
    );
  }
  return [...touched];
}

async function main() {
  const requestedFix = process.argv.includes("--fix");
  const execute = process.argv.includes("--execute");
  const fix = requestedFix && execute;
  await bootstrapCliRuntime({
    access: fix ? "write" : "read",
    execute: fix,
    database: "auth",
    requiredTables: ["users", "auth_sessions"],
  });
  authPrisma = require("../utils/authPrisma");
  authDatabasePath = require("../utils/environment").authDatabasePath;
  const before = await violations();
  console.log(
    JSON.stringify(
      {
        mode: fix ? "fix" : "dry-run",
        requestedFix,
        violations: before.length,
        tables: [...new Set(before.map((row) => row.table))].sort(),
        instruction:
          requestedFix && !execute
            ? "Repeat with explicit APP_ENV or --env plus --execute to mutate."
            : null,
      },
      null,
      2
    )
  );
  if (!fix || before.length === 0) return;

  const unsupported = before.filter((row) => {
    const rule = FIXABLE_CHILDREN[String(row.table || "")];
    return !rule || String(row.parent || "") !== rule.parent;
  });
  if (unsupported.length > 0) {
    throw new Error(
      `Refusing repair: ${unsupported.length} violation(s) are outside the orphan-child allowlist.`
    );
  }

  const backupPath = await createBackup();
  const repairedTables = await deleteKnownOrphans(before);
  const after = await violations();
  if (after.length > 0) {
    throw new Error(
      `Repair incomplete: ${after.length} foreign-key violation(s) remain. Backup: ${backupPath}`
    );
  }
  console.log(
    JSON.stringify(
      { repaired: true, repairedTables, backupPath, violations: 0 },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(`[auth-db-repair] ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => authPrisma?.$disconnect());
