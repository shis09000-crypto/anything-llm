const crypto = require("crypto");
const prisma = require("../prisma");
const { EncryptionManager } = require("../EncryptionManager");
const {
  CLIENT_HEADERS,
  clientAuditMetadata,
  getClientRecord,
  getClientContext,
  recordClientTrustCheckpoint,
  registerClient,
} = require("../clientIdentity");
const { safeJsonParse } = require("../http");

const SIGNATURE_VERSION = "v1";
const SIGNATURE_PREFIX = "ATHENA-SIGN-V1";
const CLIENT_REVOKED_ERROR = "CLIENT_REVOKED";
const INVALID_SIGNATURE_ERROR = "INVALID_SIGNATURE";
const SIGNING_SECRET_ROTATED_ERROR = "SIGNING_SECRET_ROTATED";
const DEFAULT_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;
const NONCE_CLEANUP_INTERVAL_MS = 60 * 1000;
const NONCE_VOLUME_AUDIT_INTERVAL_MS = 5 * 60 * 1000;
const signingEncryption = new EncryptionManager();
let lastNonceCleanupAt = 0;
const nonceVolumeAuditAt = new Map();

const SIGNING_HEADERS = {
  timestamp: "X-Athena-Timestamp",
  nonce: "X-Athena-Nonce",
  bodySha256: "X-Athena-Body-SHA256",
  signature: "X-Athena-Signature",
  signatureVersion: "X-Athena-Signature-Version",
};

function compactString(value, maxLength = 512) {
  if (value === null || value === undefined) return null;
  const next = String(value).trim();
  if (!next) return null;
  return next.slice(0, maxLength);
}

