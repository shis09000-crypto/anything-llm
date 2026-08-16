const {
  introspectSessionClaims,
  introspectSessionToken,
} = require("./sessionIntrospection");
const { registerClient } = require("../clientIdentity");
const { DataAccessCenter } = require("../dataAccess");
const {
  appendSigningAuditAsOwner,
  verifySignedDescriptorAsOwner,
} = require("../requestSigning");
const {
  reconcileUserStateProjectionViaCapability,
} = require("../syncV2/userStateProjectionClient");

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
    // Normal requests only verify the client already bound to the session.
    // Re-registering it here serializes every concurrent browser request.
    requireClient: true,
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
      ? { ...metadata, registered: true, revoked: false }
      : null,
  };
}

async function consumeRealtimeTicketAsOwner(ticket) {
  return DataAccessCenter.adminSystem.realtimeTicket.consumeLocal(
    bounded(ticket, 512)
  );
}

function capabilityProbe(capability) {
  return {
    success: true,
    available: true,
    capability,
    version: "1.0",
  };
}

async function validateSessionAsOwner({ token = null, claims = null } = {}) {
  const result = token
    ? await introspectSessionToken(bounded(token, 16_384))
    : await introspectSessionClaims(claims);
  if (!result.active) {
    const error = new Error(result.reasonCode || "session_invalid");
    error.code = result.reasonCode || "session_invalid";
    error.httpStatus = 401;
    throw error;
  }
  return result;
}

async function touchSessionAsOwner({ token = null, claims = null } = {}) {
  const result = await validateSessionAsOwner({ token, claims });
  const sessionId = result.principal?.sessionId;
  if (!sessionId) {
    const error = new Error("session_missing");
    error.code = "session_missing";
    error.httpStatus = 401;
    throw error;
  }
  const count =
    await DataAccessCenter.adminSystem.authSession.touchUserAction(sessionId);
  if (count !== 1) {
    const error = new Error("session_touch_rejected");
    error.code = "session_touch_rejected";
    error.httpStatus = 401;
    throw error;
  }
  return { ...result, touched: true };
}

async function verifyRequestSigningAsOwner({
  token = null,
  claims = null,
  descriptor = {},
} = {}) {
  const session = await validateSessionAsOwner({ token, claims });
  const result = await verifySignedDescriptorAsOwner({
    principal: session.principal,
    descriptor,
  });
  await appendSigningAuditAsOwner({
    principal: session.principal,
    descriptor,
    result,
    metadata: { transport: "http", capabilityOwner: "identity" },
  });
  return { session, result };
}

async function appendIdentityAuditAsOwner({
  token = null,
  claims = null,
  descriptor = {},
  result = {},
  metadata = {},
} = {}) {
  const session = await validateSessionAsOwner({ token, claims });
  await appendSigningAuditAsOwner({
    principal: session.principal,
    descriptor,
    result,
    metadata,
  });
  return { appended: true };
}

function safeUserStateFilters(values = null) {
  if (!Array.isArray(values)) return null;
  return values
    .slice(0, 64)
    .map((value) => bounded(value, 128))
    .filter(Boolean);
}

async function readUserStateAsOwner({ token, namespaces, scopes } = {}) {
  const session = await validateSessionAsOwner({ token });
  const states = await DataAccessCenter.userState.where({
    userId: session.principal.userId,
    namespaces: safeUserStateFilters(namespaces),
    scopes: safeUserStateFilters(scopes),
  });
  return { states };
}

async function upsertUserStateAsOwner({ token, states, syncContext } = {}) {
  const session = await validateSessionAsOwner({ token });
  if (!Array.isArray(states) || states.length > 64) {
    const error = new Error("user_state_payload_invalid");
    error.code = "user_state_payload_invalid";
    error.httpStatus = 400;
    throw error;
  }
  const saved = await DataAccessCenter.userState.upsertMany({
    userId: session.principal.userId,
    states,
    syncContext,
    projectSync: false,
  });
  const originalByKey = new Map(
    states.map((state) => [
      `${state.namespace}:${state.scope || "global"}`,
      state,
    ])
  );
  const projection = await reconcileUserStateProjectionViaCapability({
    userId: session.principal.userId,
    operation: "upsert",
    states: saved.map((state) => ({
      ...state,
      ...originalByKey.get(`${state.namespace}:${state.scope || "global"}`),
      value: state.value,
      version: state.version,
    })),
    syncContext,
  });
  const projectedByKey = new Map(
    (projection.states || []).map((state) => [
      `${state.namespace}:${state.scope}`,
      state,
    ])
  );
  return {
    states: saved.map((state) => ({
      ...state,
      ...(projectedByKey.get(`${state.namespace}:${state.scope || "global"}`) ||
        {}),
    })),
    projectionState: projection.status,
  };
}

async function deleteUserStateAsOwner({
  token,
  namespace,
  scope,
  syncContext,
} = {}) {
  const session = await validateSessionAsOwner({ token });
  const normalizedNamespace = bounded(namespace, 128);
  if (!normalizedNamespace) {
    const error = new Error("user_state_namespace_required");
    error.code = "user_state_namespace_required";
    error.httpStatus = 400;
    throw error;
  }
  const deleted = await DataAccessCenter.userState.delete({
    userId: session.principal.userId,
    namespace: normalizedNamespace,
    scope: bounded(scope, 256) || null,
    syncContext,
    projectSync: false,
  });
  const projection = await reconcileUserStateProjectionViaCapability({
    userId: session.principal.userId,
    operation: "delete",
    namespace: normalizedNamespace,
    scope: bounded(scope, 256) || "global",
    syncContext,
  });
  return { ...deleted, projectionState: projection.status };
}

module.exports = {
  appendIdentityAuditAsOwner,
  assertPrincipalFromSession,
  attachClientFromSession,
  capabilityProbe,
  consumeRealtimeTicketAsOwner,
  deleteUserStateAsOwner,
  readUserStateAsOwner,
  safeClientInput,
  touchSessionAsOwner,
  upsertUserStateAsOwner,
  validateSessionAsOwner,
  verifyRequestSigningAsOwner,
};
