const {
  authSessionStateRevision,
  authSessionsProjection,
  clientDevicesProjection,
  passkeysProjection,
} = require("../../utils/syncV2/securityProjection");

describe("Sync V2 security projections", () => {
  test("device projection excludes volatile and cryptographic fields", async () => {
    const client = {
      athena_clients: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    await clientDevicesProjection(client, 7);

    const query = client.athena_clients.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ userId: 7 });
    expect(query.select).not.toHaveProperty("lastSeenAt");
    expect(query.select).not.toHaveProperty("publicKey");
    expect(query.select).not.toHaveProperty("capabilities");
    expect(query.select).toMatchObject({
      clientId: true,
      trustLevel: true,
      revokedAt: true,
    });
  });

  test("passkey projection excludes credential material and normalizes transports", async () => {
    const client = {
      passkeyCredential: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 9,
            deviceName: "iPhone",
            transports: '["internal","hybrid"]',
            createdAt: new Date("2026-07-17T12:00:00.000Z"),
          },
        ]),
      },
    };

    const rows = await passkeysProjection(client, 7001);

    const query = client.passkeyCredential.findMany.mock.calls[0][0];
    expect(query.select).not.toHaveProperty("credentialId");
    expect(query.select).not.toHaveProperty("publicKey");
    expect(query.select).not.toHaveProperty("counter");
    expect(query.select).not.toHaveProperty("lastUsedAt");
    expect(rows[0].transports).toEqual(["internal", "hybrid"]);
  });

  test("auth session projection exposes no subject or token material", async () => {
    const client = {
      auth_sessions: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    await authSessionsProjection(client, 7001);

    const query = client.auth_sessions.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({
      authUserId: 7001,
      subjectType: "user",
      revokedAt: null,
    });
    expect(query.select).not.toHaveProperty("authUserId");
    expect(query.select).not.toHaveProperty("subjectType");
    expect(query.select).not.toHaveProperty("token");
    expect(query.select).toMatchObject({
      sessionId: true,
      clientId: true,
      authMode: true,
      idleExpiresAt: true,
      absoluteExpiresAt: true,
    });
    expect(query.take).toBe(100);
  });

  test("auth session source revision is stable and excludes activity heartbeats", async () => {
    const rows = [
      {
        sessionId: "sess_a",
        clientId: "client_web",
        authMode: "password",
        tokenVersion: 1,
        createdAt: new Date("2026-07-19T00:00:00.000Z"),
      },
    ];
    const client = {
      auth_sessions: { findMany: jest.fn().mockResolvedValue(rows) },
    };

    const first = await authSessionStateRevision(client, 7001);
    const second = await authSessionStateRevision(client, 7001);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    const query = client.auth_sessions.findMany.mock.calls[0][0];
    expect(query.select).not.toHaveProperty("lastSeenAt");
    expect(query.select).not.toHaveProperty("idleExpiresAt");
    expect(query.select).not.toHaveProperty("absoluteExpiresAt");
    expect(query.orderBy).toEqual({ sessionId: "asc" });
  });
});
