const mockTempTokens = {
  create: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
  findUnique: jest.fn(),
};

jest.mock("../../utils/prisma", () => ({
  temporary_auth_tokens: mockTempTokens,
}));

jest.mock("../../utils/sessionIdle", () => ({
  issueUserSessionToken: jest.fn(() => "session-jwt"),
  sessionTokenOptionsFromClientContext: jest.fn(() => ({ clientId: "client-1" })),
}));

describe("TemporaryAuthToken security storage", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockTempTokens.create.mockResolvedValue({});
    mockTempTokens.delete.mockResolvedValue({});
    mockTempTokens.deleteMany.mockResolvedValue({});
  });

  it("stores issued temporary auth tokens as hashes", async () => {
    const {
      TemporaryAuthToken,
      _private: { hashTemporaryAuthToken },
    } = require("../../models/temporaryAuthToken");

    const { token, error } = await TemporaryAuthToken.issue(42);
    const stored = mockTempTokens.create.mock.calls[0][0].data.token;

    expect(error).toBeNull();
    expect(token).toMatch(/^allm-tat-/);
    expect(stored).toBe(hashTemporaryAuthToken(token));
    expect(stored).not.toBe(token);
    expect(stored).toMatch(/^sha256:v1:/);
  });

  it("validates hashed temporary auth tokens and deletes them after use", async () => {
    const {
      TemporaryAuthToken,
      _private: { hashTemporaryAuthToken },
    } = require("../../models/temporaryAuthToken");
    const publicToken = "allm-tat-public-token";
    const storedToken = {
      id: 99,
      token: hashTemporaryAuthToken(publicToken),
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 42, username: "user", suspended: 0 },
    };
    mockTempTokens.findUnique.mockResolvedValueOnce(storedToken);

    const result = await TemporaryAuthToken.validate(publicToken, {
      clientContext: { clientId: "client-1" },
    });

    expect(mockTempTokens.findUnique).toHaveBeenCalledWith({
      where: { token: hashTemporaryAuthToken(publicToken) },
      include: { user: true },
    });
    expect(result.sessionToken).toBe("session-jwt");
    expect(mockTempTokens.delete).toHaveBeenCalledWith({ where: { id: 99 } });
  });

  it("keeps backward compatibility for unexpired legacy plaintext tokens", async () => {
    const { TemporaryAuthToken } = require("../../models/temporaryAuthToken");
    const publicToken = "allm-tat-legacy-token";
    const legacyToken = {
      id: 100,
      token: publicToken,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 42, username: "user", suspended: 0 },
    };
    mockTempTokens.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyToken);

    const result = await TemporaryAuthToken.validate(publicToken);

    expect(result.sessionToken).toBe("session-jwt");
    expect(mockTempTokens.findUnique.mock.calls[1][0]).toEqual({
      where: { token: publicToken },
      include: { user: true },
    });
    expect(mockTempTokens.delete).toHaveBeenCalledWith({ where: { id: 100 } });
  });
});
