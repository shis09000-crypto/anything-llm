const fs = require("fs");
const path = require("path");
const prisma = require("../prisma");
const authPrisma = require("../authPrisma");
const { managedEnvironmentPath, storagePath } = require("../environment");
const dotenv = require("dotenv");
const { FIELD_SPECS } = require("./mixedKeyDatabaseRecovery");
const {
  activeUserRoot,
  userDomainWrapCoverage,
} = require("./userDomainWrapService");

const RETIREMENT_PROOF_VERSION = "athena-platform-key-retirement-proof:v1";

function normalizedKeyId(keyId) {
  const value = String(keyId || "");
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(value))
    throw new Error("platform_key_id_invalid");
  return value;
}

function envelopeKeyId(value) {
  const parts = String(value || "").split(":");
  return parts[0] === "enc" && parts[1] === "v2" ? parts[2] || null : null;
}

function jsonFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith(".json")) files.push(target);
    }
  };
  visit(root);
  return files;
}

function encryptedPayloads(parsed = null) {
  return [parsed?.encryptedPayload, parsed?.payload?.encryptedPayload].filter(
    (value) => typeof value === "string"
  );
}

function encryptedStrings(value, output = []) {
  if (typeof value === "string") {
    if (value.startsWith("enc:v1:") || value.startsWith("enc:v2:"))
      output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) encryptedStrings(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) encryptedStrings(item, output);
  }
  return output;
}

async function databaseKeyReferences(keyId) {
  const id = normalizedKeyId(keyId);
  const byField = [];
  for (const spec of FIELD_SPECS) {
    const client = spec.database === "auth" ? authPrisma : prisma;
    try {
      const rows = await client.$queryRawUnsafe(`
        SELECT
          SUM(CASE WHEN "${spec.field}" LIKE 'enc:v2:${id}:%' THEN 1 ELSE 0 END) AS "v2",
          SUM(CASE WHEN "${spec.field}" LIKE 'enc:v1:%' THEN 1 ELSE 0 END) AS "v1"
        FROM "${spec.table}"
        WHERE "${spec.field}" LIKE 'enc:v2:${id}:%'
           OR "${spec.field}" LIKE 'enc:v1:%'
      `);
      const versioned = Number(rows?.[0]?.v2 || 0);
      const legacy = Number(rows?.[0]?.v1 || 0);
      byField.push({
        database: spec.database || "main",
        table: spec.table,
        field: spec.field,
        count: versioned + legacy,
        versionedCount: versioned,
        legacyV1Count: legacy,
      });
    } catch (error) {
      byField.push({
        database: spec.database || "main",
        table: spec.table,
        field: spec.field,
        count: 0,
        auditError: error?.message || String(error),
      });
    }
  }
  try {
    const checkpoints = await prisma.security_audit_checkpoints.count({
      where: { keyId: id },
    });
    byField.push({
      database: "main",
      table: "security_audit_checkpoints",
      field: "keyId",
      count: checkpoints,
    });
  } catch (error) {
    byField.push({
      database: "main",
      table: "security_audit_checkpoints",
      field: "keyId",
      count: 0,
      auditError: error?.message || String(error),
    });
  }
  return byField;
}

function fileKeyReferences(keyId) {
  const id = normalizedKeyId(keyId);
  const byStore = [];
  for (const [store, root] of [
    ["document-store", storagePath("documents")],
    ["vector-cache", storagePath("vector-cache")],
  ]) {
    let count = 0;
    let legacyV1Count = 0;
    let auditErrors = 0;
    const files = jsonFiles(root);
    for (const file of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const value of encryptedPayloads(parsed)) {
          if (envelopeKeyId(value) === id) count += 1;
          else if (String(value).startsWith("enc:v1:")) {
            count += 1;
            legacyV1Count += 1;
          }
        }
      } catch {
        auditErrors += 1;
      }
    }
    byStore.push({
      store,
      files: files.length,
      count,
      legacyV1Count,
      auditErrors,
    });
  }
  const providerBackup = storagePath("system", "provider-settings.backup.json");
  let providerCount = 0;
  let providerLegacyV1Count = 0;
  let providerAuditErrors = 0;
  if (fs.existsSync(providerBackup)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(providerBackup, "utf8"));
      for (const value of encryptedStrings(parsed)) {
        if (envelopeKeyId(value) === id) providerCount += 1;
        else if (value.startsWith("enc:v1:")) {
          providerCount += 1;
          providerLegacyV1Count += 1;
        }
      }
    } catch {
      providerAuditErrors += 1;
    }
  }
  byStore.push({
    store: "provider-settings-backup",
    files: fs.existsSync(providerBackup) ? 1 : 0,
    count: providerCount,
    legacyV1Count: providerLegacyV1Count,
    auditErrors: providerAuditErrors,
  });
  const managedEnv = managedEnvironmentPath();
  let managedEnvCount = 0;
  let managedEnvLegacyV1Count = 0;
  let managedEnvAuditErrors = 0;
  if (fs.existsSync(managedEnv)) {
    try {
      const parsed = dotenv.parse(fs.readFileSync(managedEnv, "utf8"));
      for (const value of encryptedStrings(parsed)) {
        if (envelopeKeyId(value) === id) managedEnvCount += 1;
        else if (value.startsWith("enc:v1:")) {
          managedEnvCount += 1;
          managedEnvLegacyV1Count += 1;
        }
      }
    } catch {
      managedEnvAuditErrors += 1;
    }
  }
  byStore.push({
    store: "managed-environment",
    files: fs.existsSync(managedEnv) ? 1 : 0,
    count: managedEnvCount,
    legacyV1Count: managedEnvLegacyV1Count,
    auditErrors: managedEnvAuditErrors,
  });
  return byStore;
}

