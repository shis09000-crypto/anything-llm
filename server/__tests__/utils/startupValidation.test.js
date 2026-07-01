const {
  assertProductionSecurityConfig,
  productionSecurityFindings,
} = require("../../utils/security/startupValidation");

const secureProductionEnv = {
  NODE_ENV: "production",
  ENABLE_HTTPS: "true",
  JWT_SECRET: "jwt_secret_value_that_is_long_enough_123",
  AUTH_TOKEN: "auth_token_value_that_is_long_enough_123",
  ENCRYPTION_MASTER_KEY:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

describe("production startup security validation", () => {
  it("accepts a hardened direct HTTPS production configuration", () => {
    expect(assertProductionSecurityConfig(secureProductionEnv)).toEqual({
      production: true,
    });
  });

  it("rejects production warn-only request signing and missing secrets", () => {
    const findings = productionSecurityFindings({
      NODE_ENV: "production",
      ENABLE_HTTPS: "true",
      ATHENA_SIGNING_WARN_ONLY: "true",
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/JWT_SECRET is required/),
        expect.stringMatching(/AUTH_TOKEN is required/),
        expect.stringMatching(/ENCRYPTION_MASTER_KEY is required/),
        expect.stringMatching(/ATHENA_SIGNING_WARN_ONLY/),
      ])
    );
  });

  it("rejects dev bypass configuration in production", () => {
    expect(() =>
      assertProductionSecurityConfig({
        ...secureProductionEnv,
        CODEX_DEV_AUTH_BYPASS_KEY: "dev-only-key",
      })
    ).toThrow(/Codex dev auth bypass/);
  });
});
