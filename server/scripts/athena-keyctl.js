#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

let keyProvider;
let health;
let keyGovernanceStatus;
let prepareRotation;
let runSecurityPreflight;
let recoverMixedKeyDatabase;
let executeRotationJob;
let verifyAllKeyDomains;
let prisma;

function hasArg(name) {
  return process.argv.includes(name);
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function usage() {
  return `Athena key custody control

Usage:
  node server/scripts/athena-keyctl.js inventory
  node server/scripts/athena-keyctl.js status
  node server/scripts/athena-keyctl.js bootstrap [--apply --execute --env development|production]
  node server/scripts/athena-keyctl.js preflight
  node server/scripts/athena-keyctl.js verify
  node server/scripts/athena-keyctl.js rotate [--apply --execute --env development|production --recovery-bundle <path>]
  node server/scripts/athena-keyctl.js recover --apply --execute --env development|production --recovery-bundle <path>
  node server/scripts/athena-keyctl.js recover-mixed-db --candidate-source <path> [--apply --execute --env development|production --backup <path>]

Rotation and recovery require ATHENA_KEY_RECOVERY_PASSPHRASE. Key material is
never printed. Commands that mutate provider or registry state require --apply.`;
}

function recoveryPassphrase() {
  const value = String(process.env.ATHENA_KEY_RECOVERY_PASSPHRASE || "");
  if (value.length < 16) {
    throw new Error(
      "ATHENA_KEY_RECOVERY_PASSPHRASE must be at least 16 characters."
    );
  }
  return value;
}

function encryptRecoveryBundle(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("athena-key-recovery:v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    format: "athena-key-recovery:v1",
    kdf: "scrypt",
    algorithm: "aes-256-gcm",
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    createdAt: new Date().toISOString(),
  };
}

function decryptRecoveryBundle(bundle, passphrase) {
  if (bundle?.format !== "athena-key-recovery:v1") {
    throw new Error("unsupported_recovery_bundle");
  }
  const key = crypto.scryptSync(
    passphrase,
    Buffer.from(bundle.salt, "base64url"),
    32
  );
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(bundle.iv, "base64url")
  );
  decipher.setAAD(Buffer.from("athena-key-recovery:v1", "utf8"));
  decipher.setAuthTag(Buffer.from(bundle.authTag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(bundle.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  );
}

function writePrivateJson(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
  return target;
}

function safeOutput(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const command = process.argv[2];
  if (!command || ["-h", "--help", "help"].includes(command)) {
    console.log(usage());
    return;
  }
  const requestedApply = hasArg("--apply");
  const execute = hasArg("--execute");
  const apply = requestedApply && execute;
  const writeCommand = [
    "bootstrap",
    "rotate",
    "recover",
    "recover-mixed-db",
  ].includes(command);
  await bootstrapCliRuntime({
    access: writeCommand && apply ? "write" : "read",
    execute: writeCommand && apply,
    requiredTables: ["security_key_registry", "security_key_rotation_jobs"],
  });
  ({ keyProvider, health } = require("../utils/security/keyCustody"));
  ({
    keyGovernanceStatus,
    prepareRotation,
    runSecurityPreflight,
  } = require("../utils/security/keyLifecycle"));
  recoverMixedKeyDatabase =
    require("../utils/security/mixedKeyDatabaseRecovery").recoverMixedKeyDatabase;
  ({
    executeRotationJob,
    verifyAllKeyDomains,
  } = require("../utils/security/keyRotation"));
  prisma = require("../utils/prisma");

  if (command === "inventory") {
    safeOutput({ success: health().ok, provider: health() });
    return;
  }

  if (command === "status") {
    safeOutput({ success: true, ...(await keyGovernanceStatus()) });
    return;
  }

  if (command === "bootstrap") {
    if (!apply) {
      safeOutput({
        success: true,
        mode: "dry-run",
        provider: health(),
        action: health().ok
          ? "would-verify-existing"
          : "would-bootstrap-if-empty",
        requestedApply,
        instruction:
          requestedApply && !execute
            ? "Repeat with explicit APP_ENV or --env plus --execute to mutate."
            : null,
      });
      return;
    }
    const result = await runSecurityPreflight({
      runtimeRole: "keyctl-bootstrap",
      allowGenerate: true,
    });
    safeOutput({
      success: !result.quarantined,
      mode: "apply",
      runtime: result,
    });
    return;
  }

  if (["preflight", "verify"].includes(command)) {
    const result = await runSecurityPreflight({
      runtimeRole: `keyctl-${command}`,
    });
    const fullCoverage =
      command === "verify" ? await verifyAllKeyDomains() : null;
    safeOutput({
      success: !result.quarantined,
      runtime: result,
      ...(fullCoverage ? { fullCoverage } : {}),
    });
    return;
  }

  if (command === "rotate") {
    const bundlePath = arg("--recovery-bundle");
    if (!apply) {
      safeOutput({
        success: true,
        mode: "dry-run",
        provider: health(),
        recoveryBundleRequired: true,
        nextStage: "prepare",
        requestedApply,
        instruction:
          requestedApply && !execute
            ? "Repeat with explicit APP_ENV or --env plus --execute to mutate."
            : null,
      });
      return;
    }
    if (!bundlePath) throw new Error("--recovery-bundle is required.");
    const provider = keyProvider();
    if (typeof provider.exportRecoveryState !== "function") {
      throw new Error("key_provider_does_not_support_local_recovery_export");
    }
    const job = await prepareRotation({
      idempotencyKey:
        arg("--idempotency-key") || `keyctl:${crypto.randomUUID()}`,
      createdBy: null,
    });
    const bundle = encryptRecoveryBundle(
      provider.exportRecoveryState(),
      recoveryPassphrase()
    );
    const written = writePrivateJson(bundlePath, bundle);
    const completed = await executeRotationJob({ jobId: job.jobId });
    safeOutput({
      success: true,
      mode: "apply",
      recoveryBundle: written,
      job: completed,
      note: "Rotation completed; the previous key remains decrypt_only until an explicit retirement review.",
    });
    return;
  }

  if (command === "recover") {
    if (!apply) {
      safeOutput({
        success: true,
        mode: "dry-run",
        action: "recover",
        requestedApply,
        instruction:
          "Repeat with explicit APP_ENV or --env plus --apply --execute to mutate.",
      });
      return;
    }
    const bundlePath = arg("--recovery-bundle");
    if (!bundlePath) throw new Error("--recovery-bundle is required.");
    const provider = keyProvider();
    if (typeof provider.restoreRecoveryState !== "function") {
      throw new Error("key_provider_does_not_support_local_recovery");
    }
    const bundle = JSON.parse(
      fs.readFileSync(path.resolve(bundlePath), "utf8")
    );
    const state = decryptRecoveryBundle(bundle, recoveryPassphrase());
    provider.restoreRecoveryState(state);
    const result = await runSecurityPreflight({
      runtimeRole: "keyctl-recover",
    });
    safeOutput({ success: true, recovered: true, runtime: result });
    return;
  }

  if (command === "recover-mixed-db") {
    const candidateSource = arg("--candidate-source");
    if (!candidateSource) throw new Error("--candidate-source is required.");
    const report = await recoverMixedKeyDatabase({
      candidateSource,
      apply,
      backupPath: arg("--backup"),
    });
    safeOutput(report);
    if (!report.success) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
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
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect?.().catch(() => null);
  });
