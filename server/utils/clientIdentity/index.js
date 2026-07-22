const crypto = require("crypto");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const ClientIdentityData = lazyDataAccessFacade("clientIdentity");
const clientIdentityDb = ClientIdentityData.db;
const {
  EventLogRepository: EventLogs,
} = require("../../repositories/eventLogRepository");
const SyncV2 = lazyDataAccessFacade("syncV2");
const { nodeKeys } = require("../syncV2/nodeRegistry");
const { clientDevicesProjection } = require("../syncV2/securityProjection");
const AdminSystem = lazyDataAccessFacade("adminSystem");
const AuthSession = AdminSystem.authSession;

const CLIENT_HEADERS = {
  clientId: "X-Athena-Client-Id",
  platform: "X-Athena-Platform",
  appVersion: "X-Athena-App-Version",
  requestId: "X-Athena-Request-Id",
  capabilityProfile: "X-Athena-Capability-Profile",
  capabilitySource: "X-Athena-Capability-Source",
};

const CLIENT_QUERY = {
  clientId: "athenaClientId",
  platform: "athenaPlatform",
  appVersion: "athenaAppVersion",
  requestId: "athenaRequestId",
  capabilityProfile: "athenaCapabilityProfile",
  capabilitySource: "athenaCapabilitySource",
};

const CLIENT_PLATFORMS = new Set([
  "web",
  "desktop",
  "ipad",
  "ios",
  "android",
  "api",
]);
const TRUST_LEVELS = new Set(["low", "medium", "high"]);
const CAPABILITY_SOURCE = new Set(["declared", "detected", "unknown"]);
const LAST_SEEN_THROTTLE_MS = 60_000;
const lastSeenWrites = new Map();

async function recordClientNodeChange(
  tx,
  { userId, eventType, changedPaths, payloadHint, originClientId = null }
) {
  const content = await clientDevicesProjection(tx, userId);
  return await SyncV2.recordNodeChange(tx, {
    nodeKey: nodeKeys.userSecurityClients(userId),
    content,
    eventType,
    changedPaths,
    payloadHint,
    originClientId,
    audience: [Number(userId)],
  });
}

async function clientSecuritySyncReady({
  userId,
  maintainShadow = false,
} = {}) {
  const domainEnabled = await SyncV2.enabled("security");
  if (!domainEnabled && !maintainShadow) return false;
  if (!(await SyncV2.schemaReady())) return false;
  if (domainEnabled) return true;

  const nodeKey = nodeKeys.userSecurityClients(userId);
  const existingNode = await clientIdentityDb.sync_nodes.findUnique({
    where: { nodeKey },
    select: { nodeKey: true },
  });
  return Boolean(existingNode);
}

function headerValue(request, name) {
  return request?.header?.(name) || request?.headers?.[name.toLowerCase()];
}

