const RUNTIME_ROLES = Object.freeze({
  api: "API",
  background: "BACKGROUND",
  reader: "READER",
  gateway: "GATEWAY",
  auth: "AUTH",
});

function databaseProvider(env = process.env) {
  const provider = String(env.ATHENA_DATABASE_PROVIDER || "sqlite")
    .trim()
    .toLowerCase();
  if (!["sqlite", "postgresql"].includes(provider)) {
    const error = new Error("database_provider_invalid");
    error.code = "DATABASE_PROVIDER_INVALID";
    throw error;
  }
  if (
    provider === "sqlite" &&
    ["distributed", "cloud"].includes(
      String(env.ATHENA_RUNTIME_TOPOLOGY || "").toLowerCase()
    )
  ) {
    const error = new Error("distributed_runtime_requires_postgresql");
    error.code = "DISTRIBUTED_RUNTIME_REQUIRES_POSTGRESQL";
    throw error;
  }
  return provider;
}

function poolRole(env = process.env, fallback = "api") {
  const role = String(env.ATHENA_RUNTIME_ROLE || fallback)
    .trim()
    .toLowerCase();
  return RUNTIME_ROLES[role] ? role : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function connectionBudget(env = process.env, role = poolRole(env)) {
  const defaults = {
    api: 10,
    background: 5,
    reader: 5,
    gateway: 3,
    auth: 5,
  };
  return positiveInteger(
    env[`ATHENA_DB_POOL_SIZE_${RUNTIME_ROLES[role] || "API"}`],
    defaults[role] || defaults.api
  );
}

function requirePostgresqlUrl(value, label) {
  const raw = String(value || "").trim();
  if (!/^postgres(?:ql)?:\/\//i.test(raw)) {
    const error = new Error(`${label}_postgresql_url_missing`);
    error.code = `${label.toUpperCase()}_POSTGRESQL_URL_MISSING`;
    throw error;
  }
  return raw;
}

function withPoolBudget(value, env = process.env, role = poolRole(env)) {
  const url = new URL(value);
  if (!url.searchParams.has("connection_limit"))
    url.searchParams.set(
      "connection_limit",
      String(connectionBudget(env, role))
    );
  if (!url.searchParams.has("pool_timeout"))
    url.searchParams.set(
      "pool_timeout",
      String(positiveInteger(env.ATHENA_DB_POOL_TIMEOUT_SECONDS, 10))
    );
  return url.toString();
}

function mainPostgresqlUrl(env = process.env) {
  return withPoolBudget(
    requirePostgresqlUrl(
      env.ATHENA_POSTGRES_MAIN_URL || env.DATABASE_URL,
      "main"
    ),
    env
  );
}

function authPostgresqlUrl(env = process.env) {
  return withPoolBudget(
    requirePostgresqlUrl(
      env.ATHENA_POSTGRES_AUTH_URL || env.AUTH_DATABASE_URL,
      "auth"
    ),
    env,
    "auth"
  );
}

function migrationPostgresqlUrl(database = "main", env = process.env) {
  const auth = database === "auth";
  return withPoolBudget(
    requirePostgresqlUrl(
      auth
        ? env.ATHENA_POSTGRES_AUTH_MIGRATION_URL
        : env.ATHENA_POSTGRES_MAIN_MIGRATION_URL,
      auth ? "auth_migration" : "main_migration"
    ),
    env,
    auth ? "auth" : "background"
  );
}

function isPostgresql(env = process.env) {
  return databaseProvider(env) === "postgresql";
}

module.exports = {
  authPostgresqlUrl,
  connectionBudget,
  databaseProvider,
  isPostgresql,
  mainPostgresqlUrl,
  migrationPostgresqlUrl,
  poolRole,
  withPoolBudget,
};
