const {
  assertDatabaseSchema,
  assertPostgresqlSchema,
  bootstrapCliRuntime,
} = require("./lib/runtimeBootstrap");

async function auditDatabase(name, client, provider = "sqlite") {
  if (client.$authPrismaReady) await client.$authPrismaReady;
  if (provider === "postgresql") {
    await client.$queryRawUnsafe("SELECT 1 AS healthy");
    const unvalidatedForeignKeys = await client.$queryRawUnsafe(`
      SELECT conname AS constraint_name
      FROM pg_constraint
      WHERE contype = 'f'
        AND connamespace = current_schema()::regnamespace
        AND NOT convalidated
    `);
    if (unvalidatedForeignKeys.length) {
      const error = new Error(`${name} database integrity audit failed.`);
      error.details = {
        provider,
        unvalidatedForeignKeys: unvalidatedForeignKeys.length,
      };
      throw error;
    }
    return {
      name,
      provider,
      quickCheck: "reachable",
      foreignKeyViolationCount: 0,
      constraints: "validated",
    };
  }

  const quickCheck = await client.$queryRawUnsafe("PRAGMA quick_check");
  const foreignKeys = await client.$queryRawUnsafe("PRAGMA foreign_key_check");
  const quickCheckOk =
    Array.isArray(quickCheck) &&
    quickCheck.length === 1 &&
    String(Object.values(quickCheck[0] || {})[0] || "").toLowerCase() === "ok";
  if (!quickCheckOk || foreignKeys.length > 0) {
    const error = new Error(`${name} database integrity audit failed.`);
    error.details = {
      quickCheck,
      foreignKeyViolationCount: foreignKeys.length,
    };
    throw error;
  }
  return { name, provider, quickCheck: "ok", foreignKeyViolationCount: 0 };
}

async function main() {
  const runtime = await bootstrapCliRuntime({
    requiredTables: ["users", "_prisma_migrations"],
  });
  if (runtime.databaseProvider === "postgresql") {
    await assertPostgresqlSchema({
      databaseUrl: runtime.authDatabaseUrl,
      requiredTables: ["users", "auth_sessions", "_prisma_migrations"],
      label: "auth",
    });
  } else {
    await assertDatabaseSchema({
      databasePath: runtime.authDatabasePath,
      requiredTables: ["users", "auth_sessions", "_prisma_migrations"],
      label: "auth",
    });
  }
  const prisma = require("../utils/prisma");
  const authPrisma = require("../utils/authPrisma");
  const results = [];
  try {
    results.push(await auditDatabase("main", prisma, runtime.databaseProvider));
    results.push(
      await auditDatabase("auth", authPrisma, runtime.databaseProvider)
    );
    console.log(JSON.stringify({ success: true, databases: results }, null, 2));
  } finally {
    await Promise.allSettled([prisma.$disconnect(), authPrisma.$disconnect()]);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: error.message,
          details: error.details || null,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}

module.exports = { auditDatabase, main };
