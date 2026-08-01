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

async function consumeRealtimeTicketAsOwner(ticket) {
  return DataAccessCenter.adminSystem.realtimeTicket.consumeLocal(
    bounded(ticket, 512)
  );
}

module.exports = {
  attachClientFromSession,
  consumeRealtimeTicketAsOwner,
  safeClientInput,
};
