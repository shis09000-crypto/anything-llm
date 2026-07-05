const crypto = require("crypto");

const SESSION_TTL_MS = Math.max(
  60_000,
  Number(process.env.ATHENA_DEV_CONTROL_SESSION_TTL_MS) || 15 * 60 * 1000
);
const SIGNATURE_WINDOW_MS = Math.max(
  30_000,
  Number(process.env.ATHENA_DEV_CONTROL_SIGNATURE_WINDOW_MS) || 5 * 60 * 1000
);
const sessions = new Map();

function now() {
  return Date.now();
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

function stableJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanupExpiredSessions() {
  const current = now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt <= current) sessions.delete(sessionId);
  }
}

function createDeveloperSession({ userId, clientId, requestId = null } = {}) {
  cleanupExpiredSessions();
  const sessionId = `dev_${crypto.randomUUID()}`;
  const sessionSecret = crypto.randomBytes(32).toString("base64url");
  const createdAt = now();
  const session = {
    sessionId,
    sessionSecret,
    userId: Number(userId),
    clientId: String(clientId || "legacy"),
    requestId,
    createdAt,
    expiresAt: createdAt + SESSION_TTL_MS,
    nonces: new Set(),
  };
  sessions.set(sessionId, session);
  return {
    session,
    publicSession: {
      sessionId,
      sessionSecret,
      expiresAt: new Date(session.expiresAt).toISOString(),
      ttlMs: SESSION_TTL_MS,
      signatureVersion: "athena-dev-control-v1",
    },
  };
}

function commandSigningString({
  command,
  sessionId,
  requestId,
  timestamp,
  nonce,
  scope = {},
  params = {},
} = {}) {
  return [
    "ATHENA-DEV-CONTROL-V1",
    sessionId,
    requestId,
    timestamp,
    nonce,
    command,
    sha256(stableJson({ scope, params })),
  ].join("\n");
}

function hmac(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function timingSafeEqualString(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length)
    return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyDeveloperCommandEnvelope(body = {}, { userId, clientId } = {}) {
  cleanupExpiredSessions();
  const {
    command,
    sessionId,
    requestId,
    timestamp,
    nonce,
    signature,
    scope = {},
    params = {},
  } = body || {};
  if (
    !command ||
    !sessionId ||
    !requestId ||
    !timestamp ||
    !nonce ||
    !signature
  )
    return { ok: false, code: "invalid_command_envelope" };
  const session = sessions.get(String(sessionId));
  if (!session) return { ok: false, code: "developer_session_not_found" };
  if (session.expiresAt <= now()) {
    sessions.delete(session.sessionId);
    return { ok: false, code: "developer_session_expired" };
  }
  if (Number(session.userId) !== Number(userId)) {
    return { ok: false, code: "developer_session_user_mismatch" };
  }
  if (String(session.clientId) !== String(clientId || "legacy")) {
    return { ok: false, code: "developer_session_client_mismatch" };
  }
  const timestampMs = Date.parse(timestamp);
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(now() - timestampMs) > SIGNATURE_WINDOW_MS
  ) {
    return { ok: false, code: "developer_command_timestamp_invalid" };
  }
  if (session.nonces.has(String(nonce))) {
    return { ok: false, code: "developer_command_nonce_replay" };
  }
  const expected = hmac(
    session.sessionSecret,
    commandSigningString({
      command,
      sessionId,
      requestId,
      timestamp,
      nonce,
      scope,
      params,
    })
  );
  if (!timingSafeEqualString(expected, signature)) {
    return { ok: false, code: "developer_command_signature_invalid" };
  }
  session.nonces.add(String(nonce));
  return { ok: true, session };
}

function snapshot() {
  cleanupExpiredSessions();
  return {
    sessions: sessions.size,
    sessionIds: [...sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      clientId: session.clientId,
      expiresAt: new Date(session.expiresAt).toISOString(),
      nonceCount: session.nonces.size,
    })),
  };
}

module.exports = {
  commandSigningString,
  createDeveloperSession,
  snapshot,
  verifyDeveloperCommandEnvelope,
};
