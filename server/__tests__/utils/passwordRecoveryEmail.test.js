const bcrypt = require("bcryptjs");

const mockUserGet = jest.fn();
const mockUserUpdate = jest.fn();
const mockRecoveryCreateMany = jest.fn();
const mockPasswordResetCreate = jest.fn();
const mockLatestCode = jest.fn();
const mockLatestPending = jest.fn();
const mockConsumeCode = jest.fn();
const mockIncrementAttempts = jest.fn();
const mockExpireOpenCodes = jest.fn();
const mockCreateCode = jest.fn();
const mockLogEvent = jest.fn();
const mockSendVerificationCode = jest.fn();
const mockSendSecurityNotification = jest.fn();
const mockSmtpConfigured = jest.fn();
const mockAuthFindByLoginIdentifier = jest.fn();
const mockAuthEnsureShadowUser = jest.fn();
const mockAuthCanLoginInCurrentEnv = jest.fn();
const mockAuthBootstrapFromShadow = jest.fn();

jest.mock("../../models/user", () => ({
  User: {
    _get: mockUserGet,
    _update: mockUserUpdate,
    update: jest.fn(),
  },
}));

jest.mock("../../models/passwordRecovery", () => ({
  RecoveryCode: {
    createMany: mockRecoveryCreateMany,
    deleteMany: jest.fn(),
    hashesForUser: jest.fn(),
  },
  PasswordResetToken: {
    create: mockPasswordResetCreate,
    findUnique: jest.fn(),
    deleteMany: jest.fn(),
  },
}));

jest.mock("../../models/emailVerification", () => ({
  EmailVerificationCode: {
    maxAttempts: 5,
    resendCooldownMs: 60_000,
    latest: mockLatestCode,
    latestPendingForUser: mockLatestPending,
    consume: mockConsumeCode,
    incrementAttempts: mockIncrementAttempts,
    expireOpenCodes: mockExpireOpenCodes,
    create: mockCreateCode,
  },
}));

jest.mock("../../models/authIdentity", () => ({
  AuthIdentity: {
    findByLoginIdentifier: mockAuthFindByLoginIdentifier,
    ensureShadowUser: mockAuthEnsureShadowUser,
    canLoginInCurrentEnv: mockAuthCanLoginInCurrentEnv,
    bootstrapAuthUserFromShadow: mockAuthBootstrapFromShadow,
  },
}));

jest.mock("../../models/eventLogs", () => ({
  EventLogs: {
    logEvent: mockLogEvent,
  },
}));

jest.mock("../../utils/email/mailer", () => ({
  isConfigured: mockSmtpConfigured,
  maskedEmail: jest.fn((email) => (email ? "m***@example.com" : "")),
  sendVerificationCode: mockSendVerificationCode,
  sendSecurityNotification: mockSendSecurityNotification,
}));

