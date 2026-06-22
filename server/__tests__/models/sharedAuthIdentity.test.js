const mockPrismaUserCreate = jest.fn();
const mockPrismaUserFindFirst = jest.fn();
const mockPrismaUserUpdate = jest.fn();
const mockAuthUserCreate = jest.fn();

jest.mock("../../utils/prisma", () => ({
  users: {
    create: mockPrismaUserCreate,
    findFirst: mockPrismaUserFindFirst,
    update: mockPrismaUserUpdate,
  },
}));

jest.mock("../../utils/authPrisma", () => ({
  users: {
    create: mockAuthUserCreate,
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  authEnvironmentDeletion: {
    findUnique: jest.fn(),
  },
}));

jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));

describe("shared auth identity binding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it("creates a shared auth user before persisting the local shadow user", async () => {
    const { User } = require("../../models/user");
    mockAuthUserCreate.mockResolvedValue({
      id: 91,
      username: "alice",
      role: "user",
      status: "active",
      allowedEnvs: '["development","production"]',
      suspended: 0,
      originEnv: "development",
    });
    mockPrismaUserCreate.mockResolvedValue({
      id: 7,
      authUserId: 91,
      username: "alice",
      role: "user",
      status: "active",
      allowedEnvs: '["development","production"]',
      suspended: 0,
      originEnv: "development",
    });

    const { user, error } = await User.create({
      username: "alice",
      password: "correct-horse-battery-staple",
      role: "user",
      originEnv: "development",
    });

    expect(error).toBeNull();
    expect(user.authUserId).toBe(91);
    expect(mockAuthUserCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        username: "alice",
        password: expect.any(String),
      }),
    });
    expect(mockPrismaUserCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authUserId: 91,
        username: "alice",
        password: expect.any(String),
      }),
    });
  });

  it("syncs the current environment shadow user from a shared auth identity", async () => {
    const { AuthIdentity } = require("../../models/authIdentity");
    mockPrismaUserFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 7,
      authUserId: null,
      username: "alice",
    });
    mockPrismaUserUpdate.mockResolvedValue({
      id: 7,
      authUserId: 91,
      username: "alice",
      role: "user",
      status: "active",
      allowedEnvs: '["development","production"]',
      suspended: 0,
      originEnv: "development",
    });

    const shadow = await AuthIdentity.ensureShadowUser({
      id: 91,
      username: "alice",
      password: "hashed",
      role: "user",
      status: "active",
      allowedEnvs: '["development","production"]',
      suspended: 0,
      originEnv: "development",
    });

    expect(shadow.authUserId).toBe(91);
    expect(mockPrismaUserFindFirst).toHaveBeenNthCalledWith(1, {
      where: { authUserId: 91 },
    });
    expect(mockPrismaUserUpdate).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({
        authUserId: 91,
        username: "alice",
      }),
    });
  });
});
