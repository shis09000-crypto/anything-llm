const crypto = require("crypto");
const authPrisma = require("../utils/authPrisma");
const SystemSettings = require("./systemSettings");

const POSITIVE_CACHE_TTL_MS = 5_000;
const LAST_SEEN_WRITE_THROTTLE_MS = 60_000;
const DEFAULT_IDLE_MS = 48 * 60 * 60 * 1_000;
const DEFAULT_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const LEGACY_CUTOFF_SETTING = "athena_session_v2_legacy_cutoff";
const sessionCache = new Map();
const lastSeenWrites = new Map();
let syncReconcileAfterAuthUserId = 0;

function enabled() {
  return process.env.ATHENA_SESSION_V2 !== "false";
}

function positiveDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function newSessionId() {
  return `sess_${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}`;
}

function newRecoveryHandle() {
  return crypto.randomBytes(32).toString("base64url");
}

function recoveryHandleHash(handle) {
  const normalized = String(handle || "").trim();
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function cacheSession(session) {
  if (!session || session.revokedAt) return;
  sessionCache.set(session.sessionId, {
    session,
    expiresAt: Date.now() + POSITIVE_CACHE_TTL_MS,
  });
}

function invalidate(sessionId) {
  if (!sessionId) return;
  sessionCache.delete(String(sessionId));
  lastSeenWrites.delete(String(sessionId));
}

function sessionFailure(code, session = null) {
  return { valid: false, code, session };
}

function subjectFilter({ subjectType, authUserId = null } = {}) {
  return {
    subjectType: String(subjectType),
    authUserId: authUserId ? Number(authUserId) : null,
  };
}

function publicSession(session, currentSessionId = null) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    clientId: session.clientId || null,
    authMode: session.authMode,
    tokenVersion: Number(session.tokenVersion) || 1,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    revokedAt: session.revokedAt || null,
    revokeReason: session.revokeReason || null,
    current: String(session.sessionId) === String(currentSessionId || ""),
  };
}

async function publishSessionChange(options = {}) {
  if (!options.authUserId) return null;
  try {
    const {
      reconcileSessionsForAuthUser,
    } = require("../utils/syncV2/securitySync");
    return await reconcileSessionsForAuthUser(options);
  } catch (error) {
    console.warn("[AuthSession] Sync V2 session notification deferred", {
      authUserId: Number(options.authUserId),
      code: error?.code || "session_sync_unavailable",
    });
    if (options.throwOnFailure) throw error;
    return null;
  }
}

