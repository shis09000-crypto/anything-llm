const mockAuthIdentity = {
  findById: jest.fn(),
  findByLoginIdentifier: jest.fn(),
  canLoginInCurrentEnvAsync: jest.fn(),
  ensureShadowUser: jest.fn(),
  repairPasswordFromLocalShadow: jest.fn(),
};
const mockUser = {
  _get: jest.fn(),
};

jest.mock("../../models/authIdentity", () => ({
  AuthIdentity: mockAuthIdentity,
}));

jest.mock("../../models/user", () => ({
  User: mockUser,
}));

const {
  AuthIdentityRepository,
} = require("../../repositories/authIdentityRepository");

describe("AuthIdentityRepository", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("describeSyncPolicy makes shared auth and shadow user roles explicit", () => {
    const policy = AuthIdentityRepository.describeSyncPolicy();

    expect(policy).toMatchObject({
      sourceOfTruth: "shared-auth",
      localShadowPurpose: "runtime-compatibility-and-legacy-joins",
    });
    expect(policy.password).toMatchObject({
      source: "shared-auth",
      exposePlaintext: false,
    });
    expect(policy.authToShadowFields).toContain("username");
    expect(policy.forbidden).toContain("authorization");
  });

  test("findById returns a redacted auth user summary", async () => {
    mockAuthIdentity.findById.mockResolvedValueOnce({
      id: 9,
      username: "alice",
      password: "secret",
      role: "admin",
      status: "active",
      allowedEnvs: '["production"]',
      originEnv: "production",
    });

    const result = await AuthIdentityRepository.findById(9);

    expect(result).toMatchObject({
      id: 9,
      username: "alice",
      role: "admin",
      status: "active",
      originEnv: "production",
    });
    expect(result.password).toBeUndefined();
  });

  test("shadowForAuthUser returns null without a finite auth user id", async () => {
    await expect(AuthIdentityRepository.shadowForAuthUser({})).resolves.toBeNull();
    expect(mockUser._get).not.toHaveBeenCalled();
  });
});
