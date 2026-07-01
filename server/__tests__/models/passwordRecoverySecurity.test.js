const mockCreateResetToken = jest.fn();
const mockFindResetToken = jest.fn();
const mockDeleteResetTokens = jest.fn();

jest.mock("../../utils/authPrisma", () => ({
  password_reset_tokens: {
    create: mockCreateResetToken,
    findUnique: mockFindResetToken,
    deleteMany: mockDeleteResetTokens,
  },
  recovery_codes: {
    create: jest.fn(),
    createMany: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  $transaction: jest.fn(),
}));

describe("PasswordResetToken security", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("stores only a hashed reset token while returning the one-time token", async () => {
    mockCreateResetToken.mockImplementation(async ({ data }) => ({
      id: 1,
      ...data,
      createdAt: new Date(),
    }));

    const { PasswordResetToken } = require("../../models/passwordRecovery");
    const { passwordResetToken, error } = await PasswordResetToken.create(7);

    expect(error).toBeNull();
    expect(passwordResetToken.token).toMatch(/^prt_/);
    expect(mockCreateResetToken).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 7,
        token: expect.stringMatching(/^sha256:v1:/),
      }),
    });
    expect(mockCreateResetToken.mock.calls[0][0].data.token).not.toBe(
      passwordResetToken.token
    );
  });

  test("hashes submitted reset tokens before lookup and falls back for legacy tokens", async () => {
    const { PasswordResetToken } = require("../../models/passwordRecovery");
    mockFindResetToken.mockResolvedValueOnce({ id: 9, user_id: 7 });

    await PasswordResetToken.findUnique({ token: "prt_submitted" });
    expect(mockFindResetToken).toHaveBeenCalledWith({
      where: { token: expect.stringMatching(/^sha256:v1:/) },
    });

    mockFindResetToken.mockClear();
    mockFindResetToken
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 10, user_id: 7, token: "legacy" });

    const legacy = await PasswordResetToken.findUnique({ token: "legacy" });
    expect(legacy.id).toBe(10);
    expect(mockFindResetToken).toHaveBeenNthCalledWith(2, {
      where: { token: "legacy" },
    });
  });
});
