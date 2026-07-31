const Database = require("better-sqlite3");
const {
  bindValue,
  chunkHash,
  convertValue,
  differingColumns,
  installCdc,
  orderedTables,
  parameterExpression,
  parseArgs,
  sourceTables,
  syncTargetSequences,
  tableMetadata,
  upsertStatement,
} = require("../../scripts/migrate-sqlite-to-postgresql");

describe("SQLite to PostgreSQL migration controls", () => {
  it("parses conservative dry-run defaults", () => {
    expect(parseArgs([])).toMatchObject({
      command: "plan",
      database: "main",
      execute: false,
      allowNonempty: false,
    });
  });

  it("orders parent tables before children and records only primary keys in CDC", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE parents (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parentId INTEGER NOT NULL REFERENCES parents(id),
        largePayload TEXT
      );
    `);
    expect(orderedTables(db)).toEqual(["parents", "children"]);
    expect(installCdc(db)).toBe(6);
    db.prepare("INSERT INTO parents(id, value) VALUES (?, ?)").run(1, "parent");
    db.prepare(
      "INSERT INTO children(id, parentId, largePayload) VALUES (?, ?, ?)"
    ).run(2, 1, "x".repeat(100_000));
    const changes = db
      .prepare(
        "SELECT tableName, operation, pkJson FROM athena_migration_changes ORDER BY seq"
      )
      .all();
    expect(changes).toEqual([
      { tableName: "parents", operation: "insert", pkJson: '{"id":1}' },
      { tableName: "children", operation: "insert", pkJson: '{"id":2}' },
    ]);
    expect(changes[1].pkJson).not.toContain("largePayload");
    db.close();
  });

  it("generates deterministic upserts and canonical chunk hashes", () => {
    const metadata = {
      table: "items",
      columns: ["id", "enabled", "updatedAt"],
      primaryKey: ["id"],
    };
    const statement = upsertStatement(
      metadata,
      new Map([
        ["id", "integer"],
        ["enabled", "boolean"],
        ["updatedAt", "timestamp without time zone"],
      ])
    );
    expect(statement.sql).toContain('ON CONFLICT ("id") DO UPDATE SET');
    expect(convertValue(0, "boolean")).toBe(false);
    expect(convertValue(1, "boolean")).toBe(true);
    const first = chunkHash([{ id: 1, enabled: true }], ["id", "enabled"]);
    const second = chunkHash([{ id: 1, enabled: true }], ["id", "enabled"]);
    expect(first).toBe(second);
  });

  it("binds integer-valued SQLite REALs through an explicit text cast", () => {
    const metadata = {
      table: "scores",
      columns: ["id", "score", "amount"],
      primaryKey: ["id"],
    };
    const statement = upsertStatement(
      metadata,
      new Map([
        ["id", "integer"],
        ["score", "double precision"],
        ["amount", "numeric"],
      ])
    );
    expect(statement.sql).toContain(
      'VALUES ($1, $2::text::double precision, $3::text::numeric)'
    );
    expect(parameterExpression(0, "integer")).toBe("$1");
    expect(bindValue(1, "double precision")).toBe("1");
    expect(convertValue(1, "double precision")).toBe(1);
  });

  it("reports only differing column names during hash diagnosis", () => {
    expect(
      differingColumns(
        [{ id: 1, enabled: 1, value: "source" }],
        [{ id: 1, enabled: true, value: "target" }],
        ["id", "enabled", "value"],
        new Map([
          ["id", "integer"],
          ["enabled", "boolean"],
          ["value", "text"],
        ])
      )
    ).toEqual(["value"]);
  });

  it("advances PostgreSQL sequences to the migrated maximum primary key", async () => {
    const client = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([
          {
            table_name: "items",
            column_name: "id",
            sequence_name: "public.items_id_seq",
          },
        ])
        .mockResolvedValueOnce([{ maximum: 42n }])
        .mockResolvedValueOnce([{ setval: 42n }]),
    };
    await expect(syncTargetSequences(client)).resolves.toBe(1);
    expect(client.$queryRawUnsafe).toHaveBeenLastCalledWith(
      "SELECT setval($1::text::regclass, $2::text::bigint, $3::boolean)",
      "public.items_id_seq",
      "42",
      true
    );
  });

  it("discovers composite primary keys in declared order", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE cursors (userId INTEGER, clientId TEXT, value TEXT, PRIMARY KEY(userId, clientId))"
    );
    expect(tableMetadata(db, "cursors").primaryKey).toEqual([
      "userId",
      "clientId",
    ]);
    db.close();
  });

  it("combines PostgreSQL-only foreign keys with SQLite table ordering", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE child_rows (id INTEGER PRIMARY KEY, parentId INTEGER);
      CREATE TABLE parent_rows (id INTEGER PRIMARY KEY);
    `);
    expect(
      orderedTables(
        db,
        ["child_rows", "parent_rows"],
        new Map([["child_rows", new Set(["parent_rows"])]])
      )
    ).toEqual(["parent_rows", "child_rows"]);
    db.close();
  });

  it("never copies Prisma or Athena migration control tables", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY);
      CREATE TABLE athena_migration_changes (seq INTEGER PRIMARY KEY);
      CREATE TABLE athena_migration_state (key TEXT PRIMARY KEY);
      CREATE TABLE business_rows (id INTEGER PRIMARY KEY);
    `);
    expect(sourceTables(db)).toEqual(["business_rows"]);
    db.close();
  });
});