async function lanceKeyReferences(keyId) {
  const id = normalizedKeyId(keyId);
  const root = storagePath("lancedb");
  if (!fs.existsSync(root))
    return {
      store: "lancedb",
      count: 0,
      legacyV1Count: 0,
      tables: 0,
      auditErrors: 0,
    };
  const lancedb = require("@lancedb/lancedb");
  const client = await lancedb.connect(root);
  let count = 0;
  let legacyV1Count = 0;
  let auditErrors = 0;
  const tableNames = await client.tableNames();
  try {
    for (const tableName of tableNames) {
      const table = await client.openTable(tableName);
      const rowCount = await table.countRows();
      const rows =
        rowCount > 0 ? await table.query().limit(rowCount).toArray() : [];
      for (const row of rows) {
        try {
          const parsed =
            typeof row?.text === "string" ? JSON.parse(row.text) : null;
          for (const value of encryptedPayloads(parsed)) {
            if (envelopeKeyId(value) === id) count += 1;
            else if (String(value).startsWith("enc:v1:")) {
              count += 1;
              legacyV1Count += 1;
            }
          }
        } catch {
          auditErrors += 1;
        }
      }
    }
  } finally {
    await client.close();
  }
  return {
    store: "lancedb",
    count,
    legacyV1Count,
    tables: tableNames.length,
    auditErrors,
  };
}

async function userDomainAdoptionCoverage() {
  if (authPrisma.$authPrismaReady) await authPrisma.$authPrismaReady;
  const users = await prisma.users.findMany({
    where: { status: "active" },
    orderBy: { id: "asc" },
    select: { id: true, authUserId: true },
  });
  const coverage = [];
  for (const user of users) {
    if (!user.authUserId) {
      coverage.push({
        userId: user.id,
        authUserId: null,
        sharedIdentityLinked: false,
        rootInitialized: false,
        total: 0,
        active: 0,
        pending: 0,
        eligible: null,
        missing: null,
        coverage: 0,
      });
      continue;
    }
    const root = await activeUserRoot(user.authUserId);
    coverage.push({
      userId: user.id,
      authUserId: user.authUserId,
      sharedIdentityLinked: true,
      rootInitialized: Boolean(root),
      ...(root
        ? await userDomainWrapCoverage({
            userId: user.id,
            authUserId: user.authUserId,
          })
        : {
            total: 0,
            active: 0,
            pending: 0,
            eligible: null,
            missing: null,
            coverage: 0,
          }),
    });
  }
  return coverage;
}

async function platformKeyRetirementProof(keyId, now = new Date()) {
  const id = normalizedKeyId(keyId);
  const [database, fileStores, lance, users] = await Promise.all([
    databaseKeyReferences(id),
    Promise.resolve(fileKeyReferences(id)),
    lanceKeyReferences(id),
    userDomainAdoptionCoverage(),
  ]);
  const auditErrors =
    database.filter((row) => row.auditError).length +
    fileStores.reduce((total, row) => total + row.auditErrors, 0) +
    lance.auditErrors;
  const platformReferences =
    database.reduce((total, row) => total + row.count, 0) +
    fileStores.reduce((total, row) => total + row.count, 0) +
    lance.count;
  const rootsComplete = users.every((user) => user.rootInitialized);
  const wrapsComplete = users.every(
    (user) =>
      user.rootInitialized &&
      user.pending === 0 &&
      user.missing === 0 &&
      user.coverage === 1
  );
  const retirementAllowed =
    auditErrors === 0 &&
    platformReferences === 0 &&
    rootsComplete &&
    wrapsComplete;
  return {
    version: RETIREMENT_PROOF_VERSION,
    keyId: id,
    generatedAt: now.toISOString(),
    retirementAllowed,
    blockers: {
      auditErrors,
      platformReferences,
      usersWithoutSharedIdentity: users.filter(
        (user) => !user.sharedIdentityLinked
      ).length,
      usersWithoutRoot: users.filter(
        (user) => user.sharedIdentityLinked && !user.rootInitialized
      ).length,
      usersWithIncompleteWrapCoverage: users.filter(
        (user) =>
          user.rootInitialized &&
          (user.pending > 0 || user.missing > 0 || user.coverage !== 1)
      ).length,
    },
    platform: { database, fileStores, lance },
    users,
  };
}

function assertPlatformKeyRetirementProof(proof, keyId, now = new Date()) {
  const id = normalizedKeyId(keyId);
  const generatedAt = Date.parse(proof?.generatedAt || "");
  if (
    proof?.version !== RETIREMENT_PROOF_VERSION ||
    proof?.keyId !== id ||
    proof?.retirementAllowed !== true ||
    !Number.isFinite(generatedAt) ||
    Math.abs(now.getTime() - generatedAt) > 5 * 60 * 1000 ||
    Number(proof?.blockers?.auditErrors) !== 0 ||
    Number(proof?.blockers?.platformReferences) !== 0 ||
    Number(proof?.blockers?.usersWithoutSharedIdentity) !== 0 ||
    Number(proof?.blockers?.usersWithoutRoot) !== 0 ||
    Number(proof?.blockers?.usersWithIncompleteWrapCoverage) !== 0
  )
    throw new Error("platform_key_retirement_migration_incomplete");
  return true;
}

module.exports = {
  RETIREMENT_PROOF_VERSION,
  assertPlatformKeyRetirementProof,
  databaseKeyReferences,
  fileKeyReferences,
  lanceKeyReferences,
  platformKeyRetirementProof,
  userDomainAdoptionCoverage,
};
