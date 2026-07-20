/* eslint-env jest */

const mockStatus = jest.fn();
const mockHit = jest.fn();
const mockClear = jest.fn();

jest.mock("../../models/emailVerification", () => ({
  EmailVerificationRateLimit: {
    status: mockStatus,
    hit: mockHit,
    clear: mockClear,
  },
}));

const {
  checkLoginAllowed,
  clearLoginSuccess,
  dummyPasswordCompare,
  recordLoginFailure,
} = require("../../utils/authLoginRateLimit");

describe("authLoginRateLimit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStatus.mockResolvedValue({
      blocked: false,
      retryAfterSeconds: 0,
      count: 0,
    });
    mockHit.mockResolvedValue(false);
    mockClear.mockResolvedValue({ count: 1 });
  });

  it("checks and increments the IP, identifier and combined buckets", async () => {
    const context = { ip: "127.0.0.1", identifier: "User@Example.com" };
    await expect(checkLoginAllowed(context)).resolves.toMatchObject({
      allowed: true,
    });
    await recordLoginFailure(context);
    expect(mockStatus).toHaveBeenCalledTimes(6);
    expect(mockHit).toHaveBeenCalledTimes(3);
  });

  it("clears identifier-scoped history after a successful login", async () => {
    await clearLoginSuccess({ ip: "127.0.0.1", identifier: "user" });
    expect(mockClear).toHaveBeenCalledTimes(2);
    expect(mockClear).not.toHaveBeenCalledWith(
      expect.objectContaining({ bucketType: "ip" })
    );
  });

  it("performs a fixed-cost dummy bcrypt comparison", async () => {
    await expect(dummyPasswordCompare("unknown-password")).resolves.toBe(false);
  });
});
