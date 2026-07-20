const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
  authPostgresqlUrl,
  databaseProvider,
  mainPostgresqlUrl,
  migrationPostgresqlUrl,
} = require("../../utils/database/databaseProvider");

const VALID_ENVIRONMENTS = new Set(["development", "production"]);
const STORAGE_APPLIED_ENV = "ANYTHINGLLM_ENV_STORAGE_APPLIED";
const STORAGE_BASE_ENV = "ANYTHINGLLM_STORAGE_BASE_DIR";

class ScriptRuntimeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ScriptRuntimeError";
    this.code = code;
    this.details = details;
  }
}

function normalizedEnvironment(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (!VALID_ENVIRONMENTS.has(normalized)) {
    throw new ScriptRuntimeError(
      "script_environment_invalid",
      `${label} must be development or production.`
    );
  }
  return normalized;
}

function environmentArgument(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value.startsWith("--env=")) return value.slice("--env=".length);
    if (value === "--env") return argv[index + 1] || null;
  }
  return null;
}

function stripRuntimeArguments(argv = []) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value === "--execute") continue;
    if (value.startsWith("--env=")) continue;
    if (value === "--env") {
      index += 1;
      continue;
    }
    result.push(argv[index]);
  }
  return result;
}

function loadEnvironmentFile(env, envPath) {
  if (!fs.existsSync(envPath)) {
    throw new ScriptRuntimeError(
      "script_environment_file_missing",
      `Runtime environment file does not exist: ${envPath}`
    );
  }
  const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveStorage({ env, appEnv, serverRoot }) {
  const configured = path.resolve(
    env.STORAGE_DIR || path.join(serverRoot, "storage")
  );
  const configuredEnvironment = VALID_ENVIRONMENTS.has(
    path.basename(configured)
  )
    ? path.basename(configured)
    : null;
  if (configuredEnvironment && configuredEnvironment !== appEnv) {
    throw new ScriptRuntimeError(
      "script_storage_environment_conflict",
      `STORAGE_DIR selects ${configuredEnvironment} while APP_ENV selects ${appEnv}.`
    );
  }
  const configuredIsEnvironmentRoot = path.basename(configured) === appEnv;
  const storageBase = configuredIsEnvironmentRoot
    ? path.dirname(configured)
    : configured;
  const storageRoot = configuredIsEnvironmentRoot
    ? configured
    : path.join(storageBase, appEnv);

  if (
    path.basename(storageRoot) === appEnv &&
    path.basename(path.dirname(storageRoot)) === appEnv
  ) {
    throw new ScriptRuntimeError(
      "script_storage_environment_duplicated",
      `Refusing duplicated environment storage path: ${storageRoot}`
    );
  }
  if (!isWithin(storageBase, storageRoot)) {
    throw new ScriptRuntimeError(
      "script_storage_outside_base",
      `Runtime storage path is outside its configured base: ${storageRoot}`
    );
  }
  return { storageBase, storageRoot };
}

function fileDatabasePath(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (url.protocol !== "file:") return null;
    return path.resolve(decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
}

function resolveRuntimeConfiguration({
  env = process.env,
  argv = process.argv.slice(2),
  serverRoot = path.resolve(__dirname, "../.."),
  loadEnv = true,
} = {}) {
  const cliEnvironment = normalizedEnvironment(
    environmentArgument(argv),
    "--env"
  );
  const appEnvironment = normalizedEnvironment(env.APP_ENV, "APP_ENV");
  const nodeEnvironment = ["development", "production"].includes(
    String(env.NODE_ENV || "").toLowerCase()
  )
    ? normalizedEnvironment(env.NODE_ENV, "NODE_ENV")
    : null;

  const declared = [cliEnvironment, appEnvironment, nodeEnvironment].filter(
    Boolean
  );
  if (new Set(declared).size > 1) {
    throw new ScriptRuntimeError(
      "script_environment_conflict",
      "APP_ENV, NODE_ENV, and --env select different runtime environments."
    );
  }

  const appEnv =
    cliEnvironment || appEnvironment || nodeEnvironment || "development";
  const environmentExplicit = Boolean(cliEnvironment || appEnvironment);
  env.APP_ENV = appEnv;
  env.NODE_ENV = appEnv;

  const configuredEnvPath =
    appEnv === "development"
      ? ".env.development"
      : env.DESKTOP_ENV_PATH || ".env";
  const envPath = path.isAbsolute(configuredEnvPath)
    ? configuredEnvPath
    : path.join(serverRoot, configuredEnvPath);
  if (loadEnv) loadEnvironmentFile(env, envPath);

  // Runtime identity remains authoritative even if an env file contains stale
  // APP_ENV/NODE_ENV values.
  env.APP_ENV = appEnv;
  env.NODE_ENV = appEnv;
  const { storageBase, storageRoot } = resolveStorage({
    env,
    appEnv,
    serverRoot,
  });
  env[STORAGE_BASE_ENV] = storageBase;
  env.STORAGE_DIR = storageRoot;
  env[STORAGE_APPLIED_ENV] = "true";

  const provider = databaseProvider(env);
  const sqliteSourceDatabasePath = path.join(storageRoot, "anythingllm.db");
  const sqliteAuthSourceDatabasePath = path.join(
    storageBase,
    "shared",
    "auth.db"
  );
  const databasePath = provider === "sqlite" ? sqliteSourceDatabasePath : null;
  const configuredAuthPath =
    provider === "sqlite" ? fileDatabasePath(env.AUTH_DATABASE_URL) : null;
  const authDatabasePath =
    provider === "sqlite"
      ? configuredAuthPath || path.join(storageBase, "shared", "auth.db")
      : null;
  if (provider === "sqlite" && !isWithin(storageBase, authDatabasePath)) {
    throw new ScriptRuntimeError(
      "script_database_outside_storage_root",
      `Auth database path is outside the configured storage root: ${authDatabasePath}`
    );
  }
  const mainDatabaseUrl =
    provider === "postgresql" ? mainPostgresqlUrl(env) : null;
  const authDatabaseUrl =
    provider === "postgresql" ? authPostgresqlUrl(env) : null;
  const mainMigrationDatabaseUrl =
    provider === "postgresql" && env.ATHENA_POSTGRES_MAIN_MIGRATION_URL
      ? migrationPostgresqlUrl("main", env)
      : null;
  const authMigrationDatabaseUrl =
    provider === "postgresql" && env.ATHENA_POSTGRES_AUTH_MIGRATION_URL
      ? migrationPostgresqlUrl("auth", env)
      : null;
  return {
    appEnv,
    environmentExplicit,
    envPath,
    storageBase,
    storageRoot,
    databasePath,
    authDatabasePath,
    databaseProvider: provider,
    sqliteSourceDatabasePath,
    sqliteAuthSourceDatabasePath,
    mainDatabaseUrl,
    authDatabaseUrl,
    mainMigrationDatabaseUrl,
    authMigrationDatabaseUrl,
    argv: stripRuntimeArguments(argv),
  };
}

async function assertPostgresqlSchema({
  databaseUrl,
  requiredTables = [],
  label = "main",
} = {}) {
  const modulePath =
    label === "auth"
      ? "../../generated/postgresql-auth"
      : "../../generated/postgresql-main";
  let PrismaClient;
  try {
    ({ PrismaClient } = require(modulePath));
  } catch (error) {
    throw new ScriptRuntimeError(
      "postgresql_client_missing",
      "PostgreSQL Prisma client has not been generated. Run yarn prisma:postgresql:generate first.",
      { cause: error?.message || String(error) }
    );
  }
  const inspector = new PrismaClient({
    log: [],
    datasources: { db: { url: databaseUrl } },
  });
  try {
    await inspector.$queryRaw`SELECT 1`;
    if (!requiredTables.length) return;
    const rows = await inspector.$queryRawUnsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()"
    );
    const available = new Set(rows.map((row) => String(row.table_name)));
    const missing = requiredTables.filter((table) => !available.has(table));
    if (missing.length) {
      throw new ScriptRuntimeError(
        "database_schema_mismatch",
        `${label} database is missing required schema tables.`,
        { missingTables: missing }
      );
    }
  } finally {
    await inspector.$disconnect();
  }
}

function assertDatabaseFile(databasePath, label = "main") {
  if (!fs.existsSync(databasePath)) {
    throw new ScriptRuntimeError(
      "database_missing",
      `${label} database does not exist: ${databasePath}`
    );
  }
  const stat = fs.statSync(databasePath);
  if (!stat.isFile() || stat.size < 16) {
    throw new ScriptRuntimeError(
      "database_invalid",
      `${label} database is not a valid SQLite file: ${databasePath}`
    );
  }
  const header = Buffer.alloc(16);
  const fd = fs.openSync(databasePath, "r");
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.toString("utf8") !== "SQLite format 3\u0000") {
    throw new ScriptRuntimeError(
      "database_invalid",
      `${label} database has an invalid SQLite header: ${databasePath}`
    );
  }
}

