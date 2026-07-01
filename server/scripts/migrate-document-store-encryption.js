#!/usr/bin/env node
process.env.NODE_ENV ||= "development";

const fs = require("fs");
const path = require("path");
const {
  documentsPath,
  readDocumentJsonFile,
  readVectorCacheJsonFile,
  writeDocumentJsonFile,
  writeVectorCacheJsonFile,
} = require("../utils/files");
const { storagePath } = require("../utils/environment");
const {
  documentStoreEncryptionEnabled,
  isEncryptedDocumentStorePayload,
} = require("../utils/security/documentStoreEncryption");

const vectorCachePath = storagePath("vector-cache");

function hasArg(name) {
  return process.argv.includes(name);
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

function fileIsEncrypted(filePath) {
  try {
    return isEncryptedDocumentStorePayload(
      JSON.parse(fs.readFileSync(filePath, "utf8"))
    );
  } catch {
    return false;
  }
}

async function migrateFiles({ files, read, write, apply }) {
  const failures = [];
  let encrypted = 0;
  let candidates = 0;
  let updated = 0;

  for (const file of files) {
    try {
      if (fileIsEncrypted(file)) {
        encrypted += 1;
        continue;
      }
      candidates += 1;
      const payload = read(file);
      if (apply) {
        write(file, payload);
        updated += 1;
      }
    } catch (error) {
      failures.push({
        file,
        error: error?.message || String(error),
      });
    }
  }

  return {
    scanned: files.length,
    encrypted,
    candidates,
    updated,
    failures,
  };
}

async function main() {
  const apply = hasArg("--apply");
  if (apply && !documentStoreEncryptionEnabled()) {
    throw new Error(
      "DOCUMENT store encryption apply requires ENCRYPTION_MASTER_KEY."
    );
  }

  const includeDocuments = !hasArg("--vector-cache-only");
  const includeVectorCache = !hasArg("--documents-only");
  const results = {};

  if (includeDocuments) {
    results.documents = await migrateFiles({
      files: jsonFiles(documentsPath),
      read: readDocumentJsonFile,
      write: writeDocumentJsonFile,
      apply,
    });
  }

  if (includeVectorCache) {
    results.vectorCache = await migrateFiles({
      files: jsonFiles(vectorCachePath),
      read: readVectorCacheJsonFile,
      write: writeVectorCacheJsonFile,
      apply,
    });
  }

  const failureCount = Object.values(results).reduce(
    (sum, result) => sum + (result.failures?.length || 0),
    0
  );
  const report = {
    success: failureCount === 0,
    mode: apply ? "apply" : "dry-run",
    encryptionReady: documentStoreEncryptionEnabled(),
    results,
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
