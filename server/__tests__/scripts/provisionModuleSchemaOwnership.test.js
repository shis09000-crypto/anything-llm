const {
  applyOwnership,
} = require("../../scripts/provision-module-schema-ownership");

describe("module schema ownership provisioner", () => {
  it("quotes mixed-case table names when resolving their serial sequences", async () => {
    const client = {
      query: jest.fn(async (sql, params = []) => {
        if (sql.includes("FROM pg_catalog.pg_tables")) {
          return { rows: [{ tablename: "WorkspaceVisualAsset" }] };
        }
        if (sql.includes("pg_get_serial_sequence")) {
          expect(params).toEqual([
            'public."WorkspaceVisualAsset"',
            "WorkspaceVisualAsset",
          ]);
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    await expect(
      applyOwnership({
        client,
        database: "main",
        registry: [{ table: "WorkspaceVisualAsset", schema: "workspace" }],
        roles: { workspace: "athena_workspace" },
      })
    ).resolves.toEqual({ database: "main", tables: 1, covered: 1 });
  });

  it("provisions the append-only Identity audit capability", async () => {
    const queries = [];
    const client = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (sql.includes("FROM pg_catalog.pg_tables")) {
          return { rows: [{ tablename: "security_audit_ledger" }] };
        }
        if (sql.includes("pg_get_serial_sequence")) return { rows: [] };
        return { rows: [] };
      }),
    };

    await applyOwnership({
      client,
      database: "main",
      registry: [{ table: "security_audit_ledger", schema: "maintenance" }],
      roles: {
        identity: "athena_identity",
        maintenance: "athena_maintenance",
      },
    });

    expect(
      queries.some((sql) =>
        sql.includes(
          'GRANT SELECT, INSERT ON TABLE public."security_audit_ledger" TO "athena_identity"'
        )
      )
    ).toBe(true);
  });
});
