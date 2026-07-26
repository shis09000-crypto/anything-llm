const crypto = require("crypto");
const {
  CRYPTO_SUITES,
  PURPOSES,
  STATUS,
  cryptoSuite,
  joseAlgorithmsForPurpose,
  preferredCryptoSuite,
  publicCryptoSuites,
  suiteAvailableAt,
  suiteSupportsClient,
  signWithCryptoSuite,
  supportsNodeSignatureSuite,
  validateRegistry,
  verifyWithCryptoSuite,
} = require("../../utils/security/cryptoSuiteRegistry");

describe("Crypto Suite Registry", () => {
  test("requires complete, unique, valid descriptors", () => {
    expect(validateRegistry(CRYPTO_SUITES)).toEqual({
      valid: true,
      errors: [],
    });
    for (const suite of publicCryptoSuites()) {
      expect(suite).toEqual(
        expect.objectContaining({
          suiteId: expect.any(String),
          purpose: expect.any(String),
          parameterSet: expect.any(String),
          keyEncoding: expect.any(String),
          status: expect.any(String),
        })
      );
      expect(
        typeof suite.classicalAlgorithm === "string" ||
          typeof suite.pqAlgorithm === "string"
      ).toBe(true);
      expect(
        suite.signatureEncoding === null ||
          typeof suite.signatureEncoding === "string"
      ).toBe(true);
      expect(suite).toHaveProperty("pqAlgorithm");
      expect(suite).toHaveProperty("minimumClientVersion");
      expect(suite).toHaveProperty("notBefore");
      expect(suite).toHaveProperty("deprecatedAfter");
    }
  });

  test("resolves legacy identifiers only inside the requested purpose", () => {
    expect(
      cryptoSuite("ed25519", {
        purpose: PURPOSES.SECURITY_AUDIT_CHECKPOINT,
      })?.suiteId
    ).toBe("audit-ed25519-v1");
    expect(
      cryptoSuite("ed25519", { purpose: PURPOSES.RELEASE_EVIDENCE })?.suiteId
    ).toBe("release-evidence-ed25519-v1");
    expect(
      cryptoSuite("ed25519", { purpose: PURPOSES.REQUEST_SIGNATURE })
    ).toBeNull();
  });

  test("activates governed hybrid suites without replacing the classical preference", () => {
    expect(
      CRYPTO_SUITES.some(
        (suite) =>
          suite.suiteId === "audit-hybrid-ed25519-mldsa65-v1" &&
          suite.status === STATUS.ACTIVE
      )
    ).toBe(true);
    expect(
      cryptoSuite("audit-hybrid-ed25519-mldsa65-v1", {
        purpose: PURPOSES.SECURITY_AUDIT_CHECKPOINT,
      })
    ).toMatchObject({ pqAlgorithm: "ML-DSA-65" });
    expect(
      preferredCryptoSuite(PURPOSES.SECURITY_AUDIT_CHECKPOINT)?.suiteId
    ).toBe("audit-ed25519-v1");
  });

  test("applies client version and lifecycle gates", () => {
    const suite = {
      minimumClientVersion: "2.3.0",
      status: STATUS.ACTIVE,
      notBefore: "2026-01-01T00:00:00.000Z",
      deprecatedAfter: "2027-01-01T00:00:00.000Z",
    };
    expect(suiteSupportsClient(suite, "2.2.9")).toBe(false);
    expect(suiteSupportsClient(suite, "2.3.0")).toBe(true);
    expect(suiteAvailableAt(suite, Date.parse("2025-12-31T23:59:59Z"))).toBe(
      false
    );
    expect(suiteAvailableAt(suite, Date.parse("2026-06-01T00:00:00Z"))).toBe(
      true
    );
    expect(suiteAvailableAt(suite, Date.parse("2027-01-01T00:00:00Z"))).toBe(
      false
    );
  });

  test("provides an explicit JWT algorithm allowlist", () => {
    expect(joseAlgorithmsForPurpose(PURPOSES.SESSION_JWT)).toEqual(["HS256"]);
  });

  test("registers User Root derivation independently from X-Wing transport", () => {
    expect(
      preferredCryptoSuite(PURPOSES.USER_KEY_DERIVATION, {
        clientVersion: "2.4.0",
      })
    ).toMatchObject({
      suiteId: "user-root-hkdf-sha256-v1",
      classicalAlgorithm: "HKDF-SHA256",
      pqAlgorithm: null,
      keyEncoding: "random-256-bit-user-root",
    });
    expect(
      cryptoSuite("vault-xwing-mldsa65-v1", {
        purpose: PURPOSES.USER_KEY_DERIVATION,
      })
    ).toBeNull();
  });

  test("dispatches active signature implementations and rejects tampering", () => {
    const suite = preferredCryptoSuite(PURPOSES.SECURITY_AUDIT_CHECKPOINT);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const data = Buffer.from("athena-registry-test");
    const signature = signWithCryptoSuite({ suite, data, privateKey });

    expect(supportsNodeSignatureSuite(suite)).toBe(true);
    expect(verifyWithCryptoSuite({ suite, data, publicKey, signature })).toBe(
      true
    );
    expect(
      verifyWithCryptoSuite({
        suite,
        data: Buffer.from("tampered"),
        publicKey,
        signature,
      })
    ).toBe(false);
  });
});
