const {
  databaseTableColumns,
  databaseTablesReady,
  ensureMigrationOwnedTables,
} = require("../../utils/database/schemaIntrospection");

describe("database schema introspection", () => {
  const postgres = { ATHENA_DATABASE_PROVIDER: "postgresql" };
  const sqlite = { ATHENA_DATABASE_PROVIDER: "sqlite" };

  it("uses migration-owned PostgreSQL catalog tables without runtime DDL", async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        { name: "sync_nodes" },
        { name: "sync_outbox" },
      ]),
    };

    await expect(
      ensureMigrationOwnedTables(client, ["sync_nodes", "sync_outbox"], {
        context: "sync-v2",
        env: postgres,
      })
    ).resolves.toBe(true);
    expect(client.$queryRawUnsafe.mock.calls[0][0]).toContain(
      "information_schema.tables"
    );
  });

  it("fails closed when a PostgreSQL migration-owned table is missing", async () => {
    const client = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValue([{ name: "sync_nodes" }]),
    };

    await expect(
      ensureMigrationOwnedTables(client, ["sync_nodes", "sync_outbox"], {
        context: "sync-v2",
        env: postgres,
      })
    ).rejects.toMatchObject({
      code: "DATABASE_SCHEMA_MIGRATION_REQUIRED",
      missingTables: ["sync_outbox"],
    });
  });

  it("keeps SQLite runtime table ownership and supports readiness checks", async () => {
    const client = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValue([{ name: "sync_nodes" }]),
    };

    await expect(
      ensureMigrationOwnedTables(client, ["sync_nodes"], { env: sqlite })
    ).resolves.toBe(false);
    await expect(
      databaseTablesReady(client, ["sync_nodes"], sqlite)
    ).resolves.toBe(true);
    expect(client.$queryRawUnsafe.mock.calls[0][0]).toContain("sqlite_master");
  });

  it("reads provider-specific column catalogs and rejects unsafe identifiers", async () => {
    const client = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValue([{ name: "public_id" }]),
    };
    await expect(
      databaseTableColumns(client, "workspace_chats", postgres)
    ).resolves.toEqual(new Set(["public_id"]));
    await expect(
      databaseTableColumns(client, 'workspace_chats"; DROP TABLE users;--')
    ).rejects.toMatchObject({
      code: "DATABASE_SCHEMA_IDENTIFIER_INVALID",
    });
  });
});
