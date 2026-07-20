const {
  databaseArgument,
  mutatingCommand,
  stripDatabaseArgument,
} = require("../../scripts/postgresql-prisma-runtime");

describe("postgresql prisma runtime", () => {
  it("selects main by default and supports an explicit auth database", () => {
    expect(databaseArgument(["migrate", "status"])).toBe("main");
    expect(databaseArgument(["--database", "auth", "migrate", "status"])).toBe(
      "auth"
    );
    expect(databaseArgument(["--database=auth", "migrate", "status"])).toBe(
      "auth"
    );
  });

  it("does not forward runtime-only database arguments to Prisma", () => {
    expect(
      stripDatabaseArgument([
        "--database",
        "auth",
        "migrate",
        "deploy",
        "--schema=custom.prisma",
      ])
    ).toEqual(["migrate", "deploy", "--schema=custom.prisma"]);
  });

  it("requires explicit write confirmation for mutating command classes", () => {
    expect(mutatingCommand(["migrate", "deploy"])).toBe(true);
    expect(mutatingCommand(["db", "execute"])).toBe(true);
    expect(mutatingCommand(["migrate", "status"])).toBe(false);
    expect(mutatingCommand(["validate"])).toBe(false);
  });
});
