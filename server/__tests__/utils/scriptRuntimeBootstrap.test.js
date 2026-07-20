const fs = require("fs");
const os = require("os");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const {
  bootstrapCliRuntime,
  resolveRuntimeConfiguration,
} = require("../../scripts/lib/runtimeBootstrap");
const { defaultEnvPath } = require("../../utils/security/keyCustody/providers");

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-script-runtime-"));
  fs.writeFileSync(
    path.join(root, ".env.development"),
    `STORAGE_DIR=${path.join(root, "storage", "development")}\nENCRYPTION_MASTER_KEY=${"a".repeat(64)}\n`
  );
  fs.writeFileSync(
    path.join(root, ".env"),
    `STORAGE_DIR=${path.join(root, "storage", "production")}\nENCRYPTION_MASTER_KEY=${"b".repeat(64)}\n`
  );
  return root;
}

async function sqliteDatabase(file, tables = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const url = new URL(`file:${file}`);
  const client = new PrismaClient({
    log: [],
    datasources: { db: { url: url.toString() } },
  });
  try {
    for (const table of tables) {
      await client.$executeRawUnsafe(`CREATE TABLE "${table}" ("id" INTEGER)`);
    }
  } finally {
    await client.$disconnect();
  }
}

describe("script runtime bootstrap", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });

  test("APP_ENV development selects the development env file and final storage root", () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    const envFile = path.join(serverRoot, ".env.development");
    const before = fs.statSync(envFile);
    const env = { APP_ENV: "development" };
    const runtime = resolveRuntimeConfiguration({ env, serverRoot, argv: [] });
    const after = fs.statSync(envFile);

    expect(runtime.envPath).toBe(path.join(serverRoot, ".env.development"));
    expect(runtime.storageRoot).toBe(
      path.join(serverRoot, "storage", "development")
    );
    expect(runtime.storageRoot).not.toContain("development/development");
    expect(env.NODE_ENV).toBe("development");
    expect(env.ENCRYPTION_MASTER_KEY).toBe("a".repeat(64));
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("production loads the production env file without crossing key sources", () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    const env = { APP_ENV: "production" };
    const runtime = resolveRuntimeConfiguration({ env, serverRoot, argv: [] });

    expect(runtime.envPath).toBe(path.join(serverRoot, ".env"));
    expect(runtime.storageRoot).toBe(
      path.join(serverRoot, "storage", "production")
    );
    expect(env.ENCRYPTION_MASTER_KEY).toBe("b".repeat(64));
  });

  test("PostgreSQL runtime resolves independent main and auth URLs without exposing SQLite paths", () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    const env = {
      APP_ENV: "development",
      ATHENA_DATABASE_PROVIDER: "postgresql",
      ATHENA_POSTGRES_MAIN_URL:
        "postgresql://main-role@localhost:5432/athena_main",
      ATHENA_POSTGRES_AUTH_URL:
        "postgresql://auth-role@localhost:5432/athena_auth",
    };
    const runtime = resolveRuntimeConfiguration({ env, serverRoot, argv: [] });

    expect(runtime.databaseProvider).toBe("postgresql");
    expect(runtime.databasePath).toBeNull();
    expect(runtime.authDatabasePath).toBeNull();
    expect(new URL(runtime.mainDatabaseUrl).pathname).toBe("/athena_main");
    expect(new URL(runtime.authDatabaseUrl).pathname).toBe("/athena_auth");
  });

  test("key provider selects its default env file from APP_ENV", () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);

    expect(
      defaultEnvPath(
        { APP_ENV: "development", NODE_ENV: "production" },
        serverRoot
      )
    ).toBe(path.join(serverRoot, ".env.development"));
    expect(defaultEnvPath({ APP_ENV: "production" }, serverRoot)).toBe(
      path.join(serverRoot, ".env")
    );
  });

  test("conflicting APP_ENV and NODE_ENV fail closed", () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    expect(() =>
      resolveRuntimeConfiguration({
        env: { APP_ENV: "development", NODE_ENV: "production" },
        serverRoot,
        argv: [],
      })
    ).toThrow("select different runtime environments");
  });

  test("duplicated environment storage path fails closed", () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    expect(() =>
      resolveRuntimeConfiguration({
        env: {
          APP_ENV: "development",
          STORAGE_DIR: path.join(
            serverRoot,
            "storage",
            "development",
            "development"
          ),
        },
        serverRoot,
        argv: [],
        loadEnv: false,
      })
    ).toThrow("duplicated environment storage path");
  });

  test("storage root for another environment fails closed", () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    expect(() =>
      resolveRuntimeConfiguration({
        env: {
          APP_ENV: "development",
          STORAGE_DIR: path.join(serverRoot, "storage", "production"),
        },
        serverRoot,
        argv: [],
        loadEnv: false,
      })
    ).toThrow(
      "STORAGE_DIR selects production while APP_ENV selects development"
    );
  });

  test("auth database outside the configured storage root fails closed", () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    expect(() =>
      resolveRuntimeConfiguration({
        env: {
          APP_ENV: "development",
          STORAGE_DIR: path.join(serverRoot, "storage"),
          AUTH_DATABASE_URL: `file:${path.join(serverRoot, "outside", "auth.db")}`,
        },
        serverRoot,
        argv: [],
        loadEnv: false,
      })
    ).toThrow("outside the configured storage root");
  });

  test("read-only audit refuses a missing database without creating it", async () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    const expected = path.join(
      serverRoot,
      "storage",
      "development",
      "anythingllm.db"
    );
    await expect(
      bootstrapCliRuntime({
        env: { APP_ENV: "development" },
        serverRoot,
        argv: [],
        requiredTables: ["sync_nodes"],
        announce: false,
      })
    ).rejects.toMatchObject({ code: "database_missing" });
    expect(fs.existsSync(expected)).toBe(false);
  });

  test("read-only bootstrap freezes SQLite access without touching the database", async () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    const database = path.join(
      serverRoot,
      "storage",
      "development",
      "anythingllm.db"
    );
    await sqliteDatabase(database, ["sync_nodes"]);
    const before = fs.statSync(database);
    const env = { APP_ENV: "development" };

    await bootstrapCliRuntime({
      env,
      serverRoot,
      argv: [],
      access: "read",
      requiredTables: ["sync_nodes"],
      announce: false,
    });

    const after = fs.statSync(database);
    expect(env.ATHENA_CLI_DATABASE_ACCESS).toBe("read");
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("wrong schema is rejected before the application Prisma module loads", async () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    const database = path.join(
      serverRoot,
      "storage",
      "development",
      "anythingllm.db"
    );
    await sqliteDatabase(database, ["users"]);
    const applicationPrisma = require.resolve("../../utils/prisma");
    delete require.cache[applicationPrisma];

    await expect(
      bootstrapCliRuntime({
        env: { APP_ENV: "development" },
        serverRoot,
        argv: [],
        requiredTables: ["sync_nodes"],
        announce: false,
      })
    ).rejects.toMatchObject({ code: "database_schema_mismatch" });
    expect(require.cache[applicationPrisma]).toBeUndefined();
  });

  test("write execution requires explicit environment and confirmation", async () => {
    const serverRoot = fixtureRoot();
    roots.push(serverRoot);
    const database = path.join(
      serverRoot,
      "storage",
      "development",
      "anythingllm.db"
    );
    await sqliteDatabase(database, ["sync_nodes"]);

    await expect(
      bootstrapCliRuntime({
        env: {},
        serverRoot,
        argv: ["--execute"],
        access: "write",
        execute: true,
        requiredTables: ["sync_nodes"],
        announce: false,
      })
    ).rejects.toMatchObject({ code: "script_environment_required" });
    await expect(
      bootstrapCliRuntime({
        env: { APP_ENV: "development" },
        serverRoot,
        argv: [],
        access: "write",
        execute: false,
        requiredTables: ["sync_nodes"],
        announce: false,
      })
    ).rejects.toMatchObject({ code: "script_execute_confirmation_required" });
  });
});
