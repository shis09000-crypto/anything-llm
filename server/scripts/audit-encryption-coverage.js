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
const prisma = require("../utils/prisma");
const { storagePath } = require("../utils/environment");
const {
  isEncryptedDocumentStorePayload,
} = require("../utils/security/documentStoreEncryption");
const {
  isEncryptedVectorText,
  vectorTextEncryptionEnabled,
} = require("../utils/security/vectorTextEncryption");

const SECRET_PREFIX = "enc:v1:";

function countValue(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value || 0);
}

async function count(sql) {
  const rows = await prisma.$queryRawUnsafe(sql);
  return countValue(rows?.[0]?.count ?? rows?.[0]?.COUNT ?? 0);
}

async function safeMetric(name, fn) {
  try {
    return { name, ...(await fn()) };
  } catch (error) {
    return {
      name,
      available: false,
      error: error?.message || String(error),
    };
  }
}

async function fieldCoverage({ table, field, where = "1=1" }) {
  const total = await count(
    `SELECT COUNT(*) AS count FROM "${table}" WHERE ${where}`
  );
  const encrypted = await count(
    `SELECT COUNT(*) AS count FROM "${table}" WHERE ${where} AND "${field}" LIKE '${SECRET_PREFIX}%'`
  );
  return {
    available: true,
    table,
    field,
    total,
    encrypted,
    plaintextOrLegacy: total - encrypted,
  };
}

async function vaultCoverage() {
  const total = await count(`SELECT COUNT(*) AS count FROM "vault_items"`);
  const encrypted = await count(
    `SELECT COUNT(*) AS count FROM "vault_items" WHERE "encryptedPayload" LIKE '%"cryptoVersion":"athena-vault-item:v1"%' OR "encryptedPayload" LIKE '%"cryptoVersion": "athena-vault-item:v1"%'`
  );
  return {
    available: true,
    table: "vault_items",
    field: "encryptedPayload",
    total,
    encrypted,
    invalidOrLegacy: total - encrypted,
  };
}

async function documentCoverage() {
  const rows = await count(
    `SELECT COUNT(*) AS count FROM "workspace_documents"`
  );
  const documentsRoot = storagePath("documents");
  const vectorCacheRoot = storagePath("vector-cache");
  const documentFileCoverage = jsonFileCoverage(documentsRoot);
  const vectorCacheCoverage = jsonFileCoverage(vectorCacheRoot);
  const vectorProviderPayloads = await lanceProviderPayloadCoverage();
  return {
    available: true,
    table: "workspace_documents",
    total: rows,
    encrypted: documentFileCoverage.encrypted,
    plaintextOrUnverified: documentFileCoverage.plaintextOrLegacy,
    fileStore: {
      path: documentsRoot,
      exists: fs.existsSync(documentsRoot),
      ...documentFileCoverage,
    },
    vectorCache: {
      path: vectorCacheRoot,
      exists: fs.existsSync(vectorCacheRoot),
      ...vectorCacheCoverage,
    },
    vectorProviderPayloads,
    note: "Source document JSON, vector-cache JSON, and local LanceDB provider text can be encrypted by Athena document-store/vector-text encryption. Other remote vector providers still require provider-specific export/reindex verification.",
  };
}

async function lanceProviderPayloadCoverage() {
  const root = storagePath("lancedb");
  const base = {
    provider: "lancedb",
    path: root,
    exists: fs.existsSync(root),
    newWritesEncryptedByAthena: vectorTextEncryptionEnabled(),
    existingProviderPayloadsMigrated: true,
    tables: [],
    tableCount: 0,
    totalRows: 0,
    textRows: 0,
    encryptedTextRows: 0,
    plaintextTextRows: 0,
    missingTextRows: 0,
    unreadableTables: 0,
  };

  if (!base.exists) return base;

  let lancedb;
  try {
    lancedb = require("@lancedb/lancedb");
  } catch (error) {
    return {
      ...base,
      available: false,
      existingProviderPayloadsMigrated: false,
      error: error?.message || String(error),
    };
  }

  const client = await lancedb.connect(root);
  const tableNames = await client.tableNames();
  base.tableCount = tableNames.length;

  for (const tableName of tableNames) {
    const tableMetric = {
      tableName,
      rows: 0,
      textRows: 0,
      encryptedTextRows: 0,
      plaintextTextRows: 0,
      missingTextRows: 0,
    };

    try {
      const table = await client.openTable(tableName);
      tableMetric.rows = await table.countRows();
      const rows =
        tableMetric.rows > 0
          ? await table.query().limit(tableMetric.rows).toArray()
          : [];

      for (const row of rows) {
        const text = row?.text;
        if (typeof text !== "string" || text.length === 0) {
          tableMetric.missingTextRows += 1;
          continue;
        }

        tableMetric.textRows += 1;
        if (isEncryptedVectorText(text)) {
          tableMetric.encryptedTextRows += 1;
        } else {
          tableMetric.plaintextTextRows += 1;
        }
      }
    } catch (error) {
      tableMetric.available = false;
      tableMetric.error = error?.message || String(error);
      base.unreadableTables += 1;
    }

    base.tables.push(tableMetric);
    base.totalRows += Number(tableMetric.rows || 0);
    base.textRows += Number(tableMetric.textRows || 0);
    base.encryptedTextRows += Number(tableMetric.encryptedTextRows || 0);
    base.plaintextTextRows += Number(tableMetric.plaintextTextRows || 0);
    base.missingTextRows += Number(tableMetric.missingTextRows || 0);
  }

  base.existingProviderPayloadsMigrated =
    base.unreadableTables === 0 && base.plaintextTextRows === 0;
  return base;
}

function jsonFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...jsonFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) files.push(fullPath);
  }
  return files;
}

function jsonFileCoverage(root) {
  const files = jsonFiles(root);
  let encrypted = 0;
  let unreadable = 0;
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isEncryptedDocumentStorePayload(parsed)) encrypted += 1;
    } catch {
      unreadable += 1;
    }
  }
  return {
    files: files.length,
    encrypted,
    plaintextOrLegacy: files.length - encrypted - unreadable,
    unreadable,
    encryptedByAthena: files.length > 0 && encrypted === files.length,
  };
}

async function main() {
  const metrics = [];
  metrics.push(
    await safeMetric("api_keys.secret", () =>
      fieldCoverage({
        name: "api_keys.secret",
        table: "api_keys",
        field: "secret",
      })
    )
  );
  metrics.push(
    await safeMetric("browser_extension_api_keys.key", () =>
      fieldCoverage({
        name: "browser_extension_api_keys.key",
        table: "browser_extension_api_keys",
        field: "key",
      })
    )
  );
  metrics.push(
    await safeMetric("system_settings.value.encrypted", () =>
      fieldCoverage({
        name: "system_settings.value.encrypted",
        table: "system_settings",
        field: "value",
        where: `"value" IS NOT NULL AND "value" != ''`,
      })
    )
  );
  metrics.push(
    await safeMetric("user_memory_blocks.encryptedPayload", () =>
      fieldCoverage({
        name: "user_memory_blocks.encryptedPayload",
        table: "user_memory_blocks",
        field: "encryptedPayload",
        where: `"isSensitive" = true AND "encryptedPayload" IS NOT NULL`,
      })
    )
  );
  metrics.push(
    await safeMetric("workspace_chats.prompt", () =>
      fieldCoverage({
        name: "workspace_chats.prompt",
        table: "workspace_chats",
        field: "prompt",
      })
    )
  );
  metrics.push(
    await safeMetric("workspace_chats.response", () =>
      fieldCoverage({
        name: "workspace_chats.response",
        table: "workspace_chats",
        field: "response",
      })
    )
  );
  metrics.push(
    await safeMetric("athena_clients.signingSecretEncrypted", () =>
      fieldCoverage({
        name: "athena_clients.signingSecretEncrypted",
        table: "athena_clients",
        field: "signingSecretEncrypted",
        where: `"signingSecretEncrypted" IS NOT NULL`,
      })
    )
  );
  metrics.push(await safeMetric("vault_items.encryptedPayload", vaultCoverage));
  metrics.push(
    await safeMetric("workspace_documents_and_rag", documentCoverage)
  );

  const highRisk = metrics.filter(
    (metric) =>
      metric.available !== false &&
      (([
        "api_keys.secret",
        "browser_extension_api_keys.key",
        "vault_items.encryptedPayload",
      ].includes(metric.name) &&
        Number(metric.plaintextOrLegacy ?? metric.invalidOrLegacy ?? 0) > 0) ||
        (metric.name === "workspace_documents_and_rag" &&
          metric.vectorProviderPayloads?.newWritesEncryptedByAthena &&
          !metric.vectorProviderPayloads?.existingProviderPayloadsMigrated))
  );

  const report = {
    success: highRisk.length === 0,
    generatedAt: new Date().toISOString(),
    secretPrefix: SECRET_PREFIX,
    metrics,
    highRiskFindings: highRisk,
    serialEncryptionFeasibility: {
      feasible: true,
      recommendedFor: [
        "vault",
        "workspace_documents",
        "rag_chunks",
        "local_reader_cache",
      ],
      notRecommendedFor: [
        "hot_llm_context",
        "vector_math_payloads_without_chunk_key_indirection",
      ],
      note: "Use envelope encryption with per-domain DEKs wrapped by workspace or vault keys. Avoid repeatedly encrypting already encrypted blobs in the inference hot path.",
    },
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.success ? 0 : 1);
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        { success: false, error: error?.message || String(error) },
        null,
        2
      )
    );
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect?.().catch(() => null);
  });
