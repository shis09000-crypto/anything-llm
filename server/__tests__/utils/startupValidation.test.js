const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  assertProductionSecurityConfig,
  productionSecurityFindings,
} = require("../../utils/security/startupValidation");

const pepperDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "athena-startup-validation-")
);
const pepperFile = path.join(pepperDirectory, "password-pepper");
fs.writeFileSync(pepperFile, Buffer.alloc(32, 7), { mode: 0o600 });

const secureProductionEnv = {
  NODE_ENV: "production",
  ENABLE_HTTPS: "true",
  JWT_SECRET: "jwt_secret_value_that_is_long_enough_123",
  AUTH_TOKEN: "auth_token_value_that_is_long_enough_123",
  PUBLIC_APP_URL: "https://athena.example.com",
  ATHENA_PASSWORD_PEPPER_FILE: pepperFile,
  ENCRYPTION_MASTER_KEY:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

describe("production startup security validation", () => {
  afterAll(() => {
    fs.rmSync(pepperDirectory, { recursive: true, force: true });
  });

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
        expect.stringMatching(/ATHENA_PASSWORD_PEPPER_FILE/),
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

  it("rejects an unreadable or unsafe password pepper file", () => {
    expect(
      productionSecurityFindings({
        ...secureProductionEnv,
        ATHENA_PASSWORD_PEPPER_FILE: path.join(pepperDirectory, "missing"),
      })
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/owner-only permissions/)])
    );
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
    const expectedFindings = [
      expect.stringMatching(/Apple App Attest/),
      expect.stringMatching(/ATHENA_APP_ATTEST_APP_ID/),
      expect.stringMatching(/ATHENA_APP_ATTEST_VERIFIER_URL/),
      expect.stringMatching(/ATHENA_EDGE_SECURITY_EVIDENCE_FILE/),
      expect.stringMatching(/ATHENA_DR_EVIDENCE_FILE/),
      expect.stringMatching(/hybrid release and disaster-recovery evidence/),
      expect.stringMatching(/ATHENA_REQUIRE_NODE24_PQ_PROBE/),
      expect.stringMatching(/capability baseline must include ml_kem_768/),
    ];
    if (Number(process.versions.node.split(".")[0]) !== 24) {
      expectedFindings.push(expect.stringMatching(/Node.js 24 LTS/));
    }
    expect(
      productionSecurityFindings({
        ...secureProductionEnv,
        ATHENA_ENTERPRISE_RELEASE_GATE: "true",
      })
    ).toEqual(expect.arrayContaining(expectedFindings));
  });

  it("rejects a production PQ requirement on the wrong runtime", () => {
    const findings = productionSecurityFindings({
      ...secureProductionEnv,
      ATHENA_IOS_HIGH_RISK_PQ_REQUIRED: "true",
      ATHENA_REQUIRE_NODE24_PQ_PROBE: "true",
    });
    if (Number(process.versions.node.split(".")[0]) === 24) {
      expect(findings).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/Node.js 24 LTS/)])
      );
      return;
    }
    expect(findings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Node.js 24 LTS/)])
    );
  });

  it("rejects strict iOS PQ enforcement without the runtime probe gate", () => {
    expect(
      productionSecurityFindings({
        ...secureProductionEnv,
        ATHENA_IOS_HIGH_RISK_PQ_REQUIRED: "true",
      })
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ATHENA_REQUIRE_NODE24_PQ_PROBE=true/),
      ])
    );
  });

  it("recognizes APP_ENV and rejects a non-TLS attestation verifier", () => {
    const findings = productionSecurityFindings({
      ...secureProductionEnv,
      NODE_ENV: "development",
      APP_ENV: "production",
      ATHENA_ENTERPRISE_RELEASE_GATE: "true",
      ATHENA_DEVICE_ATTESTATION_MODE: "required",
      ATHENA_APP_ATTEST_APP_ID: "TEAM.com.athena.native",
      ATHENA_APP_ATTEST_VERIFIER_URL: "http://attestation.internal/verify",
    });
    expect(findings).toEqual(
      expect.arrayContaining([expect.stringMatching(/must use HTTPS/)])
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
