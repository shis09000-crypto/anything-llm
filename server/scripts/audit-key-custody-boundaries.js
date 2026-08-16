#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const serverRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(serverRoot, "..");

const CRYPTO_IMPLEMENTATION_ALLOWLIST = new Set([
  "server/utils/security/encryption.js",
  "server/utils/security/chatHistorySerialEncryption.js",
  "server/utils/security/browserEgressEnvelope.js",
  "server/utils/security/keyLifecycle.js",
  "server/utils/security/keyRotation.js",
  "server/utils/security/mixedKeyDatabaseRecovery.js",
  "server/utils/security/userDomainWrapping.js",
  "server/utils/EncryptionManager/index.js",
  "server/scripts/athena-keyctl.js",
  "server/scripts/recover-document-store-encryption.js",
  "server/scripts/migrate-chat-history-serial-encryption.js",
  "server/scripts/verify-user-domain-wrap-e2e.js",
]);

function isCryptoImplementationAllowed(rel) {
  return (
    rel.startsWith("server/utils/security/keyCustody/") ||
    CRYPTO_IMPLEMENTATION_ALLOWLIST.has(rel)
  );
}

const MASTER_KEY_ACCESS_ALLOWLIST = new Set([
  "server/utils/security/keyCustody/providers.js",
  "server/utils/security/startupValidation.js",
  "server/scripts/migrate-chat-history-serial-encryption.js",
]);

// Market-data credentials may only cross the runtime boundary through the
// encrypted settings writer, boolean settings status, or the dedicated reader.
const MARKET_DATA_SECRET_ACCESS_ALLOWLIST = new Set([
  "server/models/systemSettings.js",
  "server/scripts/audit-key-custody-boundaries.js",
  "server/utils/helpers/updateENV.js",
  "server/utils/agents/aibitat/plugins/market-data/secrets.js",
]);
const MARKET_DATA_SECRET_PATTERN =
  /\b(?:QWEATHER_API_KEY_ENCRYPTED|JUHE_STOCK_API_KEY_ENCRYPTED|JUHE_FOREX_API_KEY_ENCRYPTED)\b/;

function walk(directory, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      ["node_modules", "storage", "public", "__tests__"].includes(entry.name)
    ) {
      continue;
    }
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target, files);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(target);
  }
  return files;
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function findingsFor(file) {
  const rel = relative(file);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const findings = [];
  lines.forEach((line, index) => {
    if (
      /\bcreateCipheriv\s*\(|\bcreateDecipheriv\s*\(/.test(line) &&
      !isCryptoImplementationAllowed(rel)
    ) {
      findings.push({
        type: "crypto_implementation_outside_custody_boundary",
        file: rel,
        line: index + 1,
      });
    }
    if (
      /process\.env(?:\.ENCRYPTION_MASTER_KEY|\[MASTER_KEY_ENV\])/.test(line) &&
      !MASTER_KEY_ACCESS_ALLOWLIST.has(rel)
    ) {
      findings.push({
        type: "direct_master_key_environment_access",
        file: rel,
        line: index + 1,
      });
    }
    if (
      MARKET_DATA_SECRET_PATTERN.test(line) &&
      !MARKET_DATA_SECRET_ACCESS_ALLOWLIST.has(rel)
    ) {
      findings.push({
        type: "market_data_secret_access_outside_allowlist",
        file: rel,
        line: index + 1,
      });
    }
  });
  return findings;
}

const files = walk(serverRoot);
const findings = files.flatMap(findingsFor);
console.log(
  JSON.stringify(
    {
      success: findings.length === 0,
      scannedFiles: files.length,
      findingCount: findings.length,
      findings,
    },
    null,
    2
  )
);
if (findings.length) process.exitCode = 1;
