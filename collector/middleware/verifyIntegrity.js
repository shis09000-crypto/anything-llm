const { CommunicationKey } = require("../utils/comKey");
const RuntimeSettings = require("../utils/runtimeSettings");
const runtimeSettings = new RuntimeSettings();
const replayNonces = new Map();
const DEFAULT_REPLAY_WINDOW_MS = 5 * 60_000;
const MAX_REPLAY_ENTRIES = 10_000;

function replayWindowMs() {
  const configured = Number(process.env.ATHENA_COLLECTOR_IPC_REPLAY_WINDOW_MS);
  if (!Number.isFinite(configured)) return DEFAULT_REPLAY_WINDOW_MS;
  return Math.min(Math.max(Math.trunc(configured), 10_000), 15 * 60_000);
}

function acceptNonce(nonce, now, windowMs) {
  for (const [seenNonce, acceptedAt] of replayNonces) {
    if (now - acceptedAt <= windowMs) break;
    replayNonces.delete(seenNonce);
  }
  if (replayNonces.has(nonce)) return false;
  replayNonces.set(nonce, now);
  while (replayNonces.size > MAX_REPLAY_ENTRIES) {
    replayNonces.delete(replayNonces.keys().next().value);
  }
  return true;
}

function rejectIntegrity(response, reason) {
  return response.status(400).json({
    error: "collector_integrity_check_failed",
    reason,
  });
}

function verifyPayloadIntegrity(request, response, next) {
  const comKey = new CommunicationKey();
  if (
    process.env.NODE_ENV === "development" &&
    process.env.ATHENA_COLLECTOR_DEV_INTEGRITY_BYPASS === "true"
  ) {
    comKey.log("verifyPayloadIntegrity is skipped in development.");
    runtimeSettings.parseOptionsFromRequest(request);
    next();
    return;
  }

  if (request.header("X-Athena-IPC-Version") !== "2")
    return rejectIntegrity(response, "unsupported_protocol");

  const now = Date.now();
  const verification = comKey.verifyRequest({
    signature: request.header("X-Integrity") || "",
    method: request.method,
    requestPath: request.originalUrl || request.url,
    timestamp: request.header("X-Athena-IPC-Timestamp") || "",
    nonce: request.header("X-Athena-IPC-Nonce") || "",
    bodySha256: request.header("X-Athena-IPC-Body-SHA256") || "",
    body: request.body,
    computedBodySha256: request.rawBodySha256,
    now,
    maxClockSkewMs: replayWindowMs(),
  });
  if (!verification.ok) return rejectIntegrity(response, verification.reason);
  if (!acceptNonce(verification.nonce, now, replayWindowMs()))
    return rejectIntegrity(response, "replayed_nonce");

  runtimeSettings.parseOptionsFromRequest(request);
  next();
}

module.exports = {
  verifyPayloadIntegrity,
  _internals: {
    acceptNonce,
    replayNonces,
    replayWindowMs,
  },
};
