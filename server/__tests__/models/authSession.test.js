/* eslint-env jest */

const mockCreate = jest.fn();
const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();
const mockUpdateMany = jest.fn();
const mockDeleteMany = jest.fn();
const mockGetValue = jest.fn();
const mockUpdateSettings = jest.fn();
const mockReconcileSessions = jest.fn();

jest.mock("../../utils/authPrisma", () => ({
  auth_sessions: {
    create: mockCreate,
    findUnique: mockFindUnique,
    findMany: mockFindMany,
    updateMany: mockUpdateMany,
    deleteMany: mockDeleteMany,
  },
}));

jest.mock("../../utils/syncV2/securitySync", () => ({
  reconcileSessionsForAuthUser: mockReconcileSessions,
}));

jest.mock("../../models/systemSettings", () => ({
  getValueOrFallback: mockGetValue,
  _updateSettings: mockUpdateSettings,
}));

const { AuthSession } = require("../../models/authSession");

describe("AuthSession", () => {
  const originalSessionFlag = process.env.ATHENA_SESSION_V2;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalAuthToken = process.env.AUTH_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    AuthSession._clearCache();
    process.env.ATHENA_SESSION_V2 = "true";
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.AUTH_TOKEN = "test-instance-password";
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockDeleteMany.mockResolvedValue({ count: 0 });
    mockFindMany.mockResolvedValue([]);
    mockReconcileSessions.mockResolvedValue(null);
  });

  afterAll(() => {
    if (originalSessionFlag === undefined) delete process.env.ATHENA_SESSION_V2;
    else process.env.ATHENA_SESSION_V2 = originalSessionFlag;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    if (originalAuthToken === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = originalAuthToken;
  });

  it("creates an authoritative user session and validates it from cache", async () => {
    const session = {
      sessionId: "sess_test",
      subjectType: "user",
      authUserId: 42,
      clientId: "client_web",
      authMode: "password",
      tokenVersion: 1,
      revokedAt: null,
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    };
    mockCreate.mockResolvedValue(session);

    await expect(
      AuthSession.create({
        subjectType: "user",
        authUserId: 42,
        clientId: "client_web",
        authMode: "password",
      })
    ).resolves.toEqual(session);
    await expect(
      AuthSession.validate("sess_test", {
        subjectType: "user",
        tokenVersion: 1,
      })
    ).resolves.toMatchObject({ valid: true, session });
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockReconcileSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        authUserId: 42,
        eventType: "session.created",
        originClientId: "client_web",
      })
    );
  });

  it("lists only active sessions in the authenticated subject scope", async () => {
    mockFindMany.mockResolvedValue([
      {
        sessionId: "sess_current",
        subjectType: "user",
        authUserId: 42,
        clientId: "client_web",
        authMode: "passkey",
        tokenVersion: 1,
        createdAt: new Date(),
        lastSeenAt: new Date(),
        idleExpiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() + 120_000),
        revokedAt: null,
        revokeReason: null,
      },
    ]);

    const rows = await AuthSession.listForSubject({
      subjectType: "user",
      authUserId: 42,
      currentSessionId: "sess_current",
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          subjectType: "user",
          authUserId: 42,
          revokedAt: null,
        }),
        take: 100,
      })
    );
    expect(rows).toEqual([
      expect.objectContaining({
        sessionId: "sess_current",
        current: true,
        authMode: "passkey",
      }),
    ]);
    expect(rows[0]).not.toHaveProperty("authUserId");
    expect(rows[0]).not.toHaveProperty("subjectType");
  });

  it("does not advance the reconciliation page after a cross-database publish failure", async () => {
    mockFindMany.mockResolvedValue([{ authUserId: 10 }, { authUserId: 20 }]);
    mockReconcileSessions
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("main database unavailable"));

    await expect(AuthSession.reconcileSyncState()).rejects.toThrow(
      "main database unavailable"
    );
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ authUserId: { not: null, gt: 0 } }),
      })
    );

    mockReconcileSessions.mockReset().mockResolvedValue(null);
    await AuthSession.reconcileSyncState();
    expect(mockFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ authUserId: { not: null, gt: 0 } }),
      })
    );
  });

  it("revokes a session only inside the authenticated subject scope", async () => {
    await expect(
      AuthSession.revokeForSubject({
        subjectType: "user",
        authUserId: 42,
        sessionId: "sess_other",
      })
    ).resolves.toEqual({ count: 1 });

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          subjectType: "user",
          authUserId: 42,
          sessionId: "sess_other",
          revokedAt: null,
        },
      })
    );
    expect(mockReconcileSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        authUserId: 42,
        eventType: "session.revoked",
      })
    );
  });

  it("prunes only sessions that exceeded the retention window", async () => {
    mockDeleteMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-07-19T00:00:00.000Z");
    await expect(
      AuthSession.pruneExpired({ now, retentionMs: 60_000 })
    ).resolves.toEqual({ count: 3 });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { revokedAt: { lt: new Date("2026-07-18T23:59:00.000Z") } },
          { idleExpiresAt: { lt: new Date("2026-07-18T23:59:00.000Z") } },
          { absoluteExpiresAt: { lt: new Date("2026-07-18T23:59:00.000Z") } },
        ],
      },
    });
  });

  it("keeps the authoritative login committed when immediate sync notification fails", async () => {
    const session = {
      sessionId: "sess_deferred",
      subjectType: "user",
      authUserId: 42,
      clientId: "client_ios",
      authMode: "passkey",
      tokenVersion: 1,
      revokedAt: null,
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    };
    mockCreate.mockResolvedValue(session);
    mockReconcileSessions.mockRejectedValueOnce(new Error("main db busy"));

    await expect(
      AuthSession.create({
        subjectType: "user",
        authUserId: 42,
        clientId: "client_ios",
        authMode: "passkey",
      })
    ).resolves.toEqual(session);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    mockFindMany.mockResolvedValue([{ authUserId: 42 }]);
    mockReconcileSessions.mockResolvedValue(null);
    await expect(AuthSession.reconcileSyncState()).resolves.toEqual({
      checked: 1,
      nextAuthUserId: 0,
    });
    expect(mockReconcileSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authUserId: 42,
        eventType: "sessions.reconciled",
      })
    );
  });

  it("pages periodic session reconciliation without rescanning the same owner", async () => {
    mockFindMany.mockResolvedValueOnce([
      { authUserId: 42 },
      { authUserId: 84 },
    ]);

    await expect(AuthSession.reconcileSyncState({ limit: 2 })).resolves.toEqual(
      {
        checked: 2,
        nextAuthUserId: 84,
      }
    );
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authUserId: { not: null, gt: 0 } },
        distinct: ["authUserId"],
        take: 2,
      })
    );

    mockFindMany.mockResolvedValueOnce([]);
    await AuthSession.reconcileSyncState({ limit: 2 });
    expect(mockFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { authUserId: { not: null, gt: 84 } },
      })
    );
  });

  it("rejects a revoked session on an authoritative read", async () => {
    mockFindUnique.mockResolvedValue({
      sessionId: "sess_revoked",
      subjectType: "user",
      tokenVersion: 1,
      revokedAt: new Date(),
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    });
    await expect(
      AuthSession.validate("sess_revoked", { authoritative: true })
    ).resolves.toMatchObject({ valid: false, code: "session_revoked" });
  });

  it("enables device-bound recovery without creating a second session", async () => {
    const session = {
      sessionId: "sess_recoverable",
      subjectType: "user",
      authUserId: 42,
      clientId: "client_ios",
      authMode: "zk",
      tokenVersion: 1,
      revokedAt: null,
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    };
    mockFindUnique.mockResolvedValue(session);

    const enrolled = await AuthSession.enableRecovery(session.sessionId, {
      authUserId: 42,
      clientId: "client_ios",
    });

    expect(enrolled).toEqual({
      recoveryHandle: expect.any(String),
      expiresAt: session.absoluteExpiresAt.getTime(),
    });
    expect(enrolled.recoveryHandle.length).toBeGreaterThanOrEqual(40);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sessionId: "sess_recoverable",
          authUserId: 42,
          clientId: "client_ios",
          revokedAt: null,
        }),
        data: expect.objectContaining({
          recoveryHandleHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          recoveryEnabledAt: expect.any(Date),
        }),
      })
    );
  });

  it("resolves recovery handles by hash and never queries with the raw handle", async () => {
    const session = { sessionId: "sess_recoverable" };
    mockFindUnique.mockResolvedValue(session);

    await expect(
      AuthSession.findByRecoveryHandle("raw-recovery-handle")
    ).resolves.toBe(session);
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: {
        recoveryHandleHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(
      mockFindUnique.mock.calls[0][0].where.recoveryHandleHash
    ).not.toContain("raw-recovery-handle");
  });

  it("persists a single-user legacy cutoff once", async () => {
    mockGetValue.mockResolvedValue(null);
    mockUpdateSettings.mockResolvedValue({ success: true, error: null });
    const cutoff = await AuthSession.legacySingleUserCutoff();
    expect(cutoff.getTime()).toBeGreaterThan(Date.now());
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        athena_session_v2_legacy_cutoff: expect.any(String),
      })
    );
  });

  it("derives a stable single-user auth version without exposing the password", () => {
    const version = AuthSession.singleUserAuthVersion();
    expect(version).not.toContain(process.env.AUTH_TOKEN);
    expect(AuthSession.verifySingleUserAuthVersion(version)).toBe(true);
    expect(AuthSession.verifySingleUserAuthVersion(`${version}x`)).toBe(false);
  });
});
