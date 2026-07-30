const {
  authPostgresqlUrl,
  connectionBudget,
  databaseProvider,
  mainPostgresqlUrl,
  migrationPostgresqlUrl,
  poolRole,
  withPoolBudget,
} = require("../../utils/database/databaseProvider");

describe("databaseProvider", () => {
  it("defaults desktop runtimes to sqlite", () => {
    expect(databaseProvider({})).toBe("sqlite");
  });

  it("refuses sqlite for distributed and cloud topologies", () => {
    expect(() =>
      databaseProvider({ ATHENA_RUNTIME_TOPOLOGY: "distributed" })
    ).toThrow("distributed_runtime_requires_postgresql");
    expect(() =>
      databaseProvider({ ATHENA_RUNTIME_TOPOLOGY: "cloud" })
    ).toThrow("distributed_runtime_requires_postgresql");
  });

  it("fails closed when PostgreSQL URLs are absent", () => {
    expect(() =>
      mainPostgresqlUrl({ ATHENA_DATABASE_PROVIDER: "postgresql" })
    ).toThrow("main_postgresql_url_missing");
    expect(() =>
      authPostgresqlUrl({ ATHENA_DATABASE_PROVIDER: "postgresql" })
    ).toThrow("auth_postgresql_url_missing");
  });

  it("adds role-scoped connection budgets without overriding explicit values", () => {
    const env = {
      ATHENA_RUNTIME_ROLE: "background",
      ATHENA_DB_POOL_SIZE_BACKGROUND: "7",
      ATHENA_DB_POOL_TIMEOUT_SECONDS: "4",
    };
    expect(connectionBudget(env)).toBe(7);
    const generated = new URL(
      withPoolBudget("postgresql://role@localhost:5432/athena", env)
    );
    expect(generated.searchParams.get("connection_limit")).toBe("7");
    expect(generated.searchParams.get("pool_timeout")).toBe("4");

    const explicit = new URL(
      withPoolBudget(
        "postgresql://role@localhost:5432/athena?connection_limit=2&pool_timeout=9",
        env
      )
    );
    expect(explicit.searchParams.get("connection_limit")).toBe("2");
    expect(explicit.searchParams.get("pool_timeout")).toBe("9");
  });

  it("assigns independent budgets to extracted micro-module roles", () => {
    expect(poolRole({ ATHENA_RUNTIME_ROLE: "chat-runtime" })).toBe(
      "chat-runtime"
    );
    expect(
      connectionBudget({
        ATHENA_RUNTIME_ROLE: "chat-runtime",
        ATHENA_DB_POOL_SIZE_CHAT: "12",
      })
    ).toBe(12);
    expect(
      connectionBudget({
        ATHENA_RUNTIME_ROLE: "crypto-account",
        ATHENA_DB_POOL_SIZE_CRYPTO_ACCOUNT: "4",
      })
    ).toBe(4);
  });

  it("keeps main and auth database URLs independently configured", () => {
    const env = {
      ATHENA_POSTGRES_MAIN_URL: "postgresql://main@localhost:5432/athena_main",
      ATHENA_POSTGRES_AUTH_URL: "postgresql://auth@localhost:5432/athena_auth",
    };
    expect(new URL(mainPostgresqlUrl(env)).pathname).toBe("/athena_main");
    expect(new URL(authPostgresqlUrl(env)).pathname).toBe("/athena_auth");
  });

  it("fails closed onto the role-owned schema after module cutover", () => {
    const env = {
      ATHENA_RUNTIME_ROLE: "scheduler",
      ATHENA_MODULE_SCHEMA_CUTOVER: "true",
      ATHENA_POSTGRES_MAIN_URL:
        "postgresql://legacy@localhost:5432/athena_main",
      ATHENA_SCHEDULER_DATABASE_URL:
        "postgresql://scheduler@localhost:5432/athena_main?schema=scheduler",
    };
    const selected = new URL(mainPostgresqlUrl(env));
    expect(selected.username).toBe("scheduler");
    expect(selected.searchParams.get("schema")).toBe("scheduler");

    delete env.ATHENA_SCHEDULER_DATABASE_URL;
    expect(() => mainPostgresqlUrl(env)).toThrow("main_postgresql_url_missing");
  });

  it("requires a dedicated migration principal", () => {
    expect(() =>
      migrationPostgresqlUrl("main", {
        ATHENA_POSTGRES_MAIN_URL: "postgresql://api@localhost:5432/athena_main",
      })
    ).toThrow("main_migration_postgresql_url_missing");
    const url = migrationPostgresqlUrl("auth", {
      ATHENA_POSTGRES_AUTH_MIGRATION_URL:
        "postgresql://migrator@localhost:5432/athena_auth",
    });
    expect(new URL(url).username).toBe("migrator");
  });
});
