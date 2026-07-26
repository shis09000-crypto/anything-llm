#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

const DRILL_EVIDENCE_FORMAT = "athena-key-closure-drill:v1";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function readJson(filePath) {
  if (!filePath) throw new Error("source_evidence_required");
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writePrivateJson(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
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

function check(name, passed, details = null) {
  return { name, passed: passed === true, ...(details ? { details } : {}) };
}

function verifyRecoveredDatabase(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const database = new Database(filePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (
      database.pragma("quick_check")[0]?.quick_check === "ok" &&
      database.pragma("foreign_key_check").length === 0
    );
  } finally {
    database.close();
  }
}

async function agentHeadlessChecks() {
  const {
    decryptSecret,
    encryptSecret,
  } = require("../utils/security/encryption");
  const {
    deriveUserDomainKey,
  } = require("../utils/security/userKeyDerivation");
  const roles = ["agent", "background-worker", "scheduled-job"];
  const roleChecks = roles.map((runtimeRole) => {
    const plaintext = `athena-phase4-${runtimeRole}-${crypto.randomUUID()}`;
    const context = {
      domain: "agent",
      purpose: "phase4-headless-probe",
      resource: crypto.randomUUID(),
      runtimeRole,
    };
    const encrypted = encryptSecret(plaintext, context);
    return check(
      `server-envelope-${runtimeRole}`,
      encrypted.startsWith("enc:v2:") &&
        decryptSecret(encrypted, context) === plaintext
    );
  });
  const root = crypto.randomBytes(32);
  const first = deriveUserDomainKey({
    userRootKey: root,
    authUserId: 1,
    keyEpoch: 1,
    domain: "agent",
  });
  const second = deriveUserDomainKey({
    userRootKey: root,
    authUserId: 1,
    keyEpoch: 1,
    domain: "agent",
  });
  const mlKem = crypto.generateKeyPairSync("ml-kem-768");
  const encapsulated = crypto.encapsulate(mlKem.publicKey);
  const recovered = crypto.decapsulate(
    mlKem.privateKey,
    encapsulated.ciphertext
  );
  return [
    ...roleChecks,
    check(
      "agent-domain-kdf-deterministic",
      first.length === 32 && first.equals(second)
    ),
    check(
      "headless-lattice-kem-round-trip",
      Buffer.from(encapsulated.sharedKey).equals(Buffer.from(recovered))
    ),
  ];
}

async function backupRestoreChecks(source, keyId) {
  const databases = Array.isArray(source?.databases) ? source.databases : [];
  const keyDomains =
    await require("../utils/security/keyRotation").verifyAllKeyDomains();
  return [
    check(
      "drill-executed",
      source?.success === true && source?.mode === "executed"
    ),
    check(
      "all-databases-restored",
      databases.length >= 2 &&
        databases.every(
          (database) =>
            database.quickCheck === "ok" &&
            database.foreignKeyViolationCount === 0 &&
            verifyRecoveredDatabase(database.destinationPath)
        )
    ),
    check(
      "key-custody-recovered",
      source?.keyCustody?.roundTrip === true &&
        source?.keyCustody?.keyId === keyId
    ),
    check("all-encrypted-domains-readable", keyDomains.ok, {
      attempted: keyDomains.attempted,
      verified: keyDomains.verified,
      failureCount: keyDomains.failureCount,
      failures: keyDomains.failures,
    }),
  ];
}

async function deviceRecoveryChecks(source) {
  const {
    userDomainAdoptionCoverage,
  } = require("../utils/security/userDomainRetirementGuard");
  const authPrisma = require("../utils/authPrisma");
  if (authPrisma.$authPrismaReady) await authPrisma.$authPrismaReady;
  const users = await userDomainAdoptionCoverage();
  const rootsComplete =
    users.length > 0 && users.every((user) => user.rootInitialized);
  const wrapsComplete =
    users.length > 0 &&
    users.every(
      (user) =>
        user.rootInitialized &&
        user.pending === 0 &&
        user.missing === 0 &&
        user.coverage === 1
    );
  const deviceState = [];
  for (const user of users) {
    if (!user.sharedIdentityLinked || !user.authUserId) {
      deviceState.push({
        authUserId: null,
        userId: user.userId,
        sharedIdentityLinked: false,
        activeClients: 0,
        unsynchronizedClients: 0,
        recoveryPackages: 0,
      });
      continue;
    }
    const root = await authPrisma.user_root_key_epochs.findFirst({
      where: { authUserId: user.authUserId, status: "active" },
      orderBy: { rootEpoch: "desc" },
    });
    const clients = await authPrisma.athena_clients.findMany({
      where: { userId: user.authUserId, revokedAt: null },
      select: { clientId: true },
    });
    const envelopes = root
      ? await authPrisma.user_root_key_envelopes.findMany({
          where: {
            authUserId: user.authUserId,
            rootEpoch: root.rootEpoch,
            consumedAt: { not: null },
          },
          select: { targetClientId: true },
        })
      : [];
    const synchronized = new Set([
      root?.initializedByClientId,
      ...envelopes.map((envelope) => envelope.targetClientId),
    ]);
    const recoveryPackages = await authPrisma.vault_recovery_packages.count({
      where: { userId: user.authUserId, status: "ready", revokedAt: null },
    });
    deviceState.push({
      authUserId: user.authUserId,
      userId: user.userId,
      sharedIdentityLinked: true,
      activeClients: clients.length,
      unsynchronizedClients: clients.filter(
        (client) => !synchronized.has(client.clientId)
      ).length,
      recoveryPackages,
    });
  }
  const protocolResources = new Set(
    (source?.resources || []).map((resource) => resource.resourceType)
  );
  return [
    check(
      "xwing-device-transport-protocol",
      source?.success === true &&
        source?.compatibility?.xwingTransport === true &&
        ["chat-conversation-key", "content-object", "vault-master-key"].every(
          (resource) => protocolResources.has(resource)
        )
    ),
    check("all-users-root-initialized", rootsComplete, { users }),
    check("all-user-domain-wraps-covered", wrapsComplete, { users }),
    check(
      "all-active-devices-synchronized",
      deviceState.length > 0 &&
        deviceState.every(
          (item) => item.activeClients > 0 && item.unsynchronizedClients === 0
        ),
      { devices: deviceState }
    ),
    check(
      "all-users-have-recovery-package",
      deviceState.length > 0 &&
        deviceState.every((item) => item.recoveryPackages > 0),
      { devices: deviceState }
    ),
  ];
}

async function main() {
  const kind = arg("--kind");
  const keyId = arg("--key-id");
  if (!["agent-headless", "backup-restore", "device-recovery"].includes(kind))
    throw new Error("key_closure_evidence_kind_invalid");
  if (!keyId) throw new Error("key_id_required");
  const runtime = await bootstrapCliRuntime({
    access: "read",
    requiredTables: [
      "users",
      "security_key_registry",
      "user_domain_key_wraps",
      "_prisma_migrations",
    ],
  });
  const prisma = require("../utils/prisma");
  const registry = await prisma.security_key_registry.findUnique({
    where: { keyId },
  });
  if (!registry) throw new Error("key_closure_key_not_registered");
  const descriptor = require("../utils/security/keyCustody").resolveKey(keyId);
  const source = kind === "agent-headless" ? null : readJson(arg("--source"));
  const drillChecks =
    kind === "agent-headless"
      ? await agentHeadlessChecks()
      : kind === "backup-restore"
        ? await backupRestoreChecks(source, keyId)
        : await deviceRecoveryChecks(source);
  const checks = [
    check("closure-key-resolvable", descriptor?.keyId === keyId),
    check(
      "closure-key-decrypt-only",
      registry.status === "decrypt_only" &&
        descriptor?.status === "decrypt_only",
      {
        registryStatus: registry.status,
        custodyStatus: descriptor?.status || null,
      }
    ),
    ...drillChecks,
  ];
  const result = {
    format: DRILL_EVIDENCE_FORMAT,
    kind,
    keyId,
    keyStatus: registry.status,
    providerType: descriptor?.providerType || null,
    success: checks.every((item) => item.passed),
    environment: runtime.appEnv,
    node: process.version,
    checks,
    completedAt: new Date().toISOString(),
  };
  const outputPath = arg("--output");
  if (outputPath) result.outputPath = writePrivateJson(outputPath, result);
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        { success: false, error: error.message, code: error.code || null },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([
      require("../utils/prisma").$disconnect(),
      require("../utils/authPrisma").$disconnect(),
    ]);
  });
