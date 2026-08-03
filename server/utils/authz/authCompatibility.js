const DEFAULT_AUTH_EPOCH = 1;
const DEFAULT_WEB_PROTOCOL_VERSION = 1;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function currentAuthEpoch(env = process.env) {
  return positiveInteger(env.ATHENA_AUTH_EPOCH, DEFAULT_AUTH_EPOCH);
}

function minimumAuthEpoch(env = process.env) {
  return positiveInteger(env.ATHENA_MINIMUM_AUTH_EPOCH, DEFAULT_AUTH_EPOCH);
}

function tokenAuthEpoch(claims = {}) {
  // Tokens issued before auth epochs existed are deliberately epoch 1. This
  // keeps ordinary releases compatible until Identity explicitly raises the
  // minimum accepted epoch.
  return positiveInteger(claims?.authEpoch, DEFAULT_AUTH_EPOCH);
}

function isAuthEpochCompatible(claims = {}, env = process.env) {
  return tokenAuthEpoch(claims) >= minimumAuthEpoch(env);
}

function webProtocolVersion(env = process.env) {
  return positiveInteger(
    env.ATHENA_WEB_PROTOCOL_VERSION,
    DEFAULT_WEB_PROTOCOL_VERSION
  );
}

function minimumWebProtocolVersion(env = process.env) {
  return positiveInteger(
    env.ATHENA_MINIMUM_WEB_PROTOCOL_VERSION,
    DEFAULT_WEB_PROTOCOL_VERSION
  );
}

function forceReauth(env = process.env) {
  return booleanEnv(env.ATHENA_AUTH_FORCE_REAUTH, false);
}

module.exports = {
  DEFAULT_AUTH_EPOCH,
  DEFAULT_WEB_PROTOCOL_VERSION,
  booleanEnv,
  currentAuthEpoch,
  forceReauth,
  isAuthEpochCompatible,
  minimumAuthEpoch,
  minimumWebProtocolVersion,
  tokenAuthEpoch,
  webProtocolVersion,
};
