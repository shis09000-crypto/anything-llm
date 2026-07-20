const { auditDatabase } = require("../../scripts/p0-database-audit");

describe("P0 database audit provider semantics", () => {
  it("uses PostgreSQL reachability and validated-constraint checks", async () => {
    const client = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ healthy: 1 }])
        .mockResolvedValueOnce([]),
    };

    await expect(auditDatabase("main", client, "postgresql")).resolves.toEqual(
      {
        name: "main",
        provider: "postgresql",
        quickCheck: "reachable",
        foreignKeyViolationCount: 0,
        constraints: "validated",
      }
    );
    expect(client.$queryRawUnsafe.mock.calls[0][0]).toContain("SELECT 1");
    expect(client.$queryRawUnsafe.mock.calls[1][0]).toContain("pg_constraint");
  });

  it("fails closed for an unvalidated PostgreSQL foreign key", async () => {
    const client = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ healthy: 1 }])
        .mockResolvedValueOnce([{ constraint_name: "fk_unvalidated" }]),
    };

    await expect(
      auditDatabase("auth", client, "postgresql")
    ).rejects.toMatchObject({
      details: { provider: "postgresql", unvalidatedForeignKeys: 1 },
    });
  });
});
