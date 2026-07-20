const {
  adaptRawSql,
  installMigrationWriteBarrier,
  postgresqlInsertOrIgnore,
  postgresqlPlaceholders,
} = require("../../utils/database/sqlDialect");

describe("SQL dialect adapter", () => {
  it("rewrites positional parameters without touching strings or comments", () => {
    expect(
      postgresqlPlaceholders(
        "SELECT '?' AS literal FROM t WHERE a = ? AND b = ? -- ?\nAND c = '?'"
      )
    ).toBe(
      "SELECT '?' AS literal FROM t WHERE a = $1 AND b = $2 -- ?\nAND c = '?'"
    );
  });

  it("converts SQLite insert-or-ignore without changing conflict semantics", () => {
    expect(
      postgresqlInsertOrIgnore(
        'INSERT OR IGNORE INTO "items" ("id") VALUES (?) RETURNING "id"'
      )
    ).toBe(
      'INSERT INTO "items" ("id") VALUES (?) ON CONFLICT DO NOTHING RETURNING "id"'
    );
  });

  it("applies conservative PostgreSQL compatibility rewrites only for PostgreSQL", () => {
    const sql = "SELECT datetime('now') WHERE id = ?";
    expect(adaptRawSql(sql, { ATHENA_DATABASE_PROVIDER: "sqlite" })).toBe(sql);
    expect(
      adaptRawSql(sql, { ATHENA_DATABASE_PROVIDER: "postgresql" })
    ).toBe("SELECT CURRENT_TIMESTAMP WHERE id = $1");
  });

  it("blocks mutations while the bounded cutover write barrier is active", async () => {
    let middleware;
    const client = {
      $use: jest.fn((handler) => (middleware = handler)),
    };
    installMigrationWriteBarrier(client, {
      ATHENA_DATABASE_MIGRATION_MODE: "cutover",
    });
    const next = jest.fn(async () => "ok");
    await expect(middleware({ action: "findMany" }, next)).resolves.toBe("ok");
    await expect(middleware({ action: "update" }, next)).rejects.toMatchObject({
      code: "DATABASE_MIGRATION_WRITE_BARRIER_ACTIVE",
    });
  });
});
