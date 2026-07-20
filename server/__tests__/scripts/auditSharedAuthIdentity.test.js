const {
  auditSharedAuthIdentity,
  duplicateAuthUserIds,
  parseArgs,
} = require("../../scripts/audit-shared-auth-identity");

function db(users = []) {
  return {
    users: {
      findMany: jest.fn(async () => users),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
}

describe("audit shared auth identity script", () => {
  it("defaults to dry-run and validates the requested environment", () => {
    expect(parseArgs(["--env", "production"])).toEqual({
      env: "production",
      dryRun: true,
      execute: false,
    });
    expect(parseArgs(["--env=development", "--fix"])).toEqual({
      env: "development",
      dryRun: true,
      execute: false,
    });
    expect(parseArgs(["--env=development", "--fix", "--execute"])).toEqual({
      env: "development",
      dryRun: false,
      execute: true,
    });
    expect(() => parseArgs(["--env", "staging"])).toThrow(
      "Expected development or production"
    );
  });

  it("reports duplicate authUserId values without mutating data", () => {
    expect(
      duplicateAuthUserIds([
        { id: 1, authUserId: 7 },
        { id: 2, authUserId: 7 },
        { id: 3, authUserId: 8 },
      ])
    ).toEqual([{ authUserId: 7, count: 2 }]);
  });

  it("dry-runs missing local authUserId repair without writing", async () => {
    const envDb = db([
      {
        id: 1,
        username: "alice",
        password: "hashed",
        role: "user",
        authUserId: null,
      },
    ]);
    const authDb = db();
    authDb.users.findFirst.mockResolvedValue({
      id: 91,
      username: "alice",
    });
    const logger = { log: jest.fn(), warn: jest.fn() };

    const summary = await auditSharedAuthIdentity({
      envDb,
      authDb,
      envName: "development",
      dryRun: true,
      logger,
    });

    expect(summary.linkedExisting).toBe(1);
    expect(envDb.users.update).not.toHaveBeenCalled();
    expect(authDb.users.create).not.toHaveBeenCalled();
  });

  it("fix mode links existing shared auth users and creates missing identities", async () => {
    const envDb = db([
      {
        id: 1,
        username: "alice",
        password: "hashed-a",
        role: "user",
        authUserId: null,
      },
      {
        id: 2,
        username: "bob",
        password: "hashed-b",
        role: "admin",
        authUserId: null,
      },
    ]);
    const authDb = db();
    authDb.users.findFirst
      .mockResolvedValueOnce({ id: 91, username: "alice" })
      .mockResolvedValueOnce(null);
    authDb.users.create.mockResolvedValue({ id: 92, username: "bob" });
    const logger = { log: jest.fn(), warn: jest.fn() };

    const summary = await auditSharedAuthIdentity({
      envDb,
      authDb,
      envName: "production",
      dryRun: false,
      logger,
    });

    expect(summary.linkedExisting).toBe(1);
    expect(summary.created).toBe(1);
    expect(envDb.users.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { authUserId: 91, originEnv: "production" },
    });
    expect(envDb.users.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { authUserId: 92, originEnv: "production" },
    });
    expect(authDb.users.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        username: "bob",
        password: "hashed-b",
        originEnv: "production",
      }),
    });
  });
});
