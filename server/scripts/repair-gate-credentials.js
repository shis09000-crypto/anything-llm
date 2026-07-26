#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");
let runtimeInitialized = false;

function hasArg(name) {
  return process.argv.includes(name);
}

function usage() {
  return `Repair Athena Gate credentials without exposing secrets

Usage:
  node scripts/repair-gate-credentials.js
  node scripts/repair-gate-credentials.js --apply --execute --env <environment>

The applied command requires an interactive TTY. Credentials are entered with
hidden input, encrypted as enc:v2, written to the managed environment and
provider backup with private permissions, and verified before success.`;
}

function publicStatus(status = {}) {
  return {
    enabled: status.enabled === true,
    environment: status.env || null,
    readOnly: status.readOnly === true,
    hasApiKey: status.hasApiKey === true,
    hasApiSecret: status.hasApiSecret === true,
    configError: status.configError || status.error || null,
  };
}

function promptHidden(message) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY || !stdout.isTTY) {
      reject(new Error("gate_credential_repair_requires_interactive_tty"));
      return;
    }
    let value = "";
    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };
    const onData = (buffer) => {
      const input = buffer
        .toString("utf8")
        .replaceAll("\u001b[200~", "")
        .replaceAll("\u001b[201~", "");
      for (const character of input) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("gate_credential_repair_cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    stdout.write(message);
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
  });
}

function snapshotFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false };
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    content: fs.readFileSync(filePath),
    mode: stat.mode & 0o777,
  };
}

function atomicWrite(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode);
}

function restoreFile(filePath, snapshot) {
  if (snapshot.exists) {
    atomicWrite(filePath, snapshot.content, snapshot.mode || 0o600);
    return;
  }
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }
  const apply = hasArg("--apply") && hasArg("--execute");
  const runtime = await bootstrapCliRuntime({
    access: apply ? "write" : "read",
    execute: apply,
    requiredTables: ["security_key_registry", "_prisma_migrations"],
  });
  runtimeInitialized = true;
  const prisma = require("../utils/prisma");
  const authPrisma = require("../utils/authPrisma");
  await Promise.all([prisma.$prismaReady, authPrisma.$authPrismaReady]);
  const { getGateConfigStatus } = require("../utils/cryptoGate");
  const current = publicStatus(getGateConfigStatus());
  if (!apply) {
    console.log(
      JSON.stringify(
        {
          success: true,
          mode: "dry-run",
          environment: runtime.appEnv,
          current,
          instruction:
            "Repeat with --apply --execute and an explicit --env in a local interactive terminal.",
        },
        null,
        2
      )
    );
    return;
  }

  const apiKey = (await promptHidden("Gate read-only API key: ")).trim();
  const apiSecret = (await promptHidden("Gate read-only API secret: ")).trim();
  if (apiKey.length < 8 || apiSecret.length < 16) {
    const error = new Error("gate_credentials_invalid");
    error.details = {
      apiKeyCharacters: [...apiKey].length,
      apiSecretCharacters: [...apiSecret].length,
      minimumApiKeyCharacters: 8,
      minimumApiSecretCharacters: 16,
    };
    throw error;
  }

  const envPath = runtime.envPath;
  const providerBackupPath = path.join(
    runtime.storageRoot,
    "system",
    "provider-settings.backup.json"
  );
  const snapshots = {
    env: snapshotFile(envPath),
    providerBackup: snapshotFile(providerBackupPath),
  };
  const previousProcessValues = {
    key: process.env.GATE_API_KEY_ENCRYPTED,
    secret: process.env.GATE_API_SECRET_ENCRYPTED,
  };

  try {
    const { encryptSecret } = require("../utils/security/encryption");
    process.env.GATE_API_KEY_ENCRYPTED = encryptSecret(apiKey, {
      domain: "crypto-gate",
      purpose: "crypto-gate-api-key",
      operation: "repair-gate-credentials",
    });
    process.env.GATE_API_SECRET_ENCRYPTED = encryptSecret(apiSecret, {
      domain: "crypto-gate",
      purpose: "crypto-gate-api-secret",
      operation: "repair-gate-credentials",
    });
    delete process.env.GATE_API_KEY;
    delete process.env.GATE_API_SECRET;

    const {
      dumpENV,
      persistProviderSettingsBackup,
    } = require("../utils/helpers/updateENV");
    const backup = persistProviderSettingsBackup();
    if (!backup?.success) throw new Error("provider_backup_write_failed");
    if (dumpENV() !== true) throw new Error("managed_env_write_failed");

    const status = publicStatus(getGateConfigStatus());
    const domains =
      await require("../utils/security/keyRotation").verifyAllKeyDomains();
    if (
      !status.hasApiKey ||
      !status.hasApiSecret ||
      status.configError ||
      !domains.ok
    ) {
      const error = new Error("gate_credential_repair_verification_failed");
      error.details = {
        status,
        fullCoverageFailureCount: domains.failureCount,
      };
      throw error;
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          mode: "applied",
          environment: runtime.appEnv,
          envelopeVersion: "enc:v2",
          status,
          fullCoverage: {
            ok: domains.ok,
            attempted: domains.attempted,
            verified: domains.verified,
            failureCount: domains.failureCount,
          },
          restartRequired: true,
        },
        null,
        2
      )
    );
  } catch (error) {
    restoreFile(envPath, snapshots.env);
    restoreFile(providerBackupPath, snapshots.providerBackup);
    if (previousProcessValues.key === undefined)
      delete process.env.GATE_API_KEY_ENCRYPTED;
    else process.env.GATE_API_KEY_ENCRYPTED = previousProcessValues.key;
    if (previousProcessValues.secret === undefined)
      delete process.env.GATE_API_SECRET_ENCRYPTED;
    else process.env.GATE_API_SECRET_ENCRYPTED = previousProcessValues.secret;
    throw error;
  }
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: error.message,
          code: error.code || null,
          details: error.details || null,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!runtimeInitialized) return;
    await Promise.allSettled([
      require("../utils/prisma").$disconnect(),
      require("../utils/authPrisma").$disconnect(),
    ]);
  });
