#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = path.resolve(ROOT, "..");
const SOURCE_ROOTS = [
  path.join(ROOT, "utils"),
  path.join(ROOT, "endpoints"),
  path.join(WORKSPACE, "frontend", "src"),
  path.join(WORKSPACE, "ios", "Athena", "Athena"),
];
const EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".swift"]);
const REGISTRY_FILES = new Set([
  path.join(ROOT, "utils", "security", "cryptoSuiteRegistry.js"),
  path.join(
    WORKSPACE,
    "frontend",
    "src",
    "lib",
    "communication",
    "cryptoSuiteRegistry.js"
  ),
  path.join(
    WORKSPACE,
    "ios",
    "Athena",
    "Athena",
    "Core",
    "Security",
    "CryptoSuiteRegistry.swift"
  ),
]);
const SUITE_LITERALS = [
  "v2-device-p256",
  "p256-software-v1",
  "p256-secure-enclave-v1",
  "audit-ed25519-v1",
  "release-evidence-ed25519-v1",
];

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "generated", "node_modules"].includes(entry.name)) {
        return [];
      }
      return sourceFiles(absolute);
    }
    return EXTENSIONS.has(path.extname(entry.name)) ? [absolute] : [];
  });
}

function relative(file) {
  return path.relative(WORKSPACE, file);
}

function main() {
  const findings = [];
  const files = SOURCE_ROOTS.flatMap(sourceFiles);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    if (!REGISTRY_FILES.has(file)) {
      for (const literal of SUITE_LITERALS) {
        if (
          source.includes(`"${literal}"`) ||
          source.includes(`'${literal}'`)
        ) {
          findings.push({
            file: relative(file),
            code: "crypto_suite_literal_outside_registry",
            suiteId: literal,
          });
        }
      }
    }

    const isLegacyAlgorithmBoundary = [
      path.join(ROOT, "utils", "security", "auditLedger.js"),
      path.join(ROOT, "utils", "security", "releaseEvidence.js"),
    ].includes(file);
    if (isLegacyAlgorithmBoundary && /["']ed25519["']/i.test(source)) {
      findings.push({
        file: relative(file),
        code: "legacy_algorithm_literal_outside_registry",
      });
    }

    for (const match of source.matchAll(/\b(?:JWT|jwt)\.verify\s*\(/g)) {
      const callWindow = source.slice(match.index, match.index + 500);
      if (!/\balgorithms\s*:/.test(callWindow)) {
        findings.push({
          file: relative(file),
          code: "jwt_verify_missing_algorithm_allowlist",
        });
      }
    }
  }

  const report = {
    valid: findings.length === 0,
    scannedFiles: files.length,
    findings,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) process.exitCode = 1;
}

main();
