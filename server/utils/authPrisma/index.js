const { authDatabaseUrl } = require("../environment");
const {
  authPostgresqlUrl,
  databaseProvider,
} = require("../database/databaseProvider");
const {
  installMigrationWriteBarrier,
  installRawSqlDialectAdapter,
} = require("../database/sqlDialect");

const logLevels = ["error", "info", "warn"];

function singleConnectionUrl(value) {
  const raw = String(value || "");
  if (!raw.startsWith("file:")) return raw;
  const url = new URL(raw);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  if (process.env.ATHENA_CLI_DATABASE_ACCESS === "read")
    url.searchParams.set("mode", "ro");
  return url.toString();
}

const provider = databaseProvider();
const { PrismaClient } =
  provider === "postgresql"
    ? require("../../generated/postgresql-auth")
    : require("@prisma/client");

const datasourceUrl =
  provider === "postgresql"
    ? authPostgresqlUrl()
    : singleConnectionUrl(authDatabaseUrl());

const authPrisma = new PrismaClient({
  log: logLevels,
  datasources: {
    db: {
      url: datasourceUrl,
    },
  },
});
installRawSqlDialectAdapter(authPrisma);
installMigrationWriteBarrier(authPrisma);

const isJestRuntime = Boolean(process.env.JEST_WORKER_ID);

const authPrismaReady =
  process.env.NODE_ENV !== "test" && !isJestRuntime
    ? (async () => {
        if (provider === "postgresql") {
          await authPrisma.$queryRaw`SELECT 1`;
          return true;
        }
        if (process.env.ATHENA_CLI_DATABASE_ACCESS === "read") {
          await authPrisma.$queryRaw`SELECT 1`;
          return true;
        }
        await authPrisma.$queryRaw`PRAGMA journal_mode = WAL`;
        await authPrisma.$queryRaw`PRAGMA synchronous = NORMAL`;
        await authPrisma.$queryRaw`PRAGMA foreign_keys = ON`;
        await authPrisma.$queryRaw`PRAGMA busy_timeout = 10000`;
        const violations = await authPrisma.$queryRawUnsafe(
          "PRAGMA foreign_key_check"
        );
        if (violations.length > 0) {
          const error = new Error(
            `Auth DB foreign_key_check found ${violations.length} violation(s).`
          );
          error.code = "AUTH_DB_FOREIGN_KEY_VIOLATION";
          throw error;
        }
        return true;
      })()
    : Promise.resolve(true);

authPrismaReady.catch((error) => {
  console.error("[AuthPrisma] Startup integrity check failed:", error.message);
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ATHENA_AUTH_INTEGRITY_REPAIR_MODE !== "true"
  )
    process.exitCode = 1;
});

authPrisma.$authPrismaReady = authPrismaReady;
authPrisma.$databaseProvider = provider;

module.exports = authPrisma;
