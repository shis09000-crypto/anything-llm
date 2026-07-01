const {
  authSessionFingerprintFromRequest,
  issueVaultAccessGrant,
  validateVaultAccessGrant,
  validateVaultGrantForRequest,
  revokeVaultAccessGrants,
} = require("../../utils/authz/vaultAccessGrants");

describe("vault access grants", () => {
  const originalRequired = process.env.VAULT_GRANT_REQUIRED;

  beforeEach(() => {
    process.env.VAULT_GRANT_REQUIRED = "true";
    revokeVaultAccessGrants({ userId: 1 });
    revokeVaultAccessGrants({ userId: 2 });
  });

  afterAll(() => {
    if (originalRequired === undefined) delete process.env.VAULT_GRANT_REQUIRED;
    else process.env.VAULT_GRANT_REQUIRED = originalRequired;
  });

  it("binds short-lived grants to the issuing user and client", () => {
    const grant = issueVaultAccessGrant({
      userId: 1,
      clientId: "client_a",
      method: "password",
      ttlMs: 60_000,
    });

    expect(grant.token).toBeTruthy();
    expect(
      validateVaultAccessGrant({
        token: grant.token,
        userId: 1,
        clientId: "client_a",
      })
    ).toMatchObject({ method: "password" });
    expect(
      validateVaultAccessGrant({
        token: grant.token,
        userId: 2,
        clientId: "client_a",
      })
    ).toBeNull();
    expect(
      validateVaultAccessGrant({
        token: grant.token,
        userId: 1,
        clientId: "client_b",
      })
    ).toBeNull();
  });

  it("rejects expired grants and grants revoked for a client", () => {
    const expired = issueVaultAccessGrant({
      userId: 1,
      clientId: "client_a",
      ttlMs: 1,
    });
    const valid = issueVaultAccessGrant({
      userId: 1,
      clientId: "client_a",
      ttlMs: 60_000,
    });

    const future = Date.now() + 5_000;
    jest.spyOn(Date, "now").mockReturnValue(future);
    try {
      expect(
        validateVaultAccessGrant({
          token: expired.token,
          userId: 1,
          clientId: "client_a",
        })
      ).toBeNull();
    } finally {
      Date.now.mockRestore();
    }

    expect(revokeVaultAccessGrants({ userId: 1, clientId: "client_a" })).toBe(
      1
    );
    expect(
      validateVaultAccessGrant({
        token: valid.token,
        userId: 1,
        clientId: "client_a",
      })
    ).toBeNull();
  });

  it("validates grants from request headers when enforcement is enabled", () => {
    const grant = issueVaultAccessGrant({
      userId: 1,
      clientId: "client_a",
      ttlMs: 60_000,
    });
    const request = {
      body: {},
      header(name) {
        return name === "X-Athena-Vault-Grant" ? grant.token : null;
      },
      headers: {},
    };

    expect(
      validateVaultGrantForRequest(request, {
        userId: 1,
        clientId: "client_a",
      })
    ).toMatchObject({ ok: true });
    expect(
      validateVaultGrantForRequest({ body: {}, headers: {} }, {
        userId: 1,
        clientId: "client_a",
      })
    ).toMatchObject({ ok: false, error: "vault_access_grant_required" });
  });

  it("binds request grants to the active auth session fingerprint", () => {
    const issuingRequest = {
      header(name) {
        return name === "Authorization" ? "Bearer session-a" : null;
      },
      headers: { authorization: "Bearer session-a" },
    };
    const grant = issueVaultAccessGrant({
      userId: 1,
      clientId: "client_a",
      ttlMs: 60_000,
      sessionFingerprint: authSessionFingerprintFromRequest(issuingRequest),
    });

    const requestFor = (auth) => ({
      body: {},
      header(name) {
        if (name === "Authorization") return auth;
        if (name === "X-Athena-Vault-Grant") return grant.token;
        return null;
      },
      headers: {
        authorization: auth,
        "x-athena-vault-grant": grant.token,
      },
    });

    expect(
      validateVaultGrantForRequest(requestFor("Bearer session-a"), {
        userId: 1,
        clientId: "client_a",
      })
    ).toMatchObject({ ok: true });
    expect(
      validateVaultGrantForRequest(requestFor("Bearer session-b"), {
        userId: 1,
        clientId: "client_a",
      })
    ).toMatchObject({ ok: false, error: "vault_access_grant_required" });
  });
});
