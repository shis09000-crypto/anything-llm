const {
  issueSensitiveSession,
  revokeSensitiveSession,
  revokeSensitiveSessions,
  sensitiveSessionSnapshot,
  validateSensitiveSessionForRequest,
  validateSensitiveSession,
} = require("../../utils/authz/sensitiveSessions");

describe("sensitive sessions", () => {
  beforeEach(() => {
    revokeSensitiveSessions({ userId: 1 });
    revokeSensitiveSessions({ userId: 2 });
  });

  it("binds sessions to user, client, resource, owner scope, and auth session", () => {
    const session = issueSensitiveSession({
      userId: 1,
      clientId: "client_a",
      resourceType: "vault",
      resourceId: "vault",
      ownerScope: "user:1:vault",
      sessionFingerprint: "auth_a",
      ttl: 60_000,
    });

    expect(session.token).toMatch(/^ssn_/);
    expect(
      validateSensitiveSession({
        token: session.token,
        userId: 1,
        clientId: "client_a",
        resourceType: "vault",
        resourceId: "vault",
        ownerScope: "user:1:vault",
        sessionFingerprint: "auth_a",
      })
    ).toMatchObject({ ok: true });
    expect(
      validateSensitiveSession({
        token: session.token,
        userId: 2,
        clientId: "client_a",
        resourceType: "vault",
        resourceId: "vault",
        ownerScope: "user:1:vault",
        sessionFingerprint: "auth_a",
      })
    ).toMatchObject({ ok: false });
    expect(
      validateSensitiveSession({
        token: session.token,
        userId: 1,
        clientId: "client_b",
        resourceType: "vault",
        resourceId: "vault",
        ownerScope: "user:1:vault",
        sessionFingerprint: "auth_a",
      })
    ).toMatchObject({ ok: false });
  });

  it("expires and revokes sessions without exposing tokens in snapshots", () => {
    const expired = issueSensitiveSession({
      userId: 1,
      clientId: "client_a",
      resourceType: "api_key",
      resourceId: "42",
      ttl: 1,
    });
    const valid = issueSensitiveSession({
      userId: 1,
      clientId: "client_a",
      resourceType: "vault",
      resourceId: "vault",
      ttl: 60_000,
    });

    const future = Date.now() + 5_000;
    jest.spyOn(Date, "now").mockReturnValue(future);
    try {
      expect(
        validateSensitiveSession({
          token: expired.token,
          userId: 1,
          clientId: "client_a",
          resourceType: "api_key",
          resourceId: "42",
        })
      ).toMatchObject({ ok: false });
    } finally {
      Date.now.mockRestore();
    }

    expect(
      sensitiveSessionSnapshot({ userId: 1, clientId: "client_a" })[0]
    ).not.toHaveProperty("token");
    expect(
      sensitiveSessionSnapshot({ userId: 1, clientId: "client_a" })[0].sessionId
    ).toBe("[redacted-sensitive-session]");
    expect(
      revokeSensitiveSession({
        token: valid.token,
        userId: 1,
        clientId: "client_a",
      })
    ).toBe(true);
    expect(
      validateSensitiveSession({
        token: valid.token,
        userId: 1,
        clientId: "client_a",
        resourceType: "vault",
        resourceId: "vault",
      })
    ).toMatchObject({ ok: false });
  });

  it("revokes sessions by exact resource and owner scope", () => {
    const keep = issueSensitiveSession({
      userId: 1,
      clientId: "client_a",
      resourceType: "reader_document",
      resourceId: "workspace-a:doc-1",
      ownerScope: "workspace:a:reader",
      ttl: 60_000,
    });
    const revoke = issueSensitiveSession({
      userId: 1,
      clientId: "client_a",
      resourceType: "reader_document",
      resourceId: "workspace-a:doc-2",
      ownerScope: "workspace:a:reader",
      ttl: 60_000,
    });
    const otherOwner = issueSensitiveSession({
      userId: 1,
      clientId: "client_a",
      resourceType: "reader_document",
      resourceId: "workspace-a:doc-2",
      ownerScope: "workspace:b:reader",
      ttl: 60_000,
    });

    expect(
      revokeSensitiveSessions({
        userId: 1,
        clientId: "client_a",
        resourceType: "reader_document",
        resourceId: "workspace-a:doc-2",
        ownerScope: "workspace:a:reader",
      })
    ).toBe(1);
    expect(
      validateSensitiveSession({
        token: revoke.token,
        userId: 1,
        clientId: "client_a",
        resourceType: "reader_document",
        resourceId: "workspace-a:doc-2",
        ownerScope: "workspace:a:reader",
      })
    ).toMatchObject({ ok: false });
    expect(
      validateSensitiveSession({
        token: keep.token,
        userId: 1,
        clientId: "client_a",
        resourceType: "reader_document",
        resourceId: "workspace-a:doc-1",
        ownerScope: "workspace:a:reader",
      })
    ).toMatchObject({ ok: true });
    expect(
      validateSensitiveSession({
        token: otherOwner.token,
        userId: 1,
        clientId: "client_a",
        resourceType: "reader_document",
        resourceId: "workspace-a:doc-2",
        ownerScope: "workspace:b:reader",
      })
    ).toMatchObject({ ok: true });
  });

  it("rejects missing or mismatched request secrets without creating fake access", () => {
    const session = issueSensitiveSession({
      userId: 1,
      clientId: "client_a",
      resourceType: "reader_document",
      resourceId: "workspace-a:doc-secure",
      ownerScope: "workspace:a:reader",
      ttl: 60_000,
    });
    const bodySession = issueSensitiveSession({
      userId: 1,
      clientId: "client_a",
      resourceType: "reader_document",
      resourceId: "workspace-a:doc-secure",
      ownerScope: "workspace:a:reader",
      ttl: 60_000,
    });

    const missingRequest = {
      headers: {},
      body: {},
    };
    const wrongResourceRequest = {
      header: (name) =>
        name === "X-Athena-Sensitive-Session" ? session.token : null,
      body: {},
    };
    const bodyTokenRequest = {
      headers: {},
      body: { sensitiveSession: bodySession.token },
    };

    expect(
      validateSensitiveSessionForRequest(missingRequest, {
        userId: 1,
        clientId: "client_a",
        resourceType: "reader_document",
        resourceId: "workspace-a:doc-secure",
        ownerScope: "workspace:a:reader",
      })
    ).toMatchObject({ ok: false });
    expect(
      validateSensitiveSessionForRequest(wrongResourceRequest, {
        userId: 1,
        clientId: "client_a",
        resourceType: "reader_document",
        resourceId: "workspace-a:other-doc",
        ownerScope: "workspace:a:reader",
      })
    ).toMatchObject({ ok: false });
    expect(
      validateSensitiveSessionForRequest(bodyTokenRequest, {
        userId: 1,
        clientId: "client_a",
        resourceType: "reader_document",
        resourceId: "workspace-a:doc-secure",
        ownerScope: "workspace:a:reader",
      })
    ).toMatchObject({ ok: true });
  });

  it("records heartbeat without exposing token details", () => {
    const session = issueSensitiveSession({
      userId: 1,
      clientId: "client_a",
      resourceType: "vault",
      resourceId: "vault",
      ttl: 60_000,
    });

    const before = sensitiveSessionSnapshot({
      userId: 1,
      clientId: "client_a",
    })[0];
    const future = Date.now() + 3_000;
    jest.spyOn(Date, "now").mockReturnValue(future);
    try {
      expect(
        validateSensitiveSession({
          token: session.token,
          userId: 1,
          clientId: "client_a",
          resourceType: "vault",
          resourceId: "vault",
          heartbeat: true,
        })
      ).toMatchObject({ ok: true });
      const after = sensitiveSessionSnapshot({
        userId: 1,
        clientId: "client_a",
      })[0];
      expect(before.sessionId).toBe("[redacted-sensitive-session]");
      expect(after.sessionId).toBe("[redacted-sensitive-session]");
      expect(after.lastHeartbeatAgeMs).toBe(0);
    } finally {
      Date.now.mockRestore();
    }
  });
});
