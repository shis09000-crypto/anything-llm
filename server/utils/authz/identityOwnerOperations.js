const { introspectSessionToken } = require("./sessionIntrospection");
const { registerClient } = require("../clientIdentity");
const { DataAccessCenter } = require("../dataAccess");

function bounded(value, max = 256) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function safeClientInput(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clientId = bounded(value.clientId, 256);
  if (!clientId || clientId === "legacy") return null;
  return {
    clientId,
    platform: bounded(value.platform, 32) || "web",
    appVersion: bounded(value.appVersion, 128) || null,
    trustLevel: bounded(value.trustLevel, 32) || null,
    capabilitySource: bounded(value.capabilitySource, 32) || "unknown",
    capabilities:
      value.capabilities && typeof value.capabilities === "object"
        ? value.capabilities
        : null,
  };
}

async function attachClientFromSession({ token, client } = {}) {
  const session = await introspectSessionToken(bounded(token, 16_384), {
    requireClient: false,
  });
  if (!session.active || !session.principal?.userId) {
    const error = new Error(session.reasonCode || "session_invalid");
    error.code = session.reasonCode || "session_invalid";
    error.httpStatus = 401;
    throw error;
  }
  const metadata = safeClientInput(client);
  if (!metadata) {
    const error = new Error("client_identity_metadata_invalid");
    error.code = "client_identity_metadata_invalid";
    error.httpStatus = 400;
    throw error;
  }
  if (
    session.principal.clientId &&
    session.principal.clientId !== metadata.clientId
  ) {
    const error = new Error("session_client_mismatch");
    error.code = "session_client_mismatch";
    error.httpStatus = 401;
    throw error;
  }
  const saved = await registerClient({
    userId: session.principal.userId,
    ...metadata,
    projectSync: false,
  });
  return {
    clientId: metadata.clientId,
    registered: Boolean(saved),
    revoked: Boolean(saved?.revokedAt),
  };
}

async function assertPrincipalFromSession({ token, client } = {}) {
  const session = await introspectSessionToken(bounded(token, 16_384), {
    requireClient: false,
  });
  if (!session.active) return session;

  const metadata = safeClientInput(client);
  if (
    metadata &&
    session.principal?.clientId &&
    session.principal.clientId !== metadata.clientId
  ) {
    return {
      success: true,
      active: false,
      reasonCode: "session_client_mismatch",
    };
  }

  let registeredClient = null;
  if (metadata && session.principal?.userId) {
    registeredClient = await registerClient({
      userId: session.principal.userId,
      ...metadata,
      projectSync: false,
    });
    if (registeredClient?.revokedAt) {
      return {
        success: true,
        active: false,
        reasonCode: "client_revoked",
      };
    }
  } else if (session.principal?.clientId) {
    const authoritative = await introspectSessionToken(bounded(token, 16_384), {
      requireClient: true,
    });
    if (!authoritative.active) return authoritative;
  }

  let user = null;
  if (session.principal?.subjectType === "user") {
    const shadow = await DataAccessCenter.authIdentity.shadowUser._get({
      id: Number(session.principal.userId),
    });
    if (!shadow) {
      return {
        success: true,
        active: false,
        reasonCode: "account_unavailable",
      };
    }
    user = DataAccessCenter.authIdentity.shadowUser.filterFields(shadow);
  }

  return {
    ...session,
    user,
    client: metadata
      ? {
          ...metadata,
          registered: Boolean(registeredClient),
          revoked: false,
        }
      : null,
  };
}

async function sessionFromToken(token, { requireClient = true } = {}) {
  return introspectSessionToken(bounded(token, 16_384), { requireClient });
}

async function consumeRealtimeTicketAsOwner(ticket) {
  return DataAccessCenter.adminSystem.realtimeTicket.consumeLocal(
    bounded(ticket, 512)
  );
}

module.exports = {
  assertPrincipalFromSession,
  attachClientFromSession,
  consumeRealtimeTicketAsOwner,
  safeClientInput,
  sessionFromToken,
};
