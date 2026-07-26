#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

async function main() {
  await bootstrapCliRuntime({
    requiredTables: [
      "users",
      "user_domain_key_wraps",
      "user_domain_migration_jobs",
      "_prisma_migrations",
    ],
  });
  const {
    platformKeyRetirementProof,
    userDomainAdoptionCoverage,
  } = require("../utils/security/userDomainRetirementGuard");
  const keyId = argValue("--key-id");
  const result = keyId
    ? await platformKeyRetirementProof(keyId)
    : {
        version: "athena-user-domain-coverage-audit:v1",
        generatedAt: new Date().toISOString(),
        users: await userDomainAdoptionCoverage(),
      };
  console.log(JSON.stringify({ success: true, ...result }, null, 2));
}

if (require.main === module) {
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
      const prisma = require("../utils/prisma");
      const authPrisma = require("../utils/authPrisma");
      await Promise.allSettled([
        prisma.$disconnect(),
        authPrisma.$disconnect(),
      ]);
    });
}
