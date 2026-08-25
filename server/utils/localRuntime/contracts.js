const crypto = require("crypto");

const LOCAL_RUNTIME_PROTOCOL = "athena.local-runtime.v1";
const LOCAL_RUNTIME_TOOLS = Object.freeze([
  "local_device_status",
  "local_desktop_observe",
  "local_desktop_act",
  "local_file_read",
  "local_file_write",
  "local_command_run",
  "local_job_cancel",
]);
const LOCAL_RUNTIME_CAPABILITIES = Object.freeze([
  "device.status",
  "desktop.observe",
  "desktop.act",
  "file.read",
  "file.write",
  "command.run",
  "job.cancel",
]);
const TERMINAL_JOB_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "denied",
  "expired",
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value))
    .digest("hex");
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function boundedString(value, maxLength = 512) {
  return String(value || "")
    .trim()
    .slice(0, maxLength);
}

function publicDevice(row, { online = null } = {}) {
  if (!row) return null;
  const inferredOnline =
    row.status === "online" &&
    row.lastSeenAt &&
    Date.now() - new Date(row.lastSeenAt).getTime() < 45_000;
  const isOnline = online === null ? inferredOnline : Boolean(online);
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    version: row.version,
    status: row.revokedAt ? "revoked" : isOnline ? "online" : row.status,
    capabilities: parseJson(row.capabilitiesJson, {}),
    permissions: parseJson(row.permissionsJson, {}),
    lastSeenAt: row.lastSeenAt?.toISOString?.() || row.lastSeenAt || null,
    pairedAt: row.pairedAt?.toISOString?.() || row.pairedAt || null,
    revokedAt: row.revokedAt?.toISOString?.() || row.revokedAt || null,
  };
}

function publicLease(row) {
  if (!row) return null;
  return {
    id: row.id,
    deviceId: row.deviceId,
    status:
      row.status === "active" && new Date(row.expiresAt).getTime() <= Date.now()
        ? "expired"
        : row.status,
    capabilities: parseJson(row.capabilitiesJson, []),
    allowedRoots: parseJson(row.allowedRootsJson, []),
    allowedApps: parseJson(row.allowedAppsJson, []),
    riskCeiling: row.riskCeiling,
    issuedAt: row.issuedAt?.toISOString?.() || row.issuedAt,
    expiresAt: row.expiresAt?.toISOString?.() || row.expiresAt,
    revokedAt: row.revokedAt?.toISOString?.() || row.revokedAt || null,
  };
}

function publicJob(row, { includeResult = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    deviceId: row.deviceId,
    leaseId: row.leaseId,
    responseId: row.responseId,
    toolName: row.toolName,
    priority: row.priority,
    executionMode: row.executionMode,
    status: row.status,
    reasonCode: row.reasonCode,
    attempt: row.attempt,
    lastSequence: row.lastSequence,
    deadlineAt: row.deadlineAt?.toISOString?.() || row.deadlineAt,
    startedAt: row.startedAt?.toISOString?.() || row.startedAt || null,
    completedAt: row.completedAt?.toISOString?.() || row.completedAt || null,
    createdAt: row.createdAt?.toISOString?.() || row.createdAt,
    ...(includeResult
      ? { result: parseJson(row.resultJson, null), resultHash: row.resultHash }
      : {}),
  };
}

function deviceSignaturePayload({ deviceId, timestamp, nonce, connectionId }) {
  return stableJson({
    protocol: LOCAL_RUNTIME_PROTOCOL,
    deviceId: boundedString(deviceId, 128),
    timestamp: Number(timestamp),
    nonce: boundedString(nonce, 256),
    connectionId: boundedString(connectionId, 128),
  });
}

function pairingSignaturePayload({
  pairingToken,
  publicKeyPem,
  timestamp,
  nonce,
  connectionId,
}) {
  return stableJson({
    connectionId: boundedString(connectionId, 128),
    nonce: boundedString(nonce, 256),
    pairingTokenHash: sha256(String(pairingToken || "")),
    protocol: LOCAL_RUNTIME_PROTOCOL,
    publicKeyHash: sha256(String(publicKeyPem || "")),
    timestamp: Number(timestamp),
  });
}

module.exports = {
  LOCAL_RUNTIME_CAPABILITIES,
  LOCAL_RUNTIME_PROTOCOL,
  LOCAL_RUNTIME_TOOLS,
  TERMINAL_JOB_STATES,
  boundedString,
  deviceSignaturePayload,
  parseJson,
  pairingSignaturePayload,
  publicDevice,
  publicJob,
  publicLease,
  sha256,
  stableJson,
  stableValue,
};
