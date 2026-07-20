const authPrisma = require("../authPrisma");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const { nodeKeys } = require("./nodeRegistry");
const {
  authSessionStateRevision,
  passkeysProjection,
} = require("./securityProjection");

const SyncV2 = lazyDataAccessFacade("syncV2");

async function reconcilePasskeysForShadowUser({
  shadowUserId,
  authUserId,
  eventType = "passkey.changed",
  changedPaths = ["passkeys"],
  payloadHint = {},
} = {}) {
  if (!shadowUserId || !authUserId || !(await SyncV2.enabled("security")))
    return null;
  if (!(await SyncV2.schemaReady())) return null;
  try {
    const content = await passkeysProjection(authPrisma, authUserId);
    return await SyncV2.reconcileNode({
      nodeKey: nodeKeys.userSecurityPasskeys(shadowUserId),
      content,
      emitOnCreate: true,
      eventType,
      changedPaths,
      payloadHint,
      audience: [Number(shadowUserId)],
    });
  } catch (error) {
    console.warn("[SyncV2] passkey reconciliation deferred", {
      userId: Number(shadowUserId),
      code: error?.code || "passkey_reconcile_failed",
    });
    return null;
  }
}

async function reconcileSessionsForAuthUser({
  authUserId,
  eventType = "session.changed",
  changedPaths = ["sessions"],
  payloadHint = {},
  originClientId = null,
  throwOnFailure = false,
} = {}) {
  if (!authUserId || !(await SyncV2.enabled("security"))) return null;
  if (!(await SyncV2.schemaReady())) return null;
  try {
    const sourceRevision = await authSessionStateRevision(
      authPrisma,
      authUserId
    );
    return await SyncV2.recordAuthSessionChange({
      authUserId,
      eventType,
      changedPaths,
      payloadHint: { ...payloadHint, sourceRevision },
      originClientId,
      sourceRevision,
    });
  } catch (error) {
    console.warn("[SyncV2] auth session reconciliation deferred", {
      authUserId: Number(authUserId),
      code: error?.code || "session_reconcile_failed",
    });
    if (throwOnFailure) throw error;
    return null;
  }
}

module.exports = {
  reconcilePasskeysForShadowUser,
  reconcileSessionsForAuthUser,
};
