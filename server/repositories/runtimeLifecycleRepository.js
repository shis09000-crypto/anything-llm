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
    return {
      ready: true,
      mainProvider: prisma.$databaseProvider || "sqlite",
      authProvider: authPrisma.$databaseProvider || "sqlite",
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
