const path = require("path");
const fs = require("fs");
const { databasePath } = require("../environment");
const {
  databaseProvider,
  mainPostgresqlUrl,
} = require("../database/databaseProvider");
const {
  installMigrationWriteBarrier,
  installRawSqlDialectAdapter,
} = require("../database/sqlDialect");

// npx prisma introspect
// npx prisma generate
// npx prisma migrate dev --name init -> ensures that db is in sync with schema
// npx prisma migrate reset -> resets the db

const logLevels = ["error", "info", "warn"]; // add "query" to debug query logs

function sqliteDatasourceUrl() {
  const dbPath = databasePath();
  const storageDir = path.dirname(dbPath);
  const readOnlyCli = process.env.ATHENA_CLI_DATABASE_ACCESS === "read";
  if (!readOnlyCli) fs.mkdirSync(storageDir, { recursive: true });
  const url = new URL(`file:${dbPath}`);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  if (readOnlyCli) url.searchParams.set("mode", "ro");
  return url.toString();
}

const provider = databaseProvider();
const { PrismaClient } =
  provider === "postgresql"
    ? require("../../generated/postgresql-main")
    : require("@prisma/client");

const datasourceUrl =
  provider === "postgresql" ? mainPostgresqlUrl() : sqliteDatasourceUrl();

const prisma = new PrismaClient({
  log: logLevels,
  datasources: {
    db: {
      url: datasourceUrl,
    },
  },
});
installRawSqlDialectAdapter(prisma);
installMigrationWriteBarrier(prisma);

const isJestRuntime = Boolean(process.env.JEST_WORKER_ID);

const prismaReady =
  process.env.NODE_ENV !== "test" && !isJestRuntime
    ? (async () => {
        if (provider === "postgresql") {
          await prisma.$queryRaw`SELECT 1`;
          return true;
        }
        if (process.env.ATHENA_CLI_DATABASE_ACCESS === "read") {
          await prisma.$queryRaw`SELECT 1`;
          return true;
        }
        await prisma.$queryRaw`PRAGMA journal_mode = WAL`;
        await prisma.$queryRaw`PRAGMA synchronous = NORMAL`;
        await prisma.$queryRaw`PRAGMA busy_timeout = 5000`;
        return true;
      })()
    : Promise.resolve(true);

prismaReady.catch((error) => {
  console.error(`[Prisma] ${provider} startup check failed:`, error.message);
  if (process.env.NODE_ENV === "production") process.exitCode = 1;
});

prisma.$prismaReady = prismaReady;
prisma.$databaseProvider = provider;

module.exports = prisma;
