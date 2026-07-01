#!/usr/bin/env node
process.env.NODE_ENV ||= "development";

const fs = require("fs");
const path = require("path");
const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: path.join(__dirname, "..", envPath) });
const { applyEnvironmentStorage } = require("../utils/environment");
applyEnvironmentStorage();
const lancedb = require("@lancedb/lancedb");
const { storagePath } = require("../utils/environment");
const {
  encryptVectorText,
  isEncryptedVectorText,
  vectorTextEncryptionEnabled,
} = require("../utils/security/vectorTextEncryption");

const DEFAULT_BATCH_SIZE = 100;

function hasArg(name) {
  return process.argv.includes(name);
}

function getArgValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function chunk(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

async function readRows(table, count) {
  if (count <= 0) return [];
  return await table.query().limit(count).toArray();
}

async function migrateTable({ table, tableName, apply, batchSize }) {
  const count = await table.countRows();
  const rows = await readRows(table, count);
  const failures = [];
  const candidates = [];
  let encrypted = 0;
  let missingText = 0;

  for (const row of rows) {
    const text = row?.text;
    if (typeof text !== "string" || text.length === 0) {
      missingText += 1;
      continue;
    }
    if (isEncryptedVectorText(text)) {
      encrypted += 1;
      continue;
    }
    if (!row?.id) {
      failures.push({ id: null, error: "Row is missing id; cannot update." });
      continue;
    }
    candidates.push({
      id: String(row.id),
      encryptedText: encryptVectorText(text),
    });
  }

  let updated = 0;
  if (apply) {
    for (const group of chunk(candidates, batchSize)) {
      for (const candidate of group) {
        try {
          await table.update({
            where: `id = ${sqlString(candidate.id)}`,
            values: { text: candidate.encryptedText },
          });
          updated += 1;
        } catch (error) {
          failures.push({
            id: candidate.id,
            error: error?.message || String(error),
          });
        }
      }
    }
  }

  return {
    tableName,
    rows: count,
    encrypted,
    missingText,
    plaintextCandidates: candidates.length,
    updated,
    failures,
  };
}

async function main() {
  const apply = hasArg("--apply");
  const batchSize = Number(getArgValue("--batch-size", DEFAULT_BATCH_SIZE));
  const root = storagePath("lancedb");

  if (apply && !vectorTextEncryptionEnabled()) {
    throw new Error(
      "LanceDB vector text migration requires ENCRYPTION_MASTER_KEY."
    );
  }

  if (!fs.existsSync(root)) {
    const report = {
      success: true,
      mode: apply ? "apply" : "dry-run",
      encryptionReady: vectorTextEncryptionEnabled(),
      provider: "lancedb",
      path: root,
      exists: false,
      tables: [],
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const client = await lancedb.connect(root);
  const tableNames = await client.tableNames();
  const tables = [];

  for (const tableName of tableNames) {
    try {
      const table = await client.openTable(tableName);
      tables.push(await migrateTable({ table, tableName, apply, batchSize }));
    } catch (error) {
      tables.push({
        tableName,
        available: false,
        error: error?.message || String(error),
      });
    }
  }

  const failureCount = tables.reduce((sum, table) => {
    return (
      sum + (table.failures?.length || 0) + (table.available === false ? 1 : 0)
    );
  }, 0);
  const plaintextCandidates = tables.reduce(
    (sum, table) => sum + Number(table.plaintextCandidates || 0),
    0
  );
  const updated = tables.reduce(
    (sum, table) => sum + Number(table.updated || 0),
    0
  );

  const report = {
    success: failureCount === 0,
    mode: apply ? "apply" : "dry-run",
    encryptionReady: vectorTextEncryptionEnabled(),
    provider: "lancedb",
    path: root,
    exists: true,
    tableCount: tableNames.length,
    plaintextCandidates,
    updated,
    tables,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.success ? 0 : 1);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      { success: false, error: error?.message || String(error) },
      null,
      2
    )
  );
  process.exit(1);
});
