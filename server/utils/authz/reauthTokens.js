const crypto = require("crypto");

const DEFAULT_REAUTH_TTL_MS = 5 * 60 * 1000;
const reauthTokens = new Map();

function issueReauthToken(userId, method, purpose = "generic") {
  const token = crypto.randomBytes(32).toString("base64url");
  reauthTokens.set(token, {
    userId: Number(userId),
    method,
    purpose,
    expiresAt: Date.now() + DEFAULT_REAUTH_TTL_MS,
  });
  return token;
}

function validateReauthToken(token, userId, purpose = null) {
  const record = reauthTokens.get(token);
  if (
    !record ||
    record.userId !== Number(userId) ||
    record.expiresAt < Date.now() ||
    (purpose && record.purpose !== purpose)
  ) {
    if (record) reauthTokens.delete(token);
    return null;
  }
  return record;
}

function consumeReauthToken(token) {
  reauthTokens.delete(token);
}

module.exports = {
  DEFAULT_REAUTH_TTL_MS,
  issueReauthToken,
  validateReauthToken,
  consumeReauthToken,
};
