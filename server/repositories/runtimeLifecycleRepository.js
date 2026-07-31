const prisma = require("../utils/prisma");
const authPrisma = require("../utils/authPrisma");

const RuntimeLifecycleRepository = {
  dataDomain: "runtime-lifecycle",
  repositoryName: "RuntimeLifecycleRepository",

  async databaseReadiness() {
    await Promise.all([
      prisma.$prismaReady || Promise.resolve(true),
      authPrisma.$authPrismaReady || Promise.resolve(true),
    ]);
    await Promise.all([
      prisma.$queryRawUnsafe("SELECT 1 AS healthy"),
      authPrisma.$queryRawUnsafe("SELECT 1 AS healthy"),
    ]);
    let ownership = null;
    if (
      prisma.$databaseProvider === "postgresql" &&
      process.env.ATHENA_MODULE_SCHEMA_CUTOVER === "true"
    ) {
      const {
        verifyClientOwnership,
      } = require("../utils/database/moduleSchemaOwnership");
      const role = process.env.ATHENA_RUNTIME_ROLE || "api";
      ownership = await Promise.all([
        verifyClientOwnership(prisma, { database: "main", role }),
        verifyClientOwnership(authPrisma, { database: "auth", role }),
      ]);
    }
    return {
      ready: true,
      mainProvider: prisma.$databaseProvider || "sqlite",
      authProvider: authPrisma.$databaseProvider || "sqlite",
      ownership,
    };
  },

  async disconnectDatabases() {
    const results = await Promise.allSettled([
      prisma.$disconnect(),
      authPrisma.$disconnect(),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      const error = new Error(
        `Failed to disconnect ${failures.length} database client(s).`
      );
      error.causes = failures.map((failure) => failure.reason);
      throw error;
    }
    return { disconnected: true };
  },
};

module.exports = { RuntimeLifecycleRepository };
