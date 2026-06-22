jest.mock("../../utils/authPrisma", () => ({
  passkeyChallenge: {
    findFirst: jest.fn(),
    delete: jest.fn(),
  },
  passkeyCredential: {
    count: jest.fn(),
  },
  recovery_codes: {
    count: jest.fn(),
  },
  event_logs: {
    create: jest.fn(),
  },
}));

jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: jest.fn((_request, _response, next) => next()),
}));

const authPrisma = require("../../utils/authPrisma");
const {
  _passkeyTestUtils: {
    base64UrlToBytes,
    bytesToBase64Url,
    challengeFromClientData,
    checkOptionsRateLimit,
    clearVerifyFailures,
    consumeChallenge,
    markVerifyFailure,
    normalizeBase64Url,
    providerMetadata,
    resetRateLimits,
    sanitizePasskey,
    userHandleMatches,
    verifyCooldown,
  },
} = require("../../endpoints/authPasskeys");

describe("passkey security helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRateLimits();
  });

  it("normalizes credential, public key, and challenge values as base64url", () => {
    const raw = Buffer.from("passkey-challenge");
    const encoded = bytesToBase64Url(raw);

    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(base64UrlToBytes(encoded).toString("utf8")).toBe(
      "passkey-challenge"
    );
    expect(normalizeBase64Url(`${encoded}==`)).toBe(encoded);
  });

  it("extracts the WebAuthn challenge from clientDataJSON", () => {
    const challenge = bytesToBase64Url(Buffer.from("challenge-value"));
    const clientDataJSON = bytesToBase64Url(
      Buffer.from(JSON.stringify({ type: "webauthn.get", challenge }))
    );

    expect(challengeFromClientData(clientDataJSON)).toBe(challenge);
  });

  it("deletes a valid challenge immediately when consumed", async () => {
    const record = {
      id: 42,
      challenge: "challenge",
      type: "login",
      userId: null,
    };
    authPrisma.passkeyChallenge.findFirst.mockResolvedValue(record);
    authPrisma.passkeyChallenge.delete.mockResolvedValue(record);

    await expect(
      consumeChallenge({ challenge: "challenge", type: "login" })
    ).resolves.toEqual(record);
    expect(authPrisma.passkeyChallenge.findFirst).toHaveBeenCalledWith({
      where: {
        challenge: "challenge",
        type: "login",
        expiresAt: { gt: expect.any(Date) },
      },
    });
    expect(authPrisma.passkeyChallenge.delete).toHaveBeenCalledWith({
      where: { id: 42 },
    });
  });

  it("does not return raw publicKey in sanitized passkey responses", () => {
    const sanitized = sanitizePasskey({
      id: 1,
      credentialId: "credential",
      publicKey: "public-key",
      deviceName: "Chrome on macOS",
      deviceType: "mac",
      browserName: "Chrome",
      platformName: "macOS",
      provider: "google",
      providerName: "Google Password Manager",
      backedUp: true,
      transports: '["internal"]',
      createdAt: new Date("2026-06-12T00:00:00.000Z"),
      lastUsedAt: null,
    });

    expect(sanitized).toEqual({
      id: 1,
      deviceName: "Chrome on macOS",
      deviceType: "mac",
      browserName: "Chrome",
      platformName: "macOS",
      provider: "google",
      providerName: "Google Password Manager",
      backedUp: true,
      transports: ["internal"],
      createdAt: expect.any(Date),
      lastUsedAt: null,
    });
    expect(sanitized.publicKey).toBeUndefined();
    expect(sanitized.credentialId).toBeUndefined();
  });

  it("recognizes Apple Passwords and managed iCloud Keychain AAGUIDs", () => {
    expect(
      providerMetadata({
        aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
        browserName: "Chrome",
        platformName: "macOS",
      })
    ).toEqual({
      provider: "apple",
      providerName: "Apple Passwords",
    });

    expect(
      providerMetadata({
        aaguid: "dd4ec289-e01d-41c9-bb89-70fa845d4bf2",
        browserName: "Safari",
        platformName: "iOS",
      })
    ).toEqual({
      provider: "apple",
      providerName: "Apple Passwords (Managed)",
    });
  });

  it("uses AAGUID metadata to correct generic stored passkey providers", () => {
    const sanitized = sanitizePasskey({
      id: 2,
      deviceName: "Chrome on macOS",
      deviceType: "mac",
      browserName: "Chrome",
      platformName: "macOS",
      aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
      provider: "browser",
      providerName: "浏览器或平台认证器",
      backedUp: true,
      transports: '["internal"]',
      createdAt: new Date("2026-06-12T00:00:00.000Z"),
      lastUsedAt: null,
    });

    expect(sanitized.provider).toBe("apple");
    expect(sanitized.providerName).toBe("Apple Passwords");
  });

  it("recognizes Google Password Manager and Chrome profile passkey AAGUIDs", () => {
    expect(
      providerMetadata({
        aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
        browserName: "Chrome",
        platformName: "macOS",
      })
    ).toEqual({
      provider: "google",
      providerName: "Google Password Manager",
    });

    expect(
      providerMetadata({
        aaguid: "adce0002-35bc-c60a-648b-0b25f1f05503",
        browserName: "Chrome",
        platformName: "macOS",
      })
    ).toEqual({
      provider: "google",
      providerName: "Chrome Profile Passkey",
    });
  });

  it("matches discoverable passkey userHandle to the credential owner", () => {
    const response = {
      response: {
        userHandle: bytesToBase64Url(Buffer.from("91")),
      },
    };

    expect(userHandleMatches(response, 91)).toBe(true);
    expect(userHandleMatches(response, 7)).toBe(false);
  });

  it("rate limits excessive challenge option requests by IP", () => {
    const ip = "127.0.0.1";

    for (let i = 0; i < 20; i += 1) {
      expect(checkOptionsRateLimit(ip).allowed).toBe(true);
    }
    const limited = checkOptionsRateLimit(ip);
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfter).toBeGreaterThan(0);
  });

  it("cools down an IP after consecutive verify failures", () => {
    const ip = "127.0.0.1";

    for (let i = 0; i < 5; i += 1) markVerifyFailure(ip);
    const cooldown = verifyCooldown(ip);
    expect(cooldown.active).toBe(true);
    expect(cooldown.retryAfter).toBeGreaterThan(0);

    clearVerifyFailures(ip);
    expect(verifyCooldown(ip).active).toBe(false);
  });
});
