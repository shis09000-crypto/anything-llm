const Database = require("better-sqlite3");
const {
  chunkHash,
  convertValue,
  installCdc,
  orderedTables,
  parseArgs,
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
});
