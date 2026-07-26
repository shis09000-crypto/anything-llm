describe("password credential runtime contract", () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock("../../utils/security/passwordCredential");
  });

  it("uses the governed credential policy when the full module is present", () => {
    const {
      assertPasswordCredentialRuntime,
    } = require("../../utils/security/passwordCredentialRuntime");
    const runtime = assertPasswordCredentialRuntime();

    expect(runtime.compatibilityFallback).toBe(false);
    expect(
      runtime.canUsePasswordCredential({
        credentialType: "passkey_only",
        password: "$2b$10$ignored",
      })
    ).toBe(false);
  });

  it("keeps password login available during a mixed-version rollout", () => {
    jest.resetModules();
    jest.doMock("../../utils/security/passwordCredential", () => ({
      dummyPasswordCompare: jest.fn(),
      passwordHashKind: (encoded = "") =>
        encoded.startsWith("$argon2id$") ? "argon2id" : "unknown",
      verifyPassword: jest.fn(),
    }));

    const {
      assertPasswordCredentialRuntime,
    } = require("../../utils/security/passwordCredentialRuntime");
    const runtime = assertPasswordCredentialRuntime();

    expect(runtime.compatibilityFallback).toBe(true);
    expect(
      runtime.canUsePasswordCredential({
        password: "$argon2id$v=19$m=65536,t=3,p=1$hash",
      })
    ).toBe(true);
    expect(
      runtime.canUsePasswordCredential({ password: "historical-value" })
    ).toBe(false);
  });

  it("fails closed when a required password primitive is unavailable", () => {
    jest.resetModules();
    jest.doMock("../../utils/security/passwordCredential", () => ({
      passwordHashKind: jest.fn(() => "argon2id"),
      verifyPassword: jest.fn(),
    }));

    const {
      assertPasswordCredentialRuntime,
    } = require("../../utils/security/passwordCredentialRuntime");

    expect(() => assertPasswordCredentialRuntime()).toThrow(
      "password_credential_runtime_contract_missing:dummyPasswordCompare"
    );
  });
});
