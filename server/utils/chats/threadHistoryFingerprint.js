const crypto = require("crypto");

const THREAD_HISTORY_FINGERPRINT_VERSION = "athena-thread-history:v1";

function compactDate(value = null) {
  if (!value) return "none";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? "none" : date.toISOString();
}

function threadHistoryFingerprint({
  threadId = null,
  historyRevision = 0,
  latestChatId = null,
  latestChatAt = null,
} = {}) {
  if (
    threadId === null ||
    threadId === undefined ||
    threadId === "" ||
    !Number.isFinite(Number(threadId))
  ) {
    return null;
  }
  const canonical = [
    THREAD_HISTORY_FINGERPRINT_VERSION,
    String(Number(threadId)),
    String(Math.max(0, Number(historyRevision) || 0)),
    latestChatId === null || latestChatId === undefined
      ? "none"
      : String(Number(latestChatId)),
    compactDate(latestChatAt),
  ].join("\n");
  return crypto.createHash("sha256").update(canonical).digest("base64url");
}

module.exports = {
  THREAD_HISTORY_FINGERPRINT_VERSION,
  threadHistoryFingerprint,
};
