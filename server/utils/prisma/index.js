const path = require("path");
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");
const { databasePath } = require("../environment");

// npx prisma introspect
// npx prisma generate
// npx prisma migrate dev --name init -> ensures that db is in sync with schema
// npx prisma migrate reset -> resets the db

const logLevels = ["error", "info", "warn"]; // add "query" to debug query logs

function sqliteDatasourceUrl() {
  const dbPath = databasePath();
  const storageDir = path.dirname(dbPath);
  fs.mkdirSync(storageDir, { recursive: true });
  const url = new URL(`file:${dbPath}`);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  return url.toString();
}

const prisma = new PrismaClient({
  log: logLevels,
  datasources: {
    db: {
      url: sqliteDatasourceUrl(),
    },
  },
});

const isJestRuntime = Boolean(process.env.JEST_WORKER_ID);

if (process.env.NODE_ENV !== "test" && !isJestRuntime) {
  (async () => {
    await prisma.$queryRaw`PRAGMA journal_mode = WAL`;
    await prisma.$queryRaw`PRAGMA synchronous = NORMAL`;
    await prisma.$queryRaw`PRAGMA busy_timeout = 5000`;
  })().catch((error) =>
    console.warn("[Prisma] Failed to apply SQLite pragmas:", error.message)
  );
}

module.exports = prisma;
