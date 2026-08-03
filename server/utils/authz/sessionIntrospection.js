const { DataAccessCenter } = require("../dataAccess");
const { getClientRecord } = require("../clientIdentity");
const { decodeJWT } = require("../http");
const { jwtIdleState, sessionClientIdFromToken } = require("../sessionIdle");
const { isAuthEpochCompatible } = require("./authCompatibility");

function compact(value, maxLength = 256) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function inactive(reasonCode) {
  return {
    success: true,
    active: false,
    reasonCode: compact(reasonCode, 96) || "session_invalid",
  };
}

function safePrincipal({ claims, session, subjectType, authUserId = null }) {
  return {
    subjectType,
    userId: claims?.id ? Number(claims.id) : null,
    authUserId: authUserId ? Number(authUserId) : null,
    sessionId: compact(session?.sessionId || claims?.sid, 160),
    clientId: compact(
      session?.clientId || sessionClientIdFromToken(claims),
      256
    ),
    authMode: compact(session?.authMode, 64),
    role: compact(claims?.role, 64),
    tokenVersion: Number(session?.tokenVersion || claims?.tokenVersion || 1),
  };
}

async function introspectSessionClaims(
  claims,
  {
    data = DataAccessCenter,
    findClient = getClientRecord,
    requireClient = true,
  } = {}
) {
  if (!isAuthEpochCompatible(claims))
    return inactive("session_epoch_incompatible");
  if (!claims?.sid) return inactive("session_missing");

  const idle = jwtIdleState(claims);
  if (idle.idleExpired) return inactive("session_idle_expired");

  const multiUser = await data.adminSystem.isMultiUserMode();
  const subjectType = multiUser ? "user" : "instance";
  const sessionResult = await data.adminSystem.authSession.validate(
    claims.sid,
    {
      authoritative: true,
      subjectType,
      tokenVersion: claims.tokenVersion || 1,
    }
  );
  if (!sessionResult.valid)
    return inactive(sessionResult.code || "session_invalid");

  const session = sessionResult.session;
  if (!multiUser) {
    if (
      !data.adminSystem.authSession.verifySingleUserAuthVersion(
        claims.authVersion
      )
    )
      return inactive("session_auth_version_mismatch");
    return {
      success: true,
      active: true,
      principal: safePrincipal({ claims, session, subjectType }),
    };
  }

  if (!claims.id) return inactive("session_subject_missing");
  const shadow = await data.authIdentity.shadowUser._get({
    id: Number(claims.id),
  });
  if (!shadow) return inactive("account_unavailable");

  const authUserId = Number(
    claims.authUserId || session?.authUserId || shadow.authUserId
  );
  if (!Number.isInteger(authUserId) || authUserId <= 0)
    return inactive("account_unavailable");
  if (session?.authUserId && Number(session.authUserId) !== Number(authUserId))
    return inactive("session_subject_mismatch");

  const authUser = await data.authIdentity.model.findById(authUserId);
  if (
    !authUser ||
    !(await data.authIdentity.model.canLoginInCurrentEnvAsync(authUser))
  )
    return inactive("account_unavailable");

  const tokenClientId = sessionClientIdFromToken(claims);
  if (tokenClientId) {
    if (session?.clientId && String(session.clientId) !== tokenClientId)
      return inactive("session_client_mismatch");
    if (requireClient) {
      const client = await findClient({
        userId: Number(claims.id),
        clientId: tokenClientId,
        includeRevoked: true,
      });
      if (!client) return inactive("client_unavailable");
      if (client.revokedAt) return inactive("client_revoked");
    }
  }

  return {
    success: true,
    active: true,
    principal: safePrincipal({
      claims,
      session,
      subjectType,
      authUserId,
    }),
  };
}

async function introspectSessionToken(token, options = {}) {
  const claims = decodeJWT(compact(token, 16_384));
  return introspectSessionClaims(claims, options);
}

module.exports = {
  introspectSessionClaims,
  introspectSessionToken,
};
