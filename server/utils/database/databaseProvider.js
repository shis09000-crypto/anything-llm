const RUNTIME_ROLES = Object.freeze({
  api: "API",
  background: "BACKGROUND",
  "background-worker": "BACKGROUND",
  reader: "READER",
  "reader-worker": "READER",
  gateway: "GATEWAY",
  "realtime-gateway": "GATEWAY",
  auth: "AUTH",
  identity: "AUTH",
  "key-custody": "CUSTODY",
  "chat-runtime": "CHAT",
  "agent-runtime": "AGENT",
  "model-gateway": "MODEL",
  "tool-broker": "TOOL",
  "crypto-market": "CRYPTO_MARKET",
  "crypto-account": "CRYPTO_ACCOUNT",
  "crypto-forecast": "CRYPTO_FORECAST",
  "browser-plane": "BROWSER",
  "browser-worker": "BROWSER",
  rag: "RAG",
  "knowledge-ingest": "KNOWLEDGE",
  scheduler: "SCHEDULER",
  "operations-plane": "OPERATIONS",
  "operations-shadow-agents": "OPERATIONS",
});

const MAIN_ROLE_DATABASE_URLS = Object.freeze({
  api: "ATHENA_WORKSPACE_DATABASE_URL",
  identity: "ATHENA_IDENTITY_MAIN_DATABASE_URL",
  auth: "ATHENA_IDENTITY_MAIN_DATABASE_URL",
  "key-custody": "ATHENA_KEY_CUSTODY_MAIN_DATABASE_URL",
  "chat-runtime": "ATHENA_CHAT_DATABASE_URL",
  "agent-runtime": "ATHENA_AGENT_DATABASE_URL",
  "model-gateway": "ATHENA_MODEL_DATABASE_URL",
  "tool-broker": "ATHENA_TOOL_DATABASE_URL",
  "crypto-market": "ATHENA_CRYPTO_MARKET_DATABASE_URL",
  "crypto-account": "ATHENA_CRYPTO_ACCOUNT_DATABASE_URL",
  "crypto-forecast": "ATHENA_CRYPTO_FORECAST_DATABASE_URL",
  "browser-plane": "ATHENA_BROWSER_DATABASE_URL",
  "browser-worker": "ATHENA_BROWSER_DATABASE_URL",
  rag: "ATHENA_RAG_DATABASE_URL",
  "knowledge-ingest": "ATHENA_INGEST_DATABASE_URL",
  reader: "ATHENA_READER_DATABASE_URL",
  "reader-worker": "ATHENA_READER_DATABASE_URL",
  background: "ATHENA_BACKGROUND_DATABASE_URL",
  "background-worker": "ATHENA_BACKGROUND_DATABASE_URL",
  scheduler: "ATHENA_SCHEDULER_DATABASE_URL",
  gateway: "ATHENA_SYNC_DATABASE_URL",
  "realtime-gateway": "ATHENA_SYNC_DATABASE_URL",
  "operations-plane": "ATHENA_MAINTENANCE_DATABASE_URL",
  "operations-shadow-agents": "ATHENA_MAINTENANCE_DATABASE_URL",
});

const AUTH_ROLE_DATABASE_URLS = Object.freeze({
  api: "ATHENA_IDENTITY_DATABASE_URL",
  identity: "ATHENA_IDENTITY_DATABASE_URL",
  auth: "ATHENA_IDENTITY_DATABASE_URL",
  "key-custody": "ATHENA_KEY_CUSTODY_DATABASE_URL",
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
    "background-worker": 5,
    reader: 5,
    "reader-worker": 5,
    gateway: 3,
    "realtime-gateway": 3,
    auth: 5,
    identity: 5,
    "key-custody": 3,
    "chat-runtime": 10,
    "agent-runtime": 8,
    "model-gateway": 3,
    "tool-broker": 6,
    "crypto-market": 4,
    "crypto-account": 4,
    "crypto-forecast": 3,
    "browser-plane": 4,
    rag: 6,
    "knowledge-ingest": 5,
    scheduler: 4,
    "operations-plane": 3,
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
  const role = poolRole(env);
  const roleSetting =
    env.ATHENA_MODULE_SCHEMA_CUTOVER === "true"
      ? MAIN_ROLE_DATABASE_URLS[role] || "ATHENA_MAIN_OBSERVER_DATABASE_URL"
      : null;
  return withPoolBudget(
    requirePostgresqlUrl(
      (roleSetting ? env[roleSetting] : null) ||
        (!roleSetting
          ? env.ATHENA_POSTGRES_MAIN_URL || env.DATABASE_URL
          : null),
      "main"
    ),
    env,
    role
  );
}

function authPostgresqlUrl(env = process.env) {
  const role = poolRole(env, "auth");
  const roleSetting =
    env.ATHENA_MODULE_SCHEMA_CUTOVER === "true"
      ? AUTH_ROLE_DATABASE_URLS[role] || "ATHENA_AUTH_OBSERVER_DATABASE_URL"
      : null;
  return withPoolBudget(
    requirePostgresqlUrl(
      (roleSetting ? env[roleSetting] : null) ||
        (!roleSetting
          ? env.ATHENA_POSTGRES_AUTH_URL || env.AUTH_DATABASE_URL
          : null),
      "auth"
    ),
    env,
    role
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
  AUTH_ROLE_DATABASE_URLS,
  MAIN_ROLE_DATABASE_URLS,
  withPoolBudget,
};