describe("email password recovery", () => {
  let recovery;
  const hashedPassword = bcrypt.hashSync("correct-password", 10);
  const user = {
    id: 1,
    username: "alice",
    password: hashedPassword,
    email: "alice@example.com",
    email_verified_at: new Date(),
    suspended: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    recovery = require("../../utils/PasswordRecovery");
    recovery._private.rateBuckets.clear();
    mockSmtpConfigured.mockReturnValue(true);
    mockSendVerificationCode.mockResolvedValue(true);
    mockSendSecurityNotification.mockResolvedValue(true);
    mockCreateCode.mockResolvedValue({
      verification: { id: 10, createdAt: new Date() },
      error: null,
    });
    mockExpireOpenCodes.mockResolvedValue(true);
    mockConsumeCode.mockResolvedValue(true);
    mockIncrementAttempts.mockResolvedValue(true);
    mockPasswordResetCreate.mockResolvedValue({
      passwordResetToken: { token: "reset-token" },
      error: null,
    });
    mockRecoveryCreateMany.mockResolvedValue({
      recoveryCodes: [],
      error: null,
    });
    mockAuthFindByLoginIdentifier.mockResolvedValue(null);
    mockAuthEnsureShadowUser.mockImplementation(async (authUser) => authUser);
    mockAuthCanLoginInCurrentEnv.mockReturnValue(true);
    mockAuthBootstrapFromShadow.mockResolvedValue(null);
  });

  test("binding email no longer requires current password", async () => {
    mockUserGet
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce(null);

    const result = await recovery.requestAuthenticatedEmailVerification({
      userId: user.id,
      email: "new@example.com",
      ip: "127.0.0.1",
    });

    expect(result).toEqual({
      success: true,
      pendingEmail: "new@example.com",
      resendCooldownSeconds: 60,
    });
    expect(mockSendVerificationCode).toHaveBeenCalledTimes(1);
    expect(mockCreateCode).toHaveBeenCalledTimes(1);
    expect(mockExpireOpenCodes).toHaveBeenCalledWith({
      userId: user.id,
      purpose: "bind_email",
    });
  });

  test("binding email request is blocked during resend cooldown", async () => {
    mockUserGet.mockResolvedValueOnce(user).mockResolvedValueOnce(null);
    mockLatestCode.mockResolvedValue({
      id: 22,
      createdAt: new Date(Date.now() - 10_000),
      consumedAt: null,
    });

    const result = await recovery.requestAuthenticatedEmailVerification({
      userId: user.id,
      email: "new@example.com",
      ip: "127.0.0.1",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("verification_resend_cooldown");
    expect(result.resendCooldownSeconds).toBeGreaterThan(0);
    expect(mockSendVerificationCode).not.toHaveBeenCalled();
    expect(mockExpireOpenCodes).not.toHaveBeenCalled();
  });

  test("binding email can resend after cooldown and invalidates open codes", async () => {
    mockUserGet.mockResolvedValueOnce(user).mockResolvedValueOnce(null);
    mockLatestCode.mockResolvedValue({
      id: 22,
      createdAt: new Date(Date.now() - 61_000),
      consumedAt: null,
    });

    const result = await recovery.requestAuthenticatedEmailVerification({
      userId: user.id,
      email: "new@example.com",
      ip: "127.0.0.1",
    });

    expect(result).toEqual({
      success: true,
      pendingEmail: "new@example.com",
      resendCooldownSeconds: 60,
    });
    expect(mockExpireOpenCodes).toHaveBeenCalledWith({
      userId: user.id,
      purpose: "bind_email",
    });
    expect(mockSendVerificationCode).toHaveBeenCalledTimes(1);
  });

  test("unverified email cannot request a password reset code", async () => {
    mockUserGet.mockResolvedValue({ ...user, email_verified_at: null });

    const result = await recovery.requestEmailPasswordReset({
      username: user.username,
      email: user.email,
      ip: "127.0.0.1",
    });

    expect(result).toEqual({
      success: true,
      message: recovery.EMAIL_RECOVERY_GENERIC_RESPONSE,
      resendCooldownSeconds: 60,
    });
    expect(mockSendVerificationCode).not.toHaveBeenCalled();
  });

  test("valid email reset code is consumed before issuing a reset token", async () => {
    mockUserGet.mockResolvedValue(user);
    mockLatestCode.mockResolvedValue({
      id: 22,
      code_hash: bcrypt.hashSync("123456", 10),
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });

    const result = await recovery.confirmEmailPasswordReset({
      username: user.username,
      email: user.email,
      code: "123456",
      ip: "127.0.0.1",
    });

    expect(result).toEqual({ success: true, resetToken: "reset-token" });
    expect(mockConsumeCode).toHaveBeenCalledWith(22);
    expect(mockPasswordResetCreate).toHaveBeenCalledWith(user.id);
  });

  test("consumed email reset code cannot issue another reset token", async () => {
    mockUserGet.mockResolvedValue(user);
    mockLatestCode.mockResolvedValue({
      id: 22,
      code_hash: bcrypt.hashSync("123456", 10),
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });

    const result = await recovery.confirmEmailPasswordReset({
      username: user.username,
      email: user.email,
      code: "123456",
      ip: "127.0.0.1",
    });

    expect(result).toEqual({
      success: false,
      error: "Verification code already used. Please request a new code.",
      errorCode: "verification_code_consumed",
    });
    expect(mockPasswordResetCreate).not.toHaveBeenCalled();
  });

  test("expired email reset code returns an expired-code error", async () => {
    mockUserGet.mockResolvedValue(user);
    mockLatestCode.mockResolvedValue({
      id: 22,
      code_hash: bcrypt.hashSync("123456", 10),
      consumedAt: null,
      expiresAt: new Date(Date.now() - 60_000),
      attempts: 0,
    });

    const result = await recovery.confirmEmailPasswordReset({
      username: user.username,
      email: user.email,
      code: "123456",
      ip: "127.0.0.1",
    });

    expect(result).toEqual({
      success: false,
      error: "Verification code expired. Please request a new code.",
      errorCode: "verification_code_expired",
    });
    expect(mockPasswordResetCreate).not.toHaveBeenCalled();
  });

  test("verification success audit log does not include the plain code", async () => {
    mockUserGet.mockResolvedValue(user);
    mockLatestCode.mockResolvedValue({
      id: 22,
      code_hash: bcrypt.hashSync("123456", 10),
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });

    await recovery.confirmEmailPasswordReset({
      username: user.username,
      email: user.email,
      code: "123456",
      ip: "127.0.0.1",
    });

    const loggedPayloads = mockLogEvent.mock.calls.map((call) =>
      JSON.stringify(call)
    );
    expect(loggedPayloads.join("\n")).not.toContain("123456");
  });

  test("generated recovery codes are stored against shared authUserId", async () => {
    mockUserGet.mockResolvedValue({ ...user, authUserId: 91 });
    mockUserUpdate.mockResolvedValue({
      user: { ...user, authUserId: 91, seen_recovery_codes: true },
    });

    const codes = await recovery.generateRecoveryCodes(user.id);

    expect(codes).toHaveLength(4);
    expect(mockRecoveryCreateMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: 91,
          code_hash: expect.any(String),
        }),
      ])
    );
    expect(mockUserUpdate).toHaveBeenCalledWith(user.id, {
      seen_recovery_codes: true,
    });
  });
});
