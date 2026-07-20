function safeJsonArray(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function clientDevicesProjection(client, userId) {
  return await client.athena_clients.findMany({
    where: { userId: Number(userId) },
    select: {
      clientId: true,
      platform: true,
      deviceName: true,
      appVersion: true,
      trustLevel: true,
      capabilitySource: true,
      deviceFingerprintVersion: true,
      createdAt: true,
      revokedAt: true,
    },
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
  });
}

async function passkeysProjection(authClient, authUserId) {
  if (!Number(authUserId)) return [];
  const rows = await authClient.passkeyCredential.findMany({
    where: { userId: Number(authUserId) },
    select: {
      id: true,
      deviceName: true,
      deviceType: true,
      browserName: true,
      platformName: true,
      provider: true,
      providerName: true,
      backedUp: true,
      transports: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.map((row) => ({
    ...row,
    transports: safeJsonArray(row.transports),
  }));
}

async function authSessionsProjection(
  authClient,
  authUserId,
  { limit = 100 } = {}
) {
  if (!Number(authUserId)) return [];
  const now = new Date();
  return await authClient.auth_sessions.findMany({
    where: {
      authUserId: Number(authUserId),
      subjectType: "user",
      revokedAt: null,
      idleExpiresAt: { gt: now },
      absoluteExpiresAt: { gt: now },
    },
    select: {
      sessionId: true,
      clientId: true,
      authMode: true,
      tokenVersion: true,
      createdAt: true,
      lastSeenAt: true,
      idleExpiresAt: true,
      absoluteExpiresAt: true,
      revokedAt: true,
      revokeReason: true,
    },
    orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(Number(limit) || 100, 1), 100),
  });
}

async function authSessionStateRevision(authClient, authUserId) {
  if (!Number(authUserId)) return null;
  const now = new Date();
  const rows = await authClient.auth_sessions.findMany({
    where: {
      authUserId: Number(authUserId),
      subjectType: "user",
      revokedAt: null,
      idleExpiresAt: { gt: now },
      absoluteExpiresAt: { gt: now },
    },
    select: {
      sessionId: true,
      clientId: true,
      authMode: true,
      tokenVersion: true,
      createdAt: true,
    },
    orderBy: { sessionId: "asc" },
    take: 1_000,
  });
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        rows.map((row) => ({
          sessionId: row.sessionId,
          clientId: row.clientId || null,
          authMode: row.authMode,
          tokenVersion: Number(row.tokenVersion) || 1,
          createdAt: row.createdAt?.toISOString?.() || row.createdAt,
        }))
      )
    )
    .digest("hex");
}

module.exports = {
  authSessionStateRevision,
  authSessionsProjection,
  clientDevicesProjection,
  passkeysProjection,
};
const crypto = require("crypto");
