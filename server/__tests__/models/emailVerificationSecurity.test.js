const bcrypt = require("bcryptjs");

const mockCreateVerification = jest.fn();
const mockFindVerification = jest.fn();
const mockCreateGrant = jest.fn();
const mockFindGrant = jest.fn();
const mockFindRateLimit = jest.fn();
const mockCreateRateLimit = jest.fn();
const mockUpdateRateLimit = jest.fn();

jest.mock("../../utils/authPrisma", () => ({
  email_verification_codes: {
    create: mockCreateVerification,
    findUnique: mockFindVerification,
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  email_verification_grants: {
    create: mockCreateGrant,
    findUnique: mockFindGrant,
    updateMany: jest.fn(),
  },
  email_verification_rate_limits: {
    create: mockCreateRateLimit,
    findUnique: mockFindRateLimit,
    update: mockUpdateRateLimit,
  },
}));

describe("EmailVerificationCode security", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.EMAIL_VERIFICATION_HMAC_SECRET = "test-email-hmac-secret";
  });

  afterEach(() => {
    delete process.env.EMAIL_VERIFICATION_HMAC_SECRET;
  });

  test("stores an HMAC verification code with challenge metadata", async () => {
    mockCreateVerification.mockImplementation(async ({ data }) => ({
      id: 1,
      ...data,
      createdAt: new Date(),
    }));

    const { EmailVerificationCode } = require("../../models/emailVerification");
    const { verification, error } = await EmailVerificationCode.create({
      userId: null,
      email: "user@example.com",
      purpose: "register",
      code: "123456",
      requestIp: "127.0.0.1",
      clientId: "client-1",
      deviceId: "client-1",
      sessionId: "request-1",
    });

    expect(error).toBeNull();
    expect(verification.challenge_id).toEqual(expect.any(String));
    expect(mockCreateVerification).toHaveBeenCalledWith({
      data: expect.objectContaining({
        code_hash: expect.stringMatching(/^hmac-sha256:v1:/),
        challenge_id: expect.any(String),
        client_id: "client-1",
        device_id: "client-1",
        session_id: "request-1",
      }),
    });
    expect(mockCreateVerification.mock.calls[0][0].data.code_hash).not.toContain(
      "123456"
    );
  });

  test("verifies new HMAC codes and legacy bcrypt codes", () => {
    const {
      EmailVerificationCode,
      _private: { hmacCode },
    } = require("../../models/emailVerification");

    expect(EmailVerificationCode.verifyCode("123456", hmacCode("123456"))).toBe(
      true
    );
    expect(EmailVerificationCode.verifyCode("654321", hmacCode("123456"))).toBe(
      false
    );

    const legacyHash = bcrypt.hashSync("123456", 10);
    expect(EmailVerificationCode.verifyCode("123456", legacyHash)).toBe(true);
  });

  test("finds verification codes by challenge only when metadata matches", async () => {
    mockFindVerification.mockResolvedValue({
      id: 3,
      user_id: 42,
      challenge_id: "challenge-1",
      email: "user@example.com",
      purpose: "password_reset",
    });

    const { EmailVerificationCode } = require("../../models/emailVerification");
    const found = await EmailVerificationCode.findByChallenge({
      challengeId: "challenge-1",
      userId: 42,
      email: "user@example.com",
      purpose: "password_reset",
    });
    const wrongEmail = await EmailVerificationCode.findByChallenge({
      challengeId: "challenge-1",
      userId: 42,
      email: "other@example.com",
      purpose: "password_reset",
    });

    expect(found?.id).toBe(3);
    expect(wrongEmail).toBeNull();
    expect(mockFindVerification).toHaveBeenCalledWith({
      where: { challenge_id: "challenge-1" },
    });
  });

  test("stores password reset grants as hashes and returns only the plain token to caller", async () => {
    mockCreateGrant.mockImplementation(async ({ data }) => ({
      id: 9,
      ...data,
      createdAt: new Date(),
    }));

    const { EmailVerificationGrant } = require("../../models/emailVerification");
    const { grant, error } = await EmailVerificationGrant.create({
      userId: 42,
      purpose: "password_reset",
      scope: "password_reset",
      email: "user@example.com",
      challengeId: "challenge-1",
      clientId: "client-1",
      deviceId: "device-1",
      sessionId: "session-1",
    });

    expect(error).toBeNull();
    expect(grant.token).toMatch(/^evg_/);
    expect(mockCreateGrant).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 42,
        purpose: "password_reset",
        scope: "password_reset",
        grant_hash: expect.stringMatching(/^grant-hmac-sha256:v1:/),
        challenge_id: "challenge-1",
        client_id: "client-1",
        device_id: "device-1",
        session_id: "session-1",
      }),
    });
    expect(mockCreateGrant.mock.calls[0][0].data.grant_hash).not.toContain(
      grant.token
    );
  });

  test("invalid legacy bcrypt payloads fail closed", () => {
    const { EmailVerificationCode } = require("../../models/emailVerification");

    expect(EmailVerificationCode.verifyCode("123456", "not-a-bcrypt-hash")).toBe(
      false
    );
  });

  test("rate limit buckets store only keyed hashes, not raw email or IP", async () => {
    mockFindRateLimit.mockResolvedValue(null);
    mockCreateRateLimit.mockResolvedValue({ id: 1 });

    const { EmailVerificationRateLimit } = require("../../models/emailVerification");
    const limited = await EmailVerificationRateLimit.hit({
      bucketType: "email",
      purpose: "password_reset",
      value: "user@example.com",
      limit: 5,
      windowMs: 60_000,
    });

    expect(limited).toBe(false);
    expect(mockCreateRateLimit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bucket_hash: expect.stringMatching(/^rl-hmac-sha256:v1:/),
        bucket_type: "email",
        purpose: "password_reset",
        count: 1,
      }),
    });
    expect(mockCreateRateLimit.mock.calls[0][0].data.bucket_hash).not.toContain(
      "user@example.com"
    );
  });

  test("rate limit bucket creation tolerates first-write races", async () => {
    mockFindRateLimit
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        bucket_hash: "bucket",
        bucket_type: "email",
        purpose: "password_reset",
        window_start: new Date(),
        count: 1,
        blockedUntil: null,
      });
    mockCreateRateLimit.mockRejectedValueOnce({ code: "P2002" });
    mockUpdateRateLimit.mockResolvedValue({ id: 1 });

    const { EmailVerificationRateLimit } = require("../../models/emailVerification");
    const limited = await EmailVerificationRateLimit.hit({
      bucketType: "email",
      purpose: "password_reset",
      value: "user@example.com",
      limit: 5,
      windowMs: 60_000,
    });

    expect(limited).toBe(false);
    expect(mockUpdateRateLimit).toHaveBeenCalledWith({
      where: { bucket_hash: expect.stringMatching(/^rl-hmac-sha256:v1:/) },
      data: { count: { increment: 1 }, updatedAt: expect.any(Date) },
    });
  });
});
