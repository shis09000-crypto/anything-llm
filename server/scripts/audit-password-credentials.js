#!/usr/bin/env node
const {
  assertDatabaseSchema,
  assertPostgresqlSchema,
  bootstrapCliRuntime,
} = require("./lib/runtimeBootstrap");
const {
  passwordCredentialType,
  passwordHashKind,
} = require("../utils/security/passwordCredential");

function summarize(rows = []) {
  const credentialTypes = {};
  const hashKinds = {};
  let passwordCredentials = 0;
  let argon2idPasswordCredentials = 0;
  let policyMismatches = 0;

  for (const row of rows) {
    const credentialType = passwordCredentialType(row);
    const hashKind = passwordHashKind(row.password);
    credentialTypes[credentialType] =
      (credentialTypes[credentialType] || 0) + 1;
    hashKinds[hashKind] = (hashKinds[hashKind] || 0) + 1;
    if (credentialType === "password") {
      passwordCredentials += 1;
      if (hashKind === "argon2id") argon2idPasswordCredentials += 1;
      if (hashKind === "unknown") policyMismatches += 1;
    }
  }

  return {
    total: rows.length,
    credentialTypes,
    hashKinds,
    passwordCredentials,
    argon2idPasswordCredentials,
    argon2idCoveragePercent: passwordCredentials
      ? Number(
          ((argon2idPasswordCredentials / passwordCredentials) * 100).toFixed(2)
        )
      : 100,
    policyMismatches,
  };
}

async function rowsFor(client) {
  return client.$queryRawUnsafe(
    `SELECT "password", "credentialType" FROM "users" ORDER BY "id" ASC`
  );
}

async function main() {
  const runtime = await bootstrapCliRuntime({
    requiredTables: ["users", "_prisma_migrations"],
  });
  const assertSchema =
    runtime.databaseProvider === "postgresql"
      ? ({ databaseUrl, ...options }) =>
          assertPostgresqlSchema({ databaseUrl, ...options })
      : ({ databasePath, ...options }) =>
          assertDatabaseSchema({ databasePath, ...options });
  await assertSchema({
    ...(runtime.databaseProvider === "postgresql"
      ? { databaseUrl: runtime.authDatabaseUrl }
      : { databasePath: runtime.authDatabasePath }),
    requiredTables: ["users", "_prisma_migrations"],
    label: "auth",
  });

  const prisma = require("../utils/prisma");
  const authPrisma = require("../utils/authPrisma");
  try {
    const [mainRows, authRows] = await Promise.all([
      rowsFor(prisma),
      rowsFor(authPrisma),
    ]);
    const databases = {
      main: summarize(mainRows),
      auth: summarize(authRows),
    };
    const success = Object.values(databases).every(
      (database) => database.policyMismatches === 0
    );
    console.log(JSON.stringify({ success, databases }, null, 2));
    if (!success) process.exitCode = 1;
  } finally {
    await Promise.allSettled([prisma.$disconnect(), authPrisma.$disconnect()]);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        { success: false, error: error.message, code: error.code || null },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}

module.exports = { main, summarize };