async function assertDatabaseSchema({
  databasePath,
  requiredTables = [],
  label = "main",
} = {}) {
  assertDatabaseFile(databasePath, label);
  if (!requiredTables.length) return;
  const { PrismaClient } = require("@prisma/client");
  const url = new URL(`file:${databasePath}`);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "5");
  const inspector = new PrismaClient({
    log: [],
    datasources: { db: { url: url.toString() } },
  });
  try {
    const rows = await inspector.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    const available = new Set(rows.map((row) => String(row.name)));
    const missing = requiredTables.filter((table) => !available.has(table));
    if (missing.length) {
      throw new ScriptRuntimeError(
        "database_schema_mismatch",
        `${label} database is missing required schema tables.`,
        { missingTables: missing }
      );
    }
  } finally {
    await inspector.$disconnect();
  }
}

async function bootstrapCliRuntime({
  access = "read",
  execute = false,
  argv = process.argv.slice(2),
  env = process.env,
  serverRoot = path.resolve(__dirname, "../.."),
  database = "main",
  requiredTables = [],
  requireExistingDatabase = true,
  announce = true,
} = {}) {
  const runtime = resolveRuntimeConfiguration({ env, argv, serverRoot });
  if (access === "write") {
    if (!execute) {
      throw new ScriptRuntimeError(
        "script_execute_confirmation_required",
        "Write-capable maintenance requires --execute."
      );
    }
    if (!runtime.environmentExplicit) {
      throw new ScriptRuntimeError(
        "script_environment_required",
        "Write-capable maintenance requires APP_ENV or --env."
      );
    }
  }

  const selectedPath =
    database === "auth" ? runtime.authDatabasePath : runtime.databasePath;
  const selectedUrl =
    database === "auth" ? runtime.authDatabaseUrl : runtime.mainDatabaseUrl;
  if (requireExistingDatabase) {
    if (runtime.databaseProvider === "postgresql") {
      await assertPostgresqlSchema({
        databaseUrl: selectedUrl,
        requiredTables,
        label: database,
      });
    } else {
      await assertDatabaseSchema({
        databasePath: selectedPath,
        requiredTables,
        label: database,
      });
    }
  }
  if (announce) {
    const target =
      runtime.databaseProvider === "postgresql"
        ? `${database}:postgresql`
        : selectedPath;
    console.error(
      `[script-runtime] env=${runtime.appEnv} access=${access} database=${target}`
    );
  }
  return runtime;
}

module.exports = {
  ScriptRuntimeError,
  assertDatabaseFile,
  assertDatabaseSchema,
  assertPostgresqlSchema,
  bootstrapCliRuntime,
  environmentArgument,
  resolveRuntimeConfiguration,
  stripRuntimeArguments,
};
