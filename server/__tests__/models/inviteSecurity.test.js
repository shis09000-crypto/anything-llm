jest.mock("../../utils/authPrisma", () => ({
  invites: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
}));

const authPrisma = require("../../utils/authPrisma");
const { Invite } = require("../../models/invite");

describe("secure invite model", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stores only a token hash and returns the plaintext token once", async () => {
    authPrisma.invites.create.mockImplementation(async ({ data }) => ({
      id: 1,
      ...data,
      status: "pending",
      claimedBy: null,
      consumedAt: null,
      revokedAt: null,
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
    }));

    const { invite, error } = await Invite.create({
      createdByUserId: 7,
      role: "admin",
      expiresInHours: 24,
    });

    expect(error).toBeNull();
    expect(invite.token).toEqual(expect.any(String));
    expect(invite.tokenHash).toBeUndefined();
    expect(invite.code).toBeUndefined();
    expect(authPrisma.invites.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenHash: Invite.hashToken(invite.token),
        role: "admin",
        createdBy: 7,
        createdByAdminId: 7,
      }),
    });
    expect(authPrisma.invites.create.mock.calls[0][0].data.code).not.toBe(
      invite.token
    );
  });

  it("sanitizes invite list records without token or hash material", () => {
    const sanitized = Invite.publicInvite({
      id: 2,
      code: "legacy-code",
      tokenHash: "hash",
      role: "manager",
      status: "pending",
      createdBy: 1,
      consumedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(sanitized.code).toBeUndefined();
    expect(sanitized.tokenHash).toBeUndefined();
    expect(sanitized.token).toBeUndefined();
    expect(sanitized.role).toBe("admin");
    expect(sanitized.status).toBe("pending");
  });

  it("does not allow owner invites", async () => {
    authPrisma.invites.create.mockImplementation(async ({ data }) => ({
      id: 5,
      ...data,
      status: "pending",
      claimedBy: null,
      consumedAt: null,
      revokedAt: null,
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
    }));

    const { invite, error } = await Invite.create({
      createdByUserId: 7,
      role: "owner",
      expiresInHours: 24,
    });

    expect(error).toBeNull();
    expect(invite.role).toBe("user");
    expect(authPrisma.invites.create.mock.calls[0][0].data.role).toBe("user");
  });


  it("finds new invites by hash and only falls back to legacy plaintext codes", async () => {
    const token = "plain-token";
    const hashedInvite = { id: 3, tokenHash: Invite.hashToken(token) };
    authPrisma.invites.findFirst.mockResolvedValueOnce(hashedInvite);

    await expect(Invite.getByToken(token)).resolves.toBe(hashedInvite);
    expect(authPrisma.invites.findFirst).toHaveBeenCalledWith({
      where: { tokenHash: Invite.hashToken(token) },
    });

    authPrisma.invites.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 4, code: "legacy-token", tokenHash: null });

    await expect(Invite.getByToken("legacy-token")).resolves.toEqual({
      id: 4,
      code: "legacy-token",
      tokenHash: null,
    });
    expect(authPrisma.invites.findFirst).toHaveBeenLastCalledWith({
      where: { code: "legacy-token", tokenHash: null },
    });
  });

  it("does not report an empty invite list when the auth database is unavailable", async () => {
    authPrisma.invites.findMany.mockRejectedValueOnce(
      new Error("auth database offline")
    );

    await expect(Invite.whereWithUsers({})).rejects.toMatchObject({
      code: "database_operation_failed",
      operation: "invite.where",
    });
  });
});