function headerValue(request, name) {
  return request?.header?.(name) || request?.headers?.[name.toLowerCase()];
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function signatureWindowMs() {
  return numericEnv("ATHENA_SIGNATURE_WINDOW_MS", DEFAULT_SIGNATURE_WINDOW_MS);
}

function nonceTtlMs() {
  return numericEnv("ATHENA_NONCE_TTL_MS", DEFAULT_NONCE_TTL_MS);
}

function signingWarnOnly() {
  if (process.env.ATHENA_REQUIRE_SIGNED_HIGH_RISK === "true") return false;
  if (process.env.ATHENA_SIGNING_WARN_ONLY === "true") return true;
  if (process.env.ATHENA_SIGNING_WARN_ONLY === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function sha256Base64Url(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

function hmacBase64Url(secret, value) {
  return crypto
    .createHmac("sha256", secret)
    .update(String(value))
    .digest("base64url");
}

function newSigningSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function newSigningSecretVersion() {
  return `sec_${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}`;
}

function signingErrorCode(reasonCode) {
  if (reasonCode === "client_revoked") return CLIENT_REVOKED_ERROR;
  if (reasonCode === "signature_mismatch") return INVALID_SIGNATURE_ERROR;
  if (reasonCode === "signing_secret_rotated")
    return SIGNING_SECRET_ROTATED_ERROR;
  return "invalid_signed_request";
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function canonicalPathForRequest(request) {
  return request?.originalUrl || request?.url || "/";
}

function canonicalSigningString({
  method,
  canonicalPath,
  timestamp,
  nonce,
  requestId,
  clientId,
  bodySha256,
}) {
  return [
    SIGNATURE_PREFIX,
    String(method || "").toUpperCase(),
    canonicalPath,
    timestamp,
    nonce,
    requestId,
    clientId,
    bodySha256,
  ].join("\n");
}

function highRiskComparablePath(value = "") {
  const path = String(value || "/").split("?")[0] || "/";
  return path.startsWith("/api/") ? path.slice(4) : path;
}

function isHighRiskSignedRequest({ method, path } = {}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return false;
  const comparablePath = highRiskComparablePath(path);

  const highRiskRoutes = [
    {
      methods: ["POST"],
      pattern: /^\/auth\/passkeys\/register\/(?:options|verify)$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/auth\/trusted-devices\/enable$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/agent-invocation\/[^/]+\/clarification-response$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/auth\/passkeys\/[^/]+$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/auth\/trusted-devices\/[^/]+$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/auth\/zk-login\/devices\/[^/]+$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/system\/user$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/system\/user\/memory\/[^/]+$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user\/memory\/[^/]+\/reveal$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user\/memory\/reauth\/passkey\/(?:options|verify)$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user\/memory\/(?:candidates|rebuild)$/,
    },
    {
      methods: ["PATCH"],
      pattern: /^\/system\/user\/memory\/[^/]+$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user\/delete\/reauth\/password$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user\/email-verification\/(?:request|confirm)$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/system\/remove-documents?$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/system\/remove-folder$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/prompt-variables$/,
    },
    {
      methods: ["PUT", "DELETE"],
      pattern: /^\/system\/prompt-variables\/[^/]+$/,
    },
  ];
  if (
    highRiskRoutes.some(
      (route) =>
        route.methods.includes(normalizedMethod) &&
        route.pattern.test(comparablePath)
    )
  ) {
    return true;
  }

  if (
    normalizedMethod === "POST" &&
    /^\/workspace\/[^/]+\/tool-approval$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/workspace\/[^/]+$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/workspace\/[^/]+\/remove-and-unembed$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/reader-documents\/[^/]+$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/workspace\/[^/]+\/reader-documents\/[^/]+$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    ["POST", "DELETE"].includes(normalizedMethod) &&
    /^\/crypto-component-experiment(?:\/[^/]+)?\/config$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod) &&
    comparablePath.startsWith("/admin/")
  ) {
    return true;
  }
  if (
    normalizedMethod === "POST" &&
    /^\/client-identity\/revoke(?:-all-others)?$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "POST" &&
    /^\/client-identity\/rotate-(?:signing-secret|all-signing-secrets)$/.test(
      comparablePath
    )
  ) {
    return true;
  }

  return false;
}

function requestSigningHeaders(request) {
  return {
    clientId: compactString(headerValue(request, CLIENT_HEADERS.clientId), 256),
    requestId: compactString(
      headerValue(request, CLIENT_HEADERS.requestId),
      256
    ),
    timestamp: compactString(headerValue(request, SIGNING_HEADERS.timestamp)),
    nonce: compactString(headerValue(request, SIGNING_HEADERS.nonce), 256),
    bodySha256: compactString(
      headerValue(request, SIGNING_HEADERS.bodySha256),
      256
    ),
    signature: compactString(
      headerValue(request, SIGNING_HEADERS.signature),
      1024
    ),
    signatureVersion: compactString(
      headerValue(request, SIGNING_HEADERS.signatureVersion),
      32
    ),
  };
}

function parseTimestamp(value) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function signingFailure(reasonCode, details = {}) {
  return {
    ok: false,
    reasonCode,
    details,
  };
}

async function cleanupExpiredNonces() {
  const now = Date.now();
  if (now - lastNonceCleanupAt < NONCE_CLEANUP_INTERVAL_MS) return;
  lastNonceCleanupAt = now;

  try {
    await prisma.athena_request_nonces.deleteMany({
      where: { expiresAt: { lt: new Date(now) } },
    });
  } catch (error) {
    console.warn("[request-signing] Nonce cleanup failed", error.message);
  }
}

async function auditNonceVolume({ clientId, userId } = {}) {
  if (!clientId || typeof prisma.athena_request_nonces.count !== "function")
    return;

  const threshold = numericEnv("ATHENA_NONCE_WARNING_THRESHOLD", 5_000);
  const now = Date.now();
  const lastAuditAt = nonceVolumeAuditAt.get(clientId) || 0;
  if (now - lastAuditAt < NONCE_VOLUME_AUDIT_INTERVAL_MS) return;

  try {
    const activeNonceCount = await prisma.athena_request_nonces.count({
      where: {
        clientId: String(clientId),
        expiresAt: { gt: new Date(now) },
      },
    });
    if (activeNonceCount >= threshold) {
      nonceVolumeAuditAt.set(clientId, now);
      console.warn("[request-signing] High active nonce volume", {
        clientId,
        userId: userId || null,
        activeNonceCount,
        threshold,
      });
    }
  } catch (error) {
    console.warn("[request-signing] Nonce volume audit failed", error.message);
  }
}

async function clientSigningSecret({ userId, clientId } = {}) {
  if (!userId || !clientId || clientId === "legacy") return null;
  const client = await getClientRecord({
    userId,
    clientId,
    includeRevoked: true,
  });
  if (client?.revokedAt) return { client, secret: null, revoked: true };
  if (!client?.signingSecretEncrypted) return null;

  const secret = signingEncryption.decrypt(client.signingSecretEncrypted);
  return secret ? { client, secret } : null;
}

async function ensureClientSigningSecret({ context } = {}) {
  if (!context?.userId || !context?.clientId || context.clientId === "legacy") {
    return null;
  }

  const client = await getClientRecord({
    userId: context.userId,
    clientId: context.clientId,
    includeRevoked: true,
  });
  if (client?.revokedAt) {
    return { revoked: true, client };
  }

  const existing = await clientSigningSecret({
    userId: context.userId,
    clientId: context.clientId,
  });
  if (existing?.secret) {
    return {
      secret: existing.secret,
      signatureVersion: SIGNATURE_VERSION,
      signingSecretVersion: existing.client.signingSecretVersion || null,
      issuedAt: existing.client.signingSecretIssuedAt,
      rotatedAt: existing.client.signingSecretRotatedAt || null,
    };
  }

  const secret = newSigningSecret();
  const encrypted = signingEncryption.encrypt(secret);
  if (!encrypted) return null;

  const signingSecretVersion = newSigningSecretVersion();
  await registerClient({
    userId: context.userId,
    clientId: context.clientId,
    platform: context.platform,
    appVersion: context.appVersion,
    trustLevel: context.trustLevel,
    capabilities: context.capabilities,
    capabilitySource: context.capabilitySource,
  });

  const issuedAt = new Date();
  await prisma.athena_clients.updateMany({
    where: {
      userId: Number(context.userId),
      clientId: String(context.clientId),
      revokedAt: null,
    },
    data: {
      signingSecretEncrypted: encrypted,
      signingSecretVersion,
      signingSecretIssuedAt: issuedAt,
      signingSecretRotatedAt: issuedAt,
    },
  });

  return {
    secret,
    signatureVersion: SIGNATURE_VERSION,
    signingSecretVersion,
    issuedAt,
    rotatedAt: issuedAt,
  };
}

async function rotateSigningSecret({
  userId,
  clientId,
  actorClientId = null,
} = {}) {
  if (!userId || !clientId || clientId === "legacy") return null;
  const client = await getClientRecord({
    userId,
    clientId,
    includeRevoked: true,
  });
  if (!client) return null;
  if (client.revokedAt) return { client, revoked: true };

  const secret = newSigningSecret();
  const encrypted = signingEncryption.encrypt(secret);
  if (!encrypted) return null;

  const issuedAt = new Date();
  const signingSecretVersion = newSigningSecretVersion();
  const result = await prisma.athena_clients.updateMany({
    where: {
      userId: Number(userId),
      clientId: String(clientId),
      revokedAt: null,
    },
    data: {
      signingSecretEncrypted: encrypted,
      signingSecretVersion,
      signingSecretIssuedAt: issuedAt,
      signingSecretRotatedAt: issuedAt,
    },
  });
  if (!result.count) return null;

  return {
    client: {
      ...client,
      signingSecretVersion,
      signingSecretIssuedAt: issuedAt,
      signingSecretRotatedAt: issuedAt,
    },
    rotated: true,
    oldVersion: client.signingSecretVersion || null,
    newVersion: signingSecretVersion,
    issuedAt,
    rotatedAt: issuedAt,
    secret:
      actorClientId && String(actorClientId) === String(clientId)
        ? secret
        : null,
  };
}

async function rotateAllSigningSecrets({ userId, currentClientId } = {}) {
  if (!userId || !currentClientId || currentClientId === "legacy") {
    return { count: 0, currentClient: null, clients: [] };
  }
  const clients = await prisma.athena_clients.findMany({
    where: {
      userId: Number(userId),
      revokedAt: null,
    },
  });

  const rotated = [];
  let currentClient = null;
  for (const client of clients) {
    const result = await rotateSigningSecret({
      userId,
      clientId: client.clientId,
      actorClientId: currentClientId,
    });
    if (!result?.rotated) continue;
    rotated.push(result);
    if (client.clientId === currentClientId) currentClient = result;
  }

  return {
    count: rotated.length,
    currentClient,
    clients: rotated,
  };
}

async function claimNonce({ clientId, userId, nonce, requestId, timestampMs }) {
  await cleanupExpiredNonces();
  await auditNonceVolume({ clientId, userId });
  try {
    await prisma.athena_request_nonces.create({
      data: {
        clientId: String(clientId),
        userId: userId ? Number(userId) : null,
        nonce: String(nonce),
        requestId: requestId || null,
        timestamp: new Date(timestampMs),
        expiresAt: new Date(Date.now() + nonceTtlMs()),
      },
    });
    return true;
  } catch (error) {
    if (error?.code === "P2002") return false;
    throw error;
  }
}

async function verifySignatureParts({
  request,
  method,
  canonicalPath,
  bodyString = "",
  signed = {},
} = {}) {
  const context = getClientContext(request);
  const clientId = compactString(signed.clientId, 256);
  const requestId = compactString(signed.requestId, 256);
  const timestamp = compactString(signed.timestamp);
  const nonce = compactString(signed.nonce, 256);
  const bodySha256 = compactString(signed.bodySha256, 256);
  const signature = compactString(signed.signature, 1024);
  const signatureVersion = compactString(signed.signatureVersion, 32);

  if (
    !clientId ||
    !requestId ||
    !timestamp ||
    !nonce ||
    !bodySha256 ||
    !signature ||
    signatureVersion !== SIGNATURE_VERSION
  ) {
    return signingFailure("missing_signature");
  }
  if (context.legacy || !context.userId) {
    return signingFailure("missing_authenticated_client");
  }
  if (clientId !== context.clientId) {
    return signingFailure("client_mismatch");
  }

  const timestampMs = parseTimestamp(timestamp);
  if (!timestampMs) return signingFailure("invalid_timestamp");
  if (Math.abs(Date.now() - timestampMs) > signatureWindowMs()) {
    return signingFailure("expired_timestamp");
  }

  const expectedBodyHash = sha256Base64Url(bodyString);
  if (!timingSafeEqualString(expectedBodyHash, bodySha256)) {
    return signingFailure("body_hash_mismatch");
  }

  const secretRecord = await clientSigningSecret({
    userId: context.userId,
    clientId,
  });
  if (secretRecord?.client?.revokedAt) return signingFailure("client_revoked");
  if (!secretRecord?.secret) return signingFailure("missing_signing_secret");

  const signingString = canonicalSigningString({
    method,
    canonicalPath,
    timestamp,
    nonce,
    requestId,
    clientId,
    bodySha256,
  });
  const expectedSignature = hmacBase64Url(secretRecord.secret, signingString);
  if (!timingSafeEqualString(expectedSignature, signature)) {
    return signingFailure("signature_mismatch");
  }

  const nonceClaimed = await claimNonce({
    clientId,
    userId: context.userId,
    nonce,
    requestId,
    timestampMs,
  });
  if (!nonceClaimed) return signingFailure("nonce_replay");

  return {
    ok: true,
    clientContext: context,
    requestId,
    signatureVersion,
  };
}

async function recordSigningAudit(request, result, metadata = {}) {
  const reasonCode = result?.ok ? "verified" : result?.reasonCode || "failed";
  try {
    await recordClientTrustCheckpoint(request, {
      action: "signed_high_risk_request",
      resourceType: "request",
      resourceId: request?.originalUrl || request?.url || null,
      outcome: result?.ok ? "verified" : "rejected",
      metadata: {
        ...metadata,
        signatureVersion: SIGNATURE_VERSION,
        signatureResult: result?.ok ? "verified" : "failed",
        reasonCode,
        ...clientAuditMetadata(request),
      },
    });
  } catch {}
}

async function verifySignedRequest(request) {
  const canonicalPath = canonicalPathForRequest(request);
  const signed = requestSigningHeaders(request);
  return verifySignatureParts({
    request,
    method: request.method,
    canonicalPath,
    bodyString: request.rawBody || "",
    signed,
  });
}

async function requireSignedHighRiskRequest(request, response, next) {
  const canonicalPath = canonicalPathForRequest(request);
  if (
    !isHighRiskSignedRequest({
      method: request.method,
      path: canonicalPath,
    })
  ) {
    return next();
  }

  const result = await verifySignedRequest(request);
  await recordSigningAudit(request, result, { transport: "http" });
  if (result.ok || signingWarnOnly()) {
    if (!result.ok) {
      console.warn("[request-signing] Warn-only signature failure", {
        reasonCode: result.reasonCode,
        ...clientAuditMetadata(request),
      });
    }
    return next();
  }

  const errorCode = signingErrorCode(result.reasonCode);
  if (errorCode === CLIENT_REVOKED_ERROR) {
    return response
      .status(403)
      .json({ success: false, error: CLIENT_REVOKED_ERROR });
  }
  if (errorCode === INVALID_SIGNATURE_ERROR) {
    return response
      .status(401)
      .json({ success: false, error: INVALID_SIGNATURE_ERROR });
  }

  return response
    .status(401)
    .json({ success: false, error: "invalid_signed_request" });
}

function parseSocketMessage(rawMessage) {
  const raw =
    typeof rawMessage === "string" ? rawMessage : rawMessage?.toString?.();
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== "object") {
    return { raw, payload: null, envelope: null, signed: false };
  }
  if (
    parsed.type === "athenaSignedMessage" &&
    parsed.signatureVersion === SIGNATURE_VERSION &&
    parsed.signed &&
    Object.prototype.hasOwnProperty.call(parsed, "payload")
  ) {
    return {
      raw,
      payload: parsed.payload,
      envelope: parsed,
      signed: true,
    };
  }
  return { raw, payload: parsed, envelope: null, signed: false };
}

async function verifySignedWebSocketMessage(request, rawMessage) {
  const parsed = parseSocketMessage(rawMessage);
  if (!parsed.signed) {
    return {
      ok: false,
      unsigned: true,
      payload: parsed.payload,
      rawMessage: parsed.raw,
      reasonCode: "missing_signature",
    };
  }

  const payloadString = JSON.stringify(parsed.payload ?? null);
  const result = await verifySignatureParts({
    request,
    method: "WS",
    canonicalPath: canonicalPathForRequest(request),
    bodyString: payloadString,
    signed: {
      ...parsed.envelope.signed,
      signatureVersion: parsed.envelope.signatureVersion,
    },
  });
  await recordSigningAudit(request, result, { transport: "websocket" });

  return {
    ...result,
    payload: parsed.payload,
    rawMessage: payloadString,
  };
}

module.exports = {
  SIGNATURE_VERSION,
  CLIENT_REVOKED_ERROR,
  INVALID_SIGNATURE_ERROR,
  SIGNING_SECRET_ROTATED_ERROR,
  SIGNING_HEADERS,
  canonicalSigningString,
  ensureClientSigningSecret,
  signingErrorCode,
  hmacBase64Url,
  isHighRiskSignedRequest,
  requireSignedHighRiskRequest,
  rotateAllSigningSecrets,
  rotateSigningSecret,
  sha256Base64Url,
  signingWarnOnly,
  verifySignedRequest,
  verifySignedWebSocketMessage,
};
