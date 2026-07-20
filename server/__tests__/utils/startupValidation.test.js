const {
  assertProductionSecurityConfig,
  productionSecurityFindings,
} = require("../../utils/security/startupValidation");

const secureProductionEnv = {
  NODE_ENV: "production",
  ENABLE_HTTPS: "true",
  JWT_SECRET: "jwt_secret_value_that_is_long_enough_123",
  AUTH_TOKEN: "auth_token_value_that_is_long_enough_123",
  PUBLIC_APP_URL: "https://athena.example.com",
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

  it("rejects disabled sessions, weak realtime auth, and non-strict readiness", () => {
    const findings = productionSecurityFindings({
      ...secureProductionEnv,
      ATHENA_SESSION_V2: "false",
      ATHENA_REALTIME_LEGACY_QUERY_TOKEN: "true",
      ATHENA_STRICT_READY: "false",
      REQUEST_SIGNING_DEVICE_REQUIRED: "false",
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Session V2/),
        expect.stringMatching(/query JWT/),
        expect.stringMatching(/Strict readiness/),
        expect.stringMatching(/device signatures/),
      ])
    );
  });

  it("allows legacy query JWT compatibility only with a bounded expiry", () => {
    const expiresSoon = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1_000
    ).toISOString();
    expect(
      productionSecurityFindings({
        ...secureProductionEnv,
        ATHENA_REALTIME_LEGACY_QUERY_TOKEN: "true",
        ATHENA_REALTIME_LEGACY_QUERY_TOKEN_EXPIRES_AT: expiresSoon,
      })
    ).toEqual([]);
    expect(
      productionSecurityFindings({
        ...secureProductionEnv,
        ATHENA_REALTIME_LEGACY_QUERY_TOKEN: "true",
        ATHENA_REALTIME_LEGACY_QUERY_TOKEN_EXPIRES_AT: new Date(
          Date.now() + 60 * 24 * 60 * 60 * 1_000
        ).toISOString(),
      })
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/within the next 30 days/)])
    );
  });

  it("rejects a process-local realtime ticket store in production", () => {
    expect(
      productionSecurityFindings({
        ...secureProductionEnv,
        ATHENA_REALTIME_TICKET_STORE: "memory",
      })
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/shared database store/)])
    );
  });

  it("fails closed when enterprise release evidence is absent", () => {
    expect(
      productionSecurityFindings({
        ...secureProductionEnv,
        ATHENA_ENTERPRISE_RELEASE_GATE: "true",
      })
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ATHENA_EDGE_SECURITY_EVIDENCE_FILE/),
        expect.stringMatching(/ATHENA_DR_EVIDENCE_FILE/),
      ])
    );
  });

  it("accepts an external key provider only with a lease path", () => {
    expect(
      productionSecurityFindings({
        ...secureProductionEnv,
        ENCRYPTION_MASTER_KEY: "",
        ATHENA_KEY_PROVIDER: "vault-agent",
      })
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/ATHENA_KEY_LEASE_FILE/)])
    );
    expect(
      productionSecurityFindings({
        ...secureProductionEnv,
        ENCRYPTION_MASTER_KEY: "",
        ATHENA_KEY_PROVIDER: "vault-agent",
        ATHENA_KEY_LEASE_FILE: "/run/secrets/key-lease.json",
      })
    ).toEqual([]);
  });
});