const AuthSession = {
  enabled,

  cacheSnapshot: function () {
    return {
      sessionEntries: sessionCache.size,
      lastSeenEntries: lastSeenWrites.size,
    };
  },

  refreshCache: function ({ sessionIds = [] } = {}) {
    const normalized = [
      ...new Set(
        (Array.isArray(sessionIds) ? sessionIds : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .slice(0, 100)
      ),
    ];
    const before = this.cacheSnapshot();
    if (!normalized.length) {
      sessionCache.clear();
      lastSeenWrites.clear();
    } else {
      normalized.forEach(invalidate);
    }
    return {
      scope: normalized.length ? "selected" : "all",
      selected: normalized.length,
      before,
      after: this.cacheSnapshot(),
    };
  },

  create: async function ({
    subjectType,
    authUserId = null,
    clientId = null,
    authMode,
    sessionId = null,
    tokenVersion = 1,
  }) {
    if (!enabled()) return null;
    const now = Date.now();
    const idleMs = positiveDuration(
      process.env.ATHENA_SESSION_IDLE_MS,
      DEFAULT_IDLE_MS
    );
    const absoluteMs = positiveDuration(
      process.env.ATHENA_SESSION_ABSOLUTE_MS,
      DEFAULT_ABSOLUTE_MS
    );
    const created = await authPrisma.auth_sessions.create({
      data: {
        sessionId: sessionId || newSessionId(),
        subjectType: String(subjectType),
        authUserId: authUserId ? Number(authUserId) : null,
        clientId: clientId ? String(clientId).slice(0, 256) : null,
        authMode: String(authMode || "password"),
        tokenVersion: Number(tokenVersion) || 1,
        lastSeenAt: new Date(now),
        idleExpiresAt: new Date(now + idleMs),
        absoluteExpiresAt: new Date(now + absoluteMs),
      },
    });
    cacheSession(created);
    if (
      created.authUserId &&
      created.clientId &&
      typeof authPrisma.auth_sessions.count === "function"
    ) {
      authPrisma.auth_sessions
        .count({
          where: {
            authUserId: created.authUserId,
            clientId: created.clientId,
            revokedAt: null,
            idleExpiresAt: { gt: new Date(now) },
            absoluteExpiresAt: { gt: new Date(now) },
          },
        })
        .then((count) =>
          require("../utils/observability/metrics").metrics.authActiveSessionsPerClient.observe(
            Math.max(1, Number(count) || 1)
          )
        )
        .catch(() => null);
    }
    await publishSessionChange({
      authUserId: created.authUserId,
      eventType: "session.created",
      changedPaths: [`sessions.${created.sessionId}`],
      payloadHint: {
        sessionId: created.sessionId,
        clientId: created.clientId || null,
        authMode: created.authMode,
      },
      originClientId: created.clientId || null,
    });
    return created;
  },

  listForSubject: async function ({
    subjectType,
    authUserId = null,
    currentSessionId = null,
    includeRevoked = false,
    limit = 100,
  } = {}) {
    if (!enabled()) return [];
    const where = subjectFilter({ subjectType, authUserId });
    if (!includeRevoked) {
      const now = new Date();
      Object.assign(where, {
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      });
    }
    const sessions = await authPrisma.auth_sessions.findMany({
      where,
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
      take: Math.min(Math.max(Number(limit) || 100, 1), 100),
    });
    return sessions.map((session) => publicSession(session, currentSessionId));
  },

  validate: async function (
    sessionId,
    { authoritative = false, subjectType = null, tokenVersion = null } = {}
  ) {
    if (!enabled()) return { valid: true, session: null, disabled: true };
    const id = String(sessionId || "");
    if (!id) return sessionFailure("session_missing");

    let session = null;
    const cached = sessionCache.get(id);
    if (!authoritative && cached?.expiresAt > Date.now()) {
      session = cached.session;
    } else {
      session = await authPrisma.auth_sessions.findUnique({
        where: { sessionId: id },
      });
      if (session && !session.revokedAt) cacheSession(session);
    }

    if (!session) return sessionFailure("session_missing");
    if (session.revokedAt) {
      invalidate(id);
      return sessionFailure("session_revoked", session);
    }
    const now = Date.now();
    if (session.absoluteExpiresAt.getTime() <= now) {
      return sessionFailure("session_absolute_expired", session);
    }
    if (session.idleExpiresAt.getTime() <= now) {
      return sessionFailure("session_idle_expired", session);
    }
    if (subjectType && session.subjectType !== subjectType) {
      return sessionFailure("session_subject_mismatch", session);
    }
    if (
      tokenVersion !== null &&
      Number(session.tokenVersion) !== Number(tokenVersion)
    ) {
      return sessionFailure("session_version_mismatch", session);
    }

    const lastWrite = lastSeenWrites.get(id) || 0;
    if (now - lastWrite >= LAST_SEEN_WRITE_THROTTLE_MS) {
      lastSeenWrites.set(id, now);
      authPrisma.auth_sessions
        .updateMany({
          where: { sessionId: id, revokedAt: null },
          data: { lastSeenAt: new Date(now) },
        })
        .catch((error) => {
          lastSeenWrites.delete(id);
          console.warn("[AuthSession] lastSeen update failed", error.message);
        });
    }
    return { valid: true, session };
  },

  touchUserAction: async function (sessionId) {
    if (!enabled() || !sessionId) return null;
    const now = Date.now();
    const idleMs = positiveDuration(
      process.env.ATHENA_SESSION_IDLE_MS,
      DEFAULT_IDLE_MS
    );
    const result = await authPrisma.auth_sessions.updateMany({
      where: {
        sessionId: String(sessionId),
        revokedAt: null,
        absoluteExpiresAt: { gt: new Date(now) },
      },
      data: {
        lastSeenAt: new Date(now),
        idleExpiresAt: new Date(now + idleMs),
      },
    });
    invalidate(sessionId);
    return result.count;
  },

  enableRecovery: async function (
    sessionId,
    { authUserId = null, clientId = null } = {}
  ) {
    if (!enabled() || !sessionId || !authUserId || !clientId) return null;
    const sessionResult = await this.validate(sessionId, {
      authoritative: true,
      subjectType: "user",
    });
    const session = sessionResult.session;
    if (
      !sessionResult.valid ||
      !session ||
      Number(session.authUserId) !== Number(authUserId) ||
      String(session.clientId || "") !== String(clientId)
    ) {
      return null;
    }

    const recoveryHandle = newRecoveryHandle();
    const now = new Date();
    const updated = await authPrisma.auth_sessions.updateMany({
      where: {
        sessionId: String(sessionId),
        subjectType: "user",
        authUserId: Number(authUserId),
        clientId: String(clientId),
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
      data: {
        recoveryHandleHash: recoveryHandleHash(recoveryHandle),
        recoveryEnabledAt: now,
      },
    });
    if (updated.count !== 1) return null;
    invalidate(sessionId);
    return {
      recoveryHandle,
      // Normal authenticated activity extends idle expiry. Persist only the
      // non-extendable bound locally and keep idle validity authoritative here.
      expiresAt: new Date(session.absoluteExpiresAt).getTime(),
    };
  },

  findByRecoveryHandle: async function (recoveryHandle) {
    if (!enabled()) return null;
    const hash = recoveryHandleHash(recoveryHandle);
    if (!hash) return null;
    return await authPrisma.auth_sessions.findUnique({
      where: { recoveryHandleHash: hash },
    });
  },

  markRecoveryUsed: async function (sessionId) {
    if (!enabled() || !sessionId) return { count: 0 };
    const result = await authPrisma.auth_sessions.updateMany({
      where: {
        sessionId: String(sessionId),
        revokedAt: null,
      },
      data: { recoveryLastUsedAt: new Date() },
    });
    invalidate(sessionId);
    return result;
  },

  revoke: async function (sessionId, reason = "logout") {
    if (!enabled() || !sessionId) return { count: 0 };
    const session = await authPrisma.auth_sessions.findUnique({
      where: { sessionId: String(sessionId) },
      select: { authUserId: true, clientId: true },
    });
    const result = await authPrisma.auth_sessions.updateMany({
      where: { sessionId: String(sessionId), revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokeReason: String(reason).slice(0, 128),
      },
    });
    invalidate(sessionId);
    if (result.count) {
      await publishSessionChange({
        authUserId: session?.authUserId,
        eventType: "session.revoked",
        changedPaths: [`sessions.${String(sessionId)}`],
        payloadHint: {
          sessionId: String(sessionId),
          clientId: session?.clientId || null,
          reason: String(reason).slice(0, 128),
        },
        originClientId: session?.clientId || null,
      });
    }
    return result;
  },

  revokeForSubject: async function ({
    subjectType,
    authUserId = null,
    sessionId,
    reason = "session_revoked",
  } = {}) {
    if (!enabled() || !sessionId) return { count: 0 };
    const result = await authPrisma.auth_sessions.updateMany({
      where: {
        ...subjectFilter({ subjectType, authUserId }),
        sessionId: String(sessionId),
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokeReason: String(reason).slice(0, 128),
      },
    });
    invalidate(sessionId);
    if (result.count) {
      await publishSessionChange({
        authUserId,
        eventType: "session.revoked",
        changedPaths: [`sessions.${String(sessionId)}`],
        payloadHint: {
          sessionId: String(sessionId),
          reason: String(reason).slice(0, 128),
        },
      });
    }
    return result;
  },

  revokeOthersForSubject: async function ({
    subjectType,
    authUserId = null,
    currentSessionId,
    reason = "other_sessions_revoked",
  } = {}) {
    if (!enabled() || !currentSessionId) return { count: 0 };
    const where = {
      ...subjectFilter({ subjectType, authUserId }),
      sessionId: { not: String(currentSessionId) },
      revokedAt: null,
    };
    const sessions = await authPrisma.auth_sessions.findMany({
      where,
      select: { sessionId: true },
    });
    const result = await authPrisma.auth_sessions.updateMany({
      where,
      data: {
        revokedAt: new Date(),
        revokeReason: String(reason).slice(0, 128),
      },
    });
    sessions.forEach(({ sessionId }) => invalidate(sessionId));
    if (result.count) {
      await publishSessionChange({
        authUserId,
        eventType: "sessions.others_revoked",
        changedPaths: ["sessions"],
        payloadHint: { count: result.count },
      });
    }
    return result;
  },

  revokeAllForSubject: async function ({
    subjectType,
    authUserId = null,
    reason = "all_sessions_revoked",
  } = {}) {
    if (!enabled()) return { count: 0 };
    const where = {
      ...subjectFilter({ subjectType, authUserId }),
      revokedAt: null,
    };
    const sessions = await authPrisma.auth_sessions.findMany({
      where,
      select: { sessionId: true },
    });
    const result = await authPrisma.auth_sessions.updateMany({
      where,
      data: {
        revokedAt: new Date(),
        revokeReason: String(reason).slice(0, 128),
      },
    });
    sessions.forEach(({ sessionId }) => invalidate(sessionId));
    if (result.count) {
      await publishSessionChange({
        authUserId,
        eventType: "sessions.all_revoked",
        changedPaths: ["sessions"],
        payloadHint: { count: result.count },
      });
    }
    return result;
  },

  revokeClient: async function ({
    authUserId,
    clientId,
    reason = "device_revoked",
  }) {
    if (!enabled() || !authUserId || !clientId) return { count: 0 };
    const sessions = await authPrisma.auth_sessions.findMany({
      where: {
        authUserId: Number(authUserId),
        clientId: String(clientId),
        revokedAt: null,
      },
      select: { sessionId: true },
    });
    const result = await authPrisma.auth_sessions.updateMany({
      where: {
        authUserId: Number(authUserId),
        clientId: String(clientId),
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokeReason: String(reason).slice(0, 128),
      },
    });
    sessions.forEach(({ sessionId }) => invalidate(sessionId));
    if (result.count) {
      await publishSessionChange({
        authUserId,
        eventType: "sessions.client_revoked",
        changedPaths: ["sessions"],
        payloadHint: { clientId: String(clientId), count: result.count },
        originClientId: String(clientId),
      });
    }
    return result;
  },

  revokeAllForUser: async function (authUserId, reason = "account_revoked") {
    if (!enabled() || !authUserId) return { count: 0 };
    const sessions = await authPrisma.auth_sessions.findMany({
      where: { authUserId: Number(authUserId), revokedAt: null },
      select: { sessionId: true },
    });
    const result = await authPrisma.auth_sessions.updateMany({
      where: { authUserId: Number(authUserId), revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokeReason: String(reason).slice(0, 128),
      },
    });
    sessions.forEach(({ sessionId }) => invalidate(sessionId));
    if (result.count) {
      await publishSessionChange({
        authUserId,
        eventType: "sessions.all_revoked",
        changedPaths: ["sessions"],
        payloadHint: { count: result.count },
      });
    }
    return result;
  },

  pruneExpired: async function ({
    now = new Date(),
    retentionMs = DEFAULT_RETENTION_MS,
  } = {}) {
    if (!enabled() || typeof authPrisma.auth_sessions.deleteMany !== "function")
      return { count: 0 };
    const cutoff = new Date(
      now.getTime() - positiveDuration(retentionMs, DEFAULT_RETENTION_MS)
    );
    return await authPrisma.auth_sessions.deleteMany({
      where: {
        OR: [
          { revokedAt: { lt: cutoff } },
          { idleExpiresAt: { lt: cutoff } },
          { absoluteExpiresAt: { lt: cutoff } },
        ],
      },
    });
  },

  reconcileSyncState: async function ({ limit = 500 } = {}) {
    if (!enabled()) return { checked: 0, nextAuthUserId: 0 };
    const pageSize = Math.min(Math.max(Number(limit) || 500, 1), 500);
    const owners = await authPrisma.auth_sessions.findMany({
      where: {
        authUserId: { not: null, gt: syncReconcileAfterAuthUserId },
      },
      select: { authUserId: true },
      distinct: ["authUserId"],
      orderBy: { authUserId: "asc" },
      take: pageSize,
    });
    for (const owner of owners) {
      await publishSessionChange({
        authUserId: owner.authUserId,
        eventType: "sessions.reconciled",
        changedPaths: ["sessions"],
        payloadHint: { reason: "periodic-authority-reconcile" },
        throwOnFailure: true,
      });
    }
    syncReconcileAfterAuthUserId =
      owners.length === pageSize
        ? Number(owners[owners.length - 1]?.authUserId || 0)
        : 0;
    return {
      checked: owners.length,
      nextAuthUserId: syncReconcileAfterAuthUserId,
    };
  },

  legacySingleUserCutoff: async function () {
    let value = await SystemSettings.getValueOrFallback(
      { label: LEGACY_CUTOFF_SETTING },
      null
    );
    if (!value) {
      value = new Date(Date.now() + DEFAULT_ABSOLUTE_MS).toISOString();
      const result = await SystemSettings._updateSettings({
        [LEGACY_CUTOFF_SETTING]: value,
      });
      if (!result.success) throw new Error(result.error);
    }
    return new Date(value);
  },

  legacySingleUserTokenAllowed: async function () {
    if (!enabled()) return true;
    const cutoff = await this.legacySingleUserCutoff();
    return Number.isFinite(cutoff.getTime()) && cutoff.getTime() > Date.now();
  },

  singleUserAuthVersion: function () {
    return crypto
      .createHmac("sha256", String(process.env.JWT_SECRET || ""))
      .update(String(process.env.AUTH_TOKEN || ""))
      .digest("base64url");
  },

  verifySingleUserAuthVersion: function (value) {
    const expected = Buffer.from(this.singleUserAuthVersion());
    const actual = Buffer.from(String(value || ""));
    return (
      expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual)
    );
  },

  _clearCache: function () {
    sessionCache.clear();
    lastSeenWrites.clear();
    syncReconcileAfterAuthUserId = 0;
  },

  _recoveryInternals: {
    newRecoveryHandle,
    recoveryHandleHash,
  },
};

module.exports = { AuthSession };
