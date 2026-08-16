const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const { nodeKeys } = require("./nodeRegistry");

const SyncV2 = lazyDataAccessFacade("syncV2");
const MAX_CLIENTS_PER_PROJECTION = 100;

function compact(value, maxLength = 256) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function timestamp(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeClientDevicesProjection(content = []) {
  if (!Array.isArray(content)) return [];
  return content.slice(0, MAX_CLIENTS_PER_PROJECTION).map((client) => ({
    clientId: compact(client?.clientId, 256),
    platform: compact(client?.platform, 32),
    deviceName: compact(client?.deviceName, 128),
    appVersion: compact(client?.appVersion, 128),
    trustLevel: compact(client?.trustLevel, 32),
    capabilitySource: compact(client?.capabilitySource, 32),
    deviceFingerprintVersion: compact(client?.deviceFingerprintVersion, 96),
    attestationProvider: compact(client?.attestationProvider, 64),
    attestationStatus: compact(client?.attestationStatus, 32),
    attestationEnvironment: compact(client?.attestationEnvironment, 32),
    attestedAt: timestamp(client?.attestedAt),
    attestationExpiresAt: timestamp(client?.attestationExpiresAt),
    createdAt: timestamp(client?.createdAt),
    revokedAt: timestamp(client?.revokedAt),
  }));
}

async function reconcileClientSecurityProjection({
  userId,
  content,
  maintainShadow = false,
  eventType = "client.changed",
  changedPaths = ["clients"],
  payloadHint = {},
  originClientId = null,
} = {}) {
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
    const error = new Error("sync_client_projection_user_invalid");
    error.code = "sync_client_projection_user_invalid";
    throw error;
  }

  const nodeKey = nodeKeys.userSecurityClients(normalizedUserId);
  const domainEnabled = await SyncV2.enabled("security");
  if (!domainEnabled && !maintainShadow)
    return { status: "skipped", reasonCode: "security_domain_disabled" };
  if (!(await SyncV2.schemaReady()))
    return { status: "deferred", reasonCode: "sync_schema_unavailable" };
  if (
    !domainEnabled &&
    !(await SyncV2.nodeExists({
      nodeKey,
    }))
  )
    return { status: "skipped", reasonCode: "security_shadow_absent" };

  const result = await SyncV2.reconcileNode({
    nodeKey,
    content: normalizeClientDevicesProjection(content),
    emitOnCreate: domainEnabled,
    eventType,
    changedPaths,
    payloadHint,
    originClientId,
    audience: [normalizedUserId],
  });
  return {
    status: "reconciled",
    node: result?.node || null,
    emitted: Boolean(result?.event),
  };
}

module.exports = {
  MAX_CLIENTS_PER_PROJECTION,
  normalizeClientDevicesProjection,
  reconcileClientSecurityProjection,
};