function queryValue(request, name) {
  const value = request?.query?.[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function compactString(value, maxLength = 200) {
  if (value === null || value === undefined) return null;
  const next = String(value).trim();
  if (!next) return null;
  return next.slice(0, maxLength);
}

function normalizePlatform(value) {
  const normalized = compactString(value, 32)?.toLowerCase();
  return CLIENT_PLATFORMS.has(normalized) ? normalized : "api";
}

function normalizeCapabilitySource(value) {
  const normalized = compactString(value, 32)?.toLowerCase();
  return CAPABILITY_SOURCE.has(normalized) ? normalized : "unknown";
}

function clampNumber(value, { min = 0, max = 100_000, fallback = 0 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function decodeCapabilityProfile(value = null) {
  const raw = compactString(value, 4096);
  if (!raw) return null;
  const candidates = [raw];
  try {
    candidates.push(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {}
  try {
    candidates.push(decodeURIComponent(raw));
  } catch {}

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }
  return null;
}

function normalizeCapabilityProfile(profile = null) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return null;
  }

  const viewport = profile.viewport || {};
  const input = profile.input || {};
  const device = profile.device || {};
  const capabilities = profile.capabilities || {};
  const pointer = ["fine", "coarse", "none"].includes(input.pointer)
    ? input.pointer
    : "none";
  const surface = ["browser", "pwa", "desktopApp", "mobileApp"].includes(
    profile.surface
  )
    ? profile.surface
    : "browser";

  return {
    viewport: {
      width: Math.round(clampNumber(viewport.width, { max: 20_000 })),
      height: Math.round(clampNumber(viewport.height, { max: 20_000 })),
      devicePixelRatio:
        Math.round(
          clampNumber(viewport.devicePixelRatio, {
            min: 0,
            max: 16,
            fallback: 1,
          }) * 100
        ) / 100,
    },
    input: {
      touch: !!input.touch,
      hover: !!input.hover,
      pointer,
    },
    surface,
    device: {
      formFactor: ["desktop", "tablet", "phone", "unknown"].includes(
        device.formFactor
      )
        ? device.formFactor
        : "unknown",
      family: compactString(device.family, 64) || "unknown",
      os: compactString(device.os, 64) || "unknown",
    },
    capabilities: {
      camera: !!capabilities.camera,
      microphone: !!capabilities.microphone,
      filePicker: !!capabilities.filePicker,
      notifications: !!capabilities.notifications,
      clipboard: !!capabilities.clipboard,
    },
  };
}

function adaptiveSummaryFromProfile(profile = null) {
  if (!profile) return {};
  const width = Number(profile.viewport?.width || 0);
  const pointer = profile.input?.pointer || "none";
  const layoutMode =
    width < 768 ? "mobile" : width < 1200 ? "tablet" : "desktop";
  const inputMode =
    pointer === "fine" || profile.input?.hover
      ? "mouse"
      : profile.input?.touch || pointer === "coarse"
        ? "touch"
        : "mouse";
  const surface =
    profile.surface === "desktopApp"
      ? "desktop-app"
      : profile.surface === "mobileApp"
        ? "mobile-app"
        : profile.surface || "browser";

  return { layoutMode, inputMode, surface };
}

function defaultCapabilities(platform = "api") {
  switch (normalizePlatform(platform)) {
    case "desktop":
      return {
        fileSystem: true,
        notifications: true,
        localModel: true,
        screenshot: true,
        clipboard: true,
      };
    case "ipad":
    case "ios":
    case "android":
      return {
        fileSystem: false,
        notifications: true,
        localModel: false,
        screenshot: false,
        clipboard: true,
      };
    case "web":
      return {
        fileSystem: false,
        notifications: true,
        localModel: false,
        screenshot: false,
        clipboard: true,
      };
    case "api":
    default:
      return {
        fileSystem: false,
        notifications: false,
        localModel: false,
        screenshot: false,
        clipboard: false,
      };
  }
}

function capabilitiesFromProfile(platform, profile = null) {
  const base = defaultCapabilities(platform);
  if (!profile) return base;
  return {
    ...base,
    ...profile.capabilities,
    profile,
  };
}

function resolveTrustLevel(platform, { verified = false } = {}) {
  if (verified) return "high";
  switch (normalizePlatform(platform)) {
    case "desktop":
    case "ipad":
    case "ios":
    case "android":
      return "medium";
    case "web":
    case "api":
    default:
      return "low";
  }
}

function resourceIdHash(resourceId = null) {
  if (resourceId === null || resourceId === undefined) return null;
  return crypto
    .createHash("sha256")
    .update(String(resourceId))
    .digest("hex")
    .slice(0, 16);
}

function parseClientMetadata(request) {
  const clientId =
    compactString(headerValue(request, CLIENT_HEADERS.clientId)) ||
    compactString(queryValue(request, CLIENT_QUERY.clientId));
  const platform =
    compactString(headerValue(request, CLIENT_HEADERS.platform)) ||
    compactString(queryValue(request, CLIENT_QUERY.platform));
  const appVersion =
    compactString(headerValue(request, CLIENT_HEADERS.appVersion), 128) ||
    compactString(queryValue(request, CLIENT_QUERY.appVersion), 128);
  const requestId =
    compactString(headerValue(request, CLIENT_HEADERS.requestId), 128) ||
    compactString(queryValue(request, CLIENT_QUERY.requestId), 128);
  const capabilityProfile = normalizeCapabilityProfile(
    decodeCapabilityProfile(
      headerValue(request, CLIENT_HEADERS.capabilityProfile) ||
        queryValue(request, CLIENT_QUERY.capabilityProfile)
    )
  );
  const capabilitySource =
    compactString(headerValue(request, CLIENT_HEADERS.capabilitySource), 32) ||
    compactString(queryValue(request, CLIENT_QUERY.capabilitySource), 32);

  const normalizedPlatform = normalizePlatform(platform || "api");
  const hasClientHeaders = !!clientId;
  const adaptiveSummary = adaptiveSummaryFromProfile(capabilityProfile);
  return {
    clientId: clientId || "legacy",
    platform: normalizedPlatform,
    appVersion: appVersion || null,
    requestId: requestId || null,
    trustLevel: resolveTrustLevel(normalizedPlatform),
    capabilities: capabilitiesFromProfile(
      normalizedPlatform,
      capabilityProfile
    ),
    capabilitySource: normalizeCapabilitySource(
      capabilitySource || (capabilityProfile ? "detected" : "unknown")
    ),
    capabilityProfile,
    ...adaptiveSummary,
    publicKey: null,
    deviceFingerprintVersion: null,
    legacy: !hasClientHeaders,
  };
}

function getClientContext(request, { user = null } = {}) {
  const existing = request?.clientContext;
  const metadata = existing || parseClientMetadata(request);
  const next = {
    ...metadata,
    userId: user?.id ? Number(user.id) : existing?.userId || null,
  };
  if (request) request.clientContext = next;
  require("../observability/operationContext").enrichOperationContext({
    clientId: next.clientId,
    platform: next.platform,
    requestId: next.requestId,
  });
  return next;
}

async function registerClient({
  userId,
  clientId,
  platform,
  deviceName = null,
  appVersion = null,
  trustLevel = null,
  capabilities = null,
  capabilitySource = "unknown",
  publicKey = null,
  deviceFingerprintVersion = null,
} = {}) {
  if (!userId || !clientId || clientId === "legacy") return null;
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedTrust = TRUST_LEVELS.has(trustLevel)
    ? trustLevel
    : resolveTrustLevel(normalizedPlatform);
  const normalizedCapabilities =
    capabilities && typeof capabilities === "object"
      ? capabilities
      : defaultCapabilities(normalizedPlatform);
  const now = new Date();

  const where = {
    userId_clientId: {
      userId: Number(userId),
      clientId: String(clientId),
    },
  };
  const data = {
    platform: normalizedPlatform,
    deviceName: compactString(deviceName, 128),
    appVersion: compactString(appVersion, 128),
    trustLevel: normalizedTrust,
    capabilities: JSON.stringify(normalizedCapabilities),
    capabilitySource: normalizeCapabilitySource(capabilitySource),
  };

  const syncReady = await clientSecuritySyncReady({
    userId,
    // Initial device-key enrollment is a security transition. If a shadow
    // node already exists, keep it authoritative even while client rollout is
    // disabled; ordinary request metadata keeps the zero-extra-query path.
    maintainShadow: Boolean(publicKey),
  });
  if (!syncReady) {
    const existing = await clientIdentityDb.athena_clients.findUnique({
      where,
    });
    if (existing?.revokedAt) return existing;
    if (existing) {
      const nextPublicKey =
        !existing.publicKey && publicKey
          ? compactString(publicKey, 2048)
          : null;
      return clientIdentityDb.athena_clients.update({
        where: { id: existing.id },
        data: {
          ...data,
          ...(nextPublicKey
            ? {
                publicKey: nextPublicKey,
                deviceFingerprintVersion: compactString(
                  deviceFingerprintVersion,
                  32
                ),
              }
            : {}),
          lastSeenAt: now,
        },
      });
    }
    return clientIdentityDb.athena_clients.create({
      data: {
        userId: Number(userId),
        clientId: String(clientId),
        ...data,
        publicKey: publicKey || null,
        deviceFingerprintVersion: compactString(deviceFingerprintVersion, 32),
        lastSeenAt: now,
      },
    });
  }

  return await clientIdentityDb.$transaction(async (tx) => {
    const existing = await tx.athena_clients.findUnique({ where });
    if (existing?.revokedAt) return existing;
    const nextPublicKey =
      existing && !existing.publicKey && publicKey
        ? compactString(publicKey, 2048)
        : null;
    const nextFingerprintVersion = nextPublicKey
      ? compactString(deviceFingerprintVersion, 32)
      : existing?.deviceFingerprintVersion ||
        compactString(deviceFingerprintVersion, 32);
    const meaningfulChange =
      !existing ||
      existing.platform !== data.platform ||
      existing.deviceName !== data.deviceName ||
      existing.appVersion !== data.appVersion ||
      existing.trustLevel !== data.trustLevel ||
      existing.capabilities !== data.capabilities ||
      existing.capabilitySource !== data.capabilitySource ||
      Boolean(nextPublicKey) ||
      existing.deviceFingerprintVersion !== nextFingerprintVersion;
    const saved = existing
      ? await tx.athena_clients.update({
          where: { id: existing.id },
          data: {
            ...data,
            ...(nextPublicKey
              ? {
                  publicKey: nextPublicKey,
                  deviceFingerprintVersion: nextFingerprintVersion,
                }
              : {}),
            lastSeenAt: now,
          },
        })
      : await tx.athena_clients.create({
          data: {
            userId: Number(userId),
            clientId: String(clientId),
            ...data,
            publicKey: publicKey || null,
            deviceFingerprintVersion: nextFingerprintVersion,
            lastSeenAt: now,
          },
        });
    if (meaningfulChange) {
      await recordClientNodeChange(tx, {
        userId,
        eventType: existing ? "client.updated" : "client.registered",
        changedPaths: [`clients.${String(clientId)}`],
        payloadHint: {
          operation: existing ? "update" : "add",
          clientId: String(clientId),
        },
        originClientId: clientId,
      });
    }
    return saved;
  });
}

function safeCapabilities(value) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function safeClientRecord(client = null, { currentClientId = null } = {}) {
  if (!client) return null;
  return {
    clientId: client.clientId,
    platform: client.platform,
    deviceName: client.deviceName || null,
    appVersion: client.appVersion || null,
    trustLevel: client.trustLevel,
    capabilities: safeCapabilities(client.capabilities),
    capabilitySource: client.capabilitySource || "unknown",
    hasDevicePublicKey: !!client.publicKey,
    createdAt: client.createdAt,
    lastSeenAt: client.lastSeenAt,
    revokedAt: client.revokedAt || null,
    isCurrentClient: !!currentClientId && client.clientId === currentClientId,
  };
}

async function getClientRecord({
  userId,
  clientId,
  includeRevoked = false,
} = {}) {
  if (!userId || !clientId || clientId === "legacy") return null;
  return clientIdentityDb.athena_clients.findFirst({
    where: {
      userId: Number(userId),
      clientId: String(clientId),
      ...(includeRevoked ? {} : { revokedAt: null }),
    },
  });
}

async function listUserClients({ userId, currentClientId = null } = {}) {
  if (!userId) return [];
  const clients = await clientIdentityDb.athena_clients.findMany({
    where: { userId: Number(userId) },
    orderBy: [{ revokedAt: "asc" }, { lastSeenAt: "desc" }],
  });
  return clients.map((client) => safeClientRecord(client, { currentClientId }));
}

async function prepareClientDeviceKeyRotation({
  userId,
  clientId,
  publicKey,
  deviceKeyAlgorithm,
} = {}) {
  if (!userId || !clientId || clientId === "legacy") return null;
  const client = await getClientRecord({ userId, clientId });
  if (!client) return null;
  if (client.publicKey === publicKey) {
    return { client, prepared: false, alreadyCurrent: true };
  }
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const updated = await clientIdentityDb.athena_clients.update({
    where: { id: client.id },
    data: {
      pendingPublicKey: publicKey,
      pendingDeviceKeyAlgorithm: deviceKeyAlgorithm,
      pendingDeviceKeyExpiresAt: expiresAt,
    },
  });
  return { client: updated, prepared: true, alreadyCurrent: false, expiresAt };
}

async function commitClientDeviceKeyRotation({
  userId,
  clientId,
  publicKey,
  deviceKeyAlgorithm,
} = {}) {
  if (!userId || !clientId || clientId === "legacy") return null;
  const syncReady = await clientSecuritySyncReady({
    userId,
    maintainShadow: true,
  });
  const update = async (tx) => {
    const client = await tx.athena_clients.findFirst({
      where: {
        userId: Number(userId),
        clientId: String(clientId),
        revokedAt: null,
      },
    });
    if (!client) return null;
    if (client.publicKey === publicKey) {
      return { client, rotated: false, alreadyCurrent: true };
    }
    if (
      client.pendingPublicKey !== publicKey ||
      client.pendingDeviceKeyAlgorithm !== deviceKeyAlgorithm ||
      !client.pendingDeviceKeyExpiresAt ||
      new Date(client.pendingDeviceKeyExpiresAt).getTime() <= Date.now()
    ) {
      return { client, rotated: false, pendingMismatch: true };
    }
    const saved = await tx.athena_clients.update({
      where: { id: client.id },
      data: {
        publicKey,
        deviceFingerprintVersion: deviceKeyAlgorithm,
        trustLevel: "high",
        pendingPublicKey: null,
        pendingDeviceKeyAlgorithm: null,
        pendingDeviceKeyExpiresAt: null,
      },
    });
    if (syncReady) {
      await recordClientNodeChange(tx, {
        userId,
        eventType: "client.device_key_rotated",
        changedPaths: [
          `clients.${String(clientId)}.hasDevicePublicKey`,
          `clients.${String(clientId)}.deviceFingerprintVersion`,
        ],
        payloadHint: {
          operation: "device-key-rotate",
          clientId: String(clientId),
          deviceKeyAlgorithm,
        },
        originClientId: clientId,
      });
    }
    return { client: saved, rotated: true, alreadyCurrent: false };
  };
  return syncReady
    ? clientIdentityDb.$transaction(update)
    : update(clientIdentityDb);
}

async function revokeClient({ userId, clientId } = {}) {
  const client = await getClientRecord({
    userId,
    clientId,
    includeRevoked: true,
  });
  if (!client) return null;
  if (client.revokedAt) {
    return { client, revoked: false, alreadyRevoked: true };
  }

  const revokedAt = new Date();
  const syncReady = await clientSecuritySyncReady({
    userId,
    maintainShadow: true,
  });
  const result = syncReady
    ? await clientIdentityDb.$transaction(async (tx) => {
        const updated = await tx.athena_clients.updateMany({
          where: {
            userId: Number(userId),
            clientId: String(clientId),
            revokedAt: null,
          },
          data: { revokedAt },
        });
        if (updated.count > 0) {
          await recordClientNodeChange(tx, {
            userId,
            eventType: "client.revoked",
            changedPaths: [`clients.${String(clientId)}.revokedAt`],
            payloadHint: { operation: "revoke", clientId: String(clientId) },
          });
        }
        return updated;
      })
    : await clientIdentityDb.athena_clients.updateMany({
        where: {
          userId: Number(userId),
          clientId: String(clientId),
          revokedAt: null,
        },
        data: { revokedAt },
      });
  if (result.count > 0) await revokeAuthSessionsForClient({ userId, clientId });
  return {
    client: { ...client, revokedAt },
    revoked: result.count > 0,
    alreadyRevoked: false,
  };
}

async function revokeAllOtherClients({ userId, currentClientId } = {}) {
  if (!userId || !currentClientId || currentClientId === "legacy") {
    return { count: 0 };
  }
  const where = {
    userId: Number(userId),
    clientId: { not: String(currentClientId) },
    revokedAt: null,
  };
  const targets = await clientIdentityDb.athena_clients.findMany({
    where,
    select: { clientId: true },
  });
  const syncReady = await clientSecuritySyncReady({
    userId,
    maintainShadow: true,
  });
  if (!syncReady) {
    const result = await clientIdentityDb.athena_clients.updateMany({
      where,
      data: { revokedAt: new Date() },
    });
    await Promise.all(
      targets.map(({ clientId }) =>
        revokeAuthSessionsForClient({ userId, clientId })
      )
    );
    return result;
  }
  const result = await clientIdentityDb.$transaction(async (tx) => {
    const result = await tx.athena_clients.updateMany({
      where,
      data: { revokedAt: new Date() },
    });
    if (result.count > 0) {
      await recordClientNodeChange(tx, {
        userId,
        eventType: "client.revoked_all_others",
        changedPaths: targets.map(
          (target) => `clients.${target.clientId}.revokedAt`
        ),
        payloadHint: {
          operation: "revoke-all-others",
          excludedClientId: String(currentClientId),
          revokedCount: result.count,
        },
        originClientId: currentClientId,
      });
    }
    return result;
  });
  await Promise.all(
    targets.map(({ clientId }) =>
      revokeAuthSessionsForClient({ userId, clientId })
    )
  );
  return result;
}

async function revokeAuthSessionsForClient({ userId, clientId }) {
  const user = await clientIdentityDb.users.findUnique({
    where: { id: Number(userId) },
    select: { authUserId: true },
  });
  if (!user?.authUserId) return { count: 0 };
  return AuthSession.revokeClient({
    authUserId: user.authUserId,
    clientId,
    reason: "device_revoked",
  });
}

async function updateLastSeen({ userId, clientId } = {}) {
  if (!userId || !clientId || clientId === "legacy") return null;
  const key = `${userId}:${clientId}`;
  const nowMs = Date.now();
  const lastWrite = lastSeenWrites.get(key) || 0;
  if (nowMs - lastWrite < LAST_SEEN_THROTTLE_MS) return null;
  lastSeenWrites.set(key, nowMs);

  return clientIdentityDb.athena_clients.updateMany({
    where: {
      userId: Number(userId),
      clientId: String(clientId),
      revokedAt: null,
    },
    data: { lastSeenAt: new Date(nowMs) },
  });
}

async function attachAuthenticatedClientContext({ request, user } = {}) {
  const context = getClientContext(request, { user });
  if (!context.userId || context.legacy) return context;

  try {
    await registerClient({
      userId: context.userId,
      clientId: context.clientId,
      platform: context.platform,
      appVersion: context.appVersion,
      trustLevel: context.trustLevel,
      capabilities: context.capabilities,
      capabilitySource: context.capabilitySource,
      publicKey: null,
      deviceFingerprintVersion: null,
    });
    await updateLastSeen({
      userId: context.userId,
      clientId: context.clientId,
    });
  } catch (error) {
    console.warn("[client-identity] Failed to register client", error.message);
  }

  return context;
}

function clientAuditMetadata(request) {
  const context = getClientContext(request);
  return {
    clientId: context.clientId,
    platform: context.platform,
    trustLevel: context.trustLevel,
    appVersion: context.appVersion,
    requestId: context.requestId,
    layoutMode: context.layoutMode || null,
    inputMode: context.inputMode || null,
    surface: context.surface || null,
  };
}

function safeAuditMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(([key, value]) => {
      if (value === undefined) return false;
      return !/(authorization|cookie|token|secret|publickey|fingerprint)/i.test(
        key
      );
    })
  );
}

async function recordClientTrustCheckpoint(
  request,
  {
    action,
    resourceType = null,
    resourceId = null,
    outcome = "observed",
    metadata = {},
  } = {}
) {
  const context = getClientContext(request);
  const payload = {
    ...safeAuditMetadata(metadata),
    action,
    resourceType,
    resourceIdHash: resourceIdHash(resourceId),
    outcome,
    ...clientAuditMetadata(request),
  };

  try {
    await EventLogs.logEvent(
      "client_trust_checkpoint",
      payload,
      context.userId || null
    );
  } catch (error) {
    console.warn(
      "[client-identity] Failed to record checkpoint",
      error.message
    );
  }

  return { allowed: true, clientContext: context };
}

function clientIdentityMiddleware(request, _response, next) {
  getClientContext(request);
  next();
}

module.exports = {
  CLIENT_HEADERS,
  CLIENT_QUERY,
  clientAuditMetadata,
  clientIdentityMiddleware,
  getClientContext,
  getClientRecord,
  listUserClients,
  recordClientTrustCheckpoint,
  registerClient,
  commitClientDeviceKeyRotation,
  prepareClientDeviceKeyRotation,
  revokeAllOtherClients,
  revokeClient,
  resolveTrustLevel,
  attachAuthenticatedClientContext,
  updateLastSeen,
};
