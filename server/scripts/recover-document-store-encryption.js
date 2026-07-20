#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

let getMasterKey;
let storagePath;

const ENVELOPE_VERSION = "athena-document-store:v1";
const ENVELOPE_ALGORITHM = "AES-GCM-256";
const SECRET_PREFIX = "enc:v1:";
const AES_ALGORITHM = "aes-256-gcm";
const KEY_PATTERN = /\b[a-fA-F0-9]{64}\b/g;

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function usage() {
  return [
    "Usage:",
    "  node server/scripts/recover-document-store-encryption.js --candidate-source <audit.jsonl> [--apply --execute --env development]",
    "",
    "The script discovers 64-character hex key candidates without printing them,",
    "verifies every encrypted document/vector-cache payload, creates a backup,",
    "and re-encrypts recoverable payloads with the current ENCRYPTION_MASTER_KEY.",
    "Dry-run is the default.",
  ].join("\n");
}

function fingerprint(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function jsonFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...jsonFiles(filePath));
    else if (entry.isFile() && entry.name.endsWith(".json"))
      files.push(filePath);
  }
  return files.sort();
}

function encryptedEnvelope(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (
    parsed?.cryptoVersion !== ENVELOPE_VERSION ||
    parsed?.algorithm !== ENVELOPE_ALGORITHM ||
    typeof parsed?.encryptedPayload !== "string" ||
    !parsed.encryptedPayload.startsWith(SECRET_PREFIX)
  ) {
    return null;
  }
  return parsed;
}

function decryptSecretWithKey(value, key) {
  const parts = String(value).split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}:` !== SECRET_PREFIX) {
    throw new Error("unsupported_encrypted_secret_format");
  }
  const decipher = crypto.createDecipheriv(
    AES_ALGORITHM,
    key,
    Buffer.from(parts[2], "base64url")
  );
  decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[4], "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function encryptSecretWithKey(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv);
  const cipherText = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  return [
    SECRET_PREFIX.slice(0, -1),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    cipherText.toString("base64url"),
  ].join(":");
}

function decryptEnvelope(envelope, key, expectedDomain) {
  const decrypted = JSON.parse(
    decryptSecretWithKey(envelope.encryptedPayload, key)
  );
  if (decrypted?.domain !== expectedDomain) {
    throw new Error("document_store_domain_mismatch");
  }
  return decrypted;
}

function encryptEnvelope(decrypted, key) {
  return {
    cryptoVersion: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    encryptedPayload: encryptSecretWithKey(JSON.stringify(decrypted), key),
  };
}

async function candidateKeys(sourceFile) {
  const candidates = new Map();
  const input = fs.createReadStream(sourceFile);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    for (const value of line.match(KEY_PATTERN) || []) {
      const normalized = value.toLowerCase();
      if (!candidates.has(normalized)) {
        candidates.set(normalized, Buffer.from(normalized, "hex"));
      }
    }
  }
  return candidates;
}

function expectedDomain(filePath) {
  if (filePath.startsWith(`${storagePath("documents")}${path.sep}`))
    return "source-document";
  if (filePath.startsWith(`${storagePath("vector-cache")}${path.sep}`))
    return "vector-cache";
  throw new Error("unsupported_document_store_path");
}

function matchingKey(envelope, domain, candidates) {
  for (const [keyHex, key] of candidates.entries()) {
    try {
      const decrypted = decryptEnvelope(envelope, key, domain);
      return { keyHex, key, decrypted };
    } catch {}
  }
  return null;
}

function backupRoot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return storagePath("backups", `document-store-key-recovery-${stamp}`);
}

function backupFile(filePath, targetRoot) {
  const root = storagePath();
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..")) {
    throw new Error("document_store_backup_path_escape");
  }
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(filePath, target);
  return target;
}

function writeEnvelopeAtomic(filePath, envelope) {
  const stat = fs.statSync(filePath);
  const temporary = `${filePath}.recovery-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, JSON.stringify(envelope), {
    encoding: "utf8",
    mode: stat.mode,
  });
  fs.renameSync(temporary, filePath);
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }

  const requestedApply = hasArg("--apply");
  const execute = hasArg("--execute");
  const apply = requestedApply && execute;
  await bootstrapCliRuntime({
    access: apply ? "write" : "read",
    execute,
    requiredTables: ["users", "_prisma_migrations"],
  });
  ({ storagePath } = require("../utils/environment"));
  ({ getMasterKey } = require("../utils/security/keyManager"));
  const sourceFile = argValue("--candidate-source");
  if (!sourceFile) throw new Error("--candidate-source is required");
  const resolvedSource = path.resolve(sourceFile);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error("candidate_source_not_found");
  }

  const currentKey = getMasterKey();
  const currentKeyHex = currentKey.toString("hex");
  const candidates = await candidateKeys(resolvedSource);
  candidates.delete(currentKeyHex);

  const files = [
    ...jsonFiles(storagePath("documents")),
    ...jsonFiles(storagePath("vector-cache")),
  ];
  const plan = [];
  const failures = [];
  let alreadyCurrent = 0;
  let plaintext = 0;

  for (const filePath of files) {
    try {
      const envelope = encryptedEnvelope(filePath);
      if (!envelope) {
        plaintext += 1;
        continue;
      }
      const domain = expectedDomain(filePath);
      try {
        decryptEnvelope(envelope, currentKey, domain);
        alreadyCurrent += 1;
        continue;
      } catch {}

      const match = matchingKey(envelope, domain, candidates);
      if (!match) {
        failures.push({
          resourceFingerprint: fingerprint(filePath),
          error: "no_candidate_key_can_decrypt",
        });
        continue;
      }
      plan.push({
        filePath,
        domain,
        decrypted: match.decrypted,
        sourceKeyFingerprint: fingerprint(match.keyHex),
      });
    } catch (error) {
      failures.push({
        resourceFingerprint: fingerprint(filePath),
        error: error?.message || String(error),
      });
    }
  }

  if (failures.length) {
    console.log(
      JSON.stringify(
        {
          success: false,
          mode: apply ? "apply" : "dry-run",
          scanned: files.length,
          candidateCount: candidates.size,
          alreadyCurrent,
          recoverable: plan.length,
          plaintext,
          failures,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  let backup = null;
  if (apply && plan.length) {
    backup = backupRoot();
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const item of plan) backupFile(item.filePath, backup);
    for (const item of plan) {
      writeEnvelopeAtomic(
        item.filePath,
        encryptEnvelope(item.decrypted, currentKey)
      );
    }
  }

  const sourceKeyFingerprints = [
    ...new Set(plan.map((item) => item.sourceKeyFingerprint)),
  ];
  console.log(
    JSON.stringify(
      {
        success: true,
        mode: apply ? "apply" : "dry-run",
        scanned: files.length,
        candidateCount: candidates.size,
        alreadyCurrent,
        recoverable: plan.length,
        plaintext,
        rotated: apply ? plan.length : 0,
        sourceKeyFingerprints,
        targetKeyFingerprint: fingerprint(currentKeyHex),
        backup,
        ...(requestedApply && !execute
          ? {
              instruction:
                "Apply requires --apply --execute and APP_ENV or --env.",
            }
          : {}),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
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
});
