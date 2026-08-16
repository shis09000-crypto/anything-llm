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
    expect(
      connectionBudget({
        ATHENA_RUNTIME_ROLE: "browser-egress",
        ATHENA_DB_POOL_SIZE_BROWSER_EGRESS: "3",
      })
    ).toBe(3);
  });

  it("keeps main and auth database URLs independently configured", () => {
    const env = {
      ATHENA_POSTGRES_MAIN_URL: "postgresql://main@localhost:5432/athena_main",
      ATHENA_POSTGRES_AUTH_URL: "postgresql://auth@localhost:5432/athena_auth",
    };
    expect(new URL(mainPostgresqlUrl(env)).pathname).toBe("/athena_main");
    expect(new URL(authPostgresqlUrl(env)).pathname).toBe("/athena_auth");
  });

  it("fails closed onto the role-owned principal after module cutover", () => {
    const env = {
      ATHENA_RUNTIME_ROLE: "scheduler",
      ATHENA_MODULE_SCHEMA_CUTOVER: "true",
      ATHENA_POSTGRES_MAIN_URL:
        "postgresql://legacy@localhost:5432/athena_main",
      ATHENA_SCHEDULER_DATABASE_URL:
        "postgresql://scheduler@localhost:5432/athena_main?schema=public",
    };
    const selected = new URL(mainPostgresqlUrl(env));
    expect(selected.username).toBe("scheduler");
    expect(selected.searchParams.get("schema")).toBe("public");

    delete env.ATHENA_SCHEDULER_DATABASE_URL;
    expect(() => mainPostgresqlUrl(env)).toThrow("main_postgresql_url_missing");
  });

  it("uses the dedicated Browser Egress principal after module cutover", () => {
    const selected = new URL(
      mainPostgresqlUrl({
        ATHENA_RUNTIME_ROLE: "browser-egress",
        ATHENA_MODULE_SCHEMA_CUTOVER: "true",
        ATHENA_BROWSER_EGRESS_DATABASE_URL:
          "postgresql://browser_egress@localhost:5432/athena_main?schema=public",
      })
    );
    expect(selected.username).toBe("browser_egress");
    expect(selected.searchParams.get("connection_limit")).toBe("3");
  });

  it("uses a read-only observer for the non-owning database", () => {
    const env = {
      ATHENA_RUNTIME_ROLE: "chat-runtime",
      ATHENA_MODULE_SCHEMA_CUTOVER: "true",
      ATHENA_CHAT_DATABASE_URL:
        "postgresql://chat@localhost:5432/athena_main?schema=public",
      ATHENA_AUTH_OBSERVER_DATABASE_URL:
        "postgresql://auth_observer@localhost:5432/athena_auth?schema=public",
    };
    expect(new URL(mainPostgresqlUrl(env)).username).toBe("chat");
    expect(new URL(authPostgresqlUrl(env)).username).toBe("auth_observer");
  });

  it.each([
    ["coordination-plane", "ATHENA_COORDINATION_DATABASE_URL", "coordination"],
    ["browser-worker", "ATHENA_BROWSER_DATABASE_URL", "browser"],
    ["browser-egress", "ATHENA_BROWSER_EGRESS_DATABASE_URL", "browser_egress"],
  ])(
    "keeps the %s runtime on its dedicated main principal",
    (role, setting, username) => {
      const env = {
        ATHENA_RUNTIME_ROLE: role,
        ATHENA_MODULE_SCHEMA_CUTOVER: "true",
        [setting]: `postgresql://${username}@localhost:5432/athena_main?schema=public`,
        ATHENA_AUTH_OBSERVER_DATABASE_URL:
          "postgresql://auth_observer@localhost:5432/athena_auth?schema=public",
      };

      expect(poolRole(env)).toBe(role);
      expect(new URL(mainPostgresqlUrl(env)).username).toBe(username);
      expect(new URL(authPostgresqlUrl(env)).username).toBe("auth_observer");
    }
  );

  it("gives Key Custody its dedicated main and auth principals", () => {
    const env = {
      ATHENA_RUNTIME_ROLE: "key-custody",
      ATHENA_MODULE_SCHEMA_CUTOVER: "true",
      ATHENA_KEY_CUSTODY_MAIN_DATABASE_URL:
        "postgresql://custody@localhost:5432/athena_main?schema=public",
      ATHENA_KEY_CUSTODY_DATABASE_URL:
        "postgresql://custody@localhost:5432/athena_auth?schema=public",
      ATHENA_MAIN_OBSERVER_DATABASE_URL:
        "postgresql://main_observer@localhost:5432/athena_main?schema=public",
    };
    expect(new URL(mainPostgresqlUrl(env)).username).toBe("custody");
    expect(new URL(authPostgresqlUrl(env)).username).toBe("custody");
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
