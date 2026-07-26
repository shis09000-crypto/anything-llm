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
const { isoCBOR } = require("@simplewebauthn/server/helpers");

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
    nativeWebHandoffFromQuery,
    nativeWebPasskeyPage,
    nativeWebPasskeyRegistrationPage,
    normalizeNativeHandoffPurpose,
    normalizeBase64Url,
    passkeyCryptoMetadata,
    providerMetadata,
    resetRateLimits,
    sanitizePasskey,
    safeOpaqueEqual,
    sha256Base64Url,
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

  it("validates the native web handoff and binds it to PKCE", () => {
    const verifier = "v".repeat(48);
    const codeChallenge = sha256Base64Url(verifier);
    expect(
      nativeWebHandoffFromQuery({
        state: "s".repeat(32),
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      })
    ).toEqual({ state: "s".repeat(32), codeChallenge, purpose: "login" });
    expect(safeOpaqueEqual(sha256Base64Url(verifier), codeChallenge)).toBe(
      true
    );
  });

  it("allows only the native reauthentication purposes used by settings", () => {
    expect(normalizeNativeHandoffPurpose("zk_enroll")).toBe("zk_enroll");
    expect(normalizeNativeHandoffPurpose("sensitive_memory_reveal")).toBe(
      "sensitive_memory_reveal"
    );
    expect(() => normalizeNativeHandoffPurpose("account_delete")).toThrow(
      "Unsupported native handoff purpose"
    );
  });

  it("returns failed passkey ceremonies to the native callback", () => {
    const page = nativeWebPasskeyPage({
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      purpose: "zk_enroll",
    });
    expect(page).toContain('error:"passkey_failed"');
    expect(page).toContain('window.location.replace("athena://auth/callback?"');
    expect(page).toContain('"purpose":"zk_enroll"');
  });

  it("keeps native passkey registration on the Athena origin and returns to the app", () => {
    const page = nativeWebPasskeyRegistrationPage({
      handoff: "h".repeat(43),
      state: "s".repeat(32),
    });
    expect(page).toContain("/api/auth/passkeys/native-register/options");
    expect(page).toContain("/api/auth/passkeys/native-register/verify");
    expect(page).toContain("passkey_registration_failed");
    expect(page).toContain('window.location.replace("athena://auth/callback?"');
    expect(page).not.toContain("Authorization");
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
      algorithm: "ES256",
      parameterSet: "P-256",
      keyOrigin: "synced-passkey-provider",
      hardwareProtection: "not-attested",
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
      algorithm: "ES256",
      parameterSet: "P-256",
      keyOrigin: "synced-passkey-provider",
      hardwareProtection: "not-attested",
      transports: ["internal"],
      createdAt: expect.any(Date),
      lastUsedAt: null,
    });
    expect(sanitized.publicKey).toBeUndefined();
    expect(sanitized.credentialId).toBeUndefined();
  });

  it("records WebAuthn COSE algorithm metadata without claiming attestation", async () => {
    const coseKey = await isoCBOR.encode(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.alloc(32, 1)],
        [-3, Buffer.alloc(32, 2)],
      ])
    );

    expect(
      passkeyCryptoMetadata(coseKey, {
        credentialBackedUp: false,
        deviceType: "platform",
      })
    ).toEqual({
      algorithm: "ES256",
      parameterSet: "P-256",
      keyOrigin: "platform-authenticator",
      hardwareProtection: "not-attested",
    });
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
