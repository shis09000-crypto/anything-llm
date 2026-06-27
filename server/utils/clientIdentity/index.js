const crypto = require("crypto");
const prisma = require("../prisma");
const { EventLogs } = require("../../models/eventLogs");

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

const CLIENT_PLATFORMS = new Set(["web", "desktop", "ios", "android", "api"]);
const TRUST_LEVELS = new Set(["low", "medium", "high"]);
const CAPABILITY_SOURCE = new Set(["declared", "detected", "unknown"]);
const LAST_SEEN_THROTTLE_MS = 60_000;
const lastSeenWrites = new Map();

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
  const existing = await prisma.athena_clients.findUnique({ where });
  if (existing?.revokedAt) return existing;

  const data = {
    platform: normalizedPlatform,
    deviceName: compactString(deviceName, 128),
    appVersion: compactString(appVersion, 128),
    trustLevel: normalizedTrust,
    capabilities: JSON.stringify(normalizedCapabilities),
    capabilitySource: normalizeCapabilitySource(capabilitySource),
  };

  if (existing) {
    return prisma.athena_clients.update({
      where: { id: existing.id },
      data: {
        ...data,
        lastSeenAt: now,
      },
    });
  }

  return prisma.athena_clients.create({
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
  return prisma.athena_clients.findFirst({
    where: {
      userId: Number(userId),
      clientId: String(clientId),
      ...(includeRevoked ? {} : { revokedAt: null }),
    },
  });
}

async function listUserClients({ userId, currentClientId = null } = {}) {
  if (!userId) return [];
  const clients = await prisma.athena_clients.findMany({
    where: { userId: Number(userId) },
    orderBy: [{ revokedAt: "asc" }, { lastSeenAt: "desc" }],
  });
  return clients.map((client) => safeClientRecord(client, { currentClientId }));
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
  const result = await prisma.athena_clients.updateMany({
    where: {
      userId: Number(userId),
      clientId: String(clientId),
      revokedAt: null,
    },
    data: { revokedAt },
  });
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
  return prisma.athena_clients.updateMany({
    where: {
      userId: Number(userId),
      clientId: { not: String(currentClientId) },
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
}

async function updateLastSeen({ userId, clientId } = {}) {
  if (!userId || !clientId || clientId === "legacy") return null;
  const key = `${userId}:${clientId}`;
  const nowMs = Date.now();
  const lastWrite = lastSeenWrites.get(key) || 0;
  if (nowMs - lastWrite < LAST_SEEN_THROTTLE_MS) return null;
  lastSeenWrites.set(key, nowMs);

  return prisma.athena_clients.updateMany({
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
  revokeAllOtherClients,
  revokeClient,
  resolveTrustLevel,
  attachAuthenticatedClientContext,
  updateLastSeen,
};
