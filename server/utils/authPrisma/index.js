const { PrismaClient } = require("@prisma/client");
const { authDatabaseUrl } = require("../environment");

const logLevels = ["error", "info", "warn"];

const authPrisma = new PrismaClient({
  log: logLevels,
  datasources: {
    db: {
      url: authDatabaseUrl(),
    },
  },
});

const isJestRuntime = Boolean(process.env.JEST_WORKER_ID);

if (process.env.NODE_ENV !== "test" && !isJestRuntime) {
  (async () => {
    await authPrisma.$queryRaw`PRAGMA journal_mode = WAL`;
    await authPrisma.$queryRaw`PRAGMA synchronous = NORMAL`;
    await authPrisma.$queryRaw`PRAGMA busy_timeout = 5000`;
  })().catch((error) =>
    console.warn("[AuthPrisma] Failed to apply SQLite pragmas:", error.message)
  );
}

module.exports = authPrisma;
