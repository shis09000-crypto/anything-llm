const crypto = require("crypto");
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function syncV2Enabled(env = process.env) {
  return String(env.ATHENA_SYNC_V2_ENABLED || "false").toLowerCase() === "true";
}

function syncV2DomainEnabled(domain, env = process.env) {
  if (!syncV2Enabled(env)) return false;
  const configured = String(env.ATHENA_SYNC_V2_DOMAINS || "core")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const normalizedDomain = String(domain || "core").toLowerCase();
  const coreDomains = new Set([
    "core",
    "profile",
    "preferences",
    "workspace",
    "chat",
  ]);
  return (
    configured.includes("all") ||
    configured.includes(normalizedDomain) ||
    (configured.includes("core") && coreDomains.has(normalizedDomain))
  );
}

function rolloutPercent(domain = "core", env = process.env) {
  const overrides = new Map(
    String(env.ATHENA_SYNC_V2_DOMAIN_ROLLOUTS || "")
      .split(",")
      .map((entry) => entry.split(":"))
      .filter(([key, value]) => key && Number.isFinite(Number(value)))
      .map(([key, value]) => [key.trim().toLowerCase(), Number(value)])
  );
  const configured = overrides.has(String(domain).toLowerCase())
    ? overrides.get(String(domain).toLowerCase())
    : Number(env.ATHENA_SYNC_V2_ROLLOUT_PERCENT ?? 100);
  return Math.min(Math.max(Number(configured) || 0, 0), 100);
}

function syncV2CohortEnabled(
  { userId, clientId = "legacy", domain = "core" } = {},
  env = process.env
) {
  if (!syncV2DomainEnabled(domain, env)) return false;
  const percent = rolloutPercent(domain, env);
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const bucket =
    crypto
      .createHash("sha256")
      .update(
        `athena-sync-v2-cohort:v1:${String(userId)}:${String(clientId)}:${String(domain)}`
      )
      .digest()
      .readUInt32BE(0) % 10_000;
  return bucket < Math.round(percent * 100);
}

function syncV2RetentionMs(env = process.env) {
  const configured = Number(env.ATHENA_SYNC_V2_RETENTION_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_RETENTION_MS;
}

function syncV2HashSamplePercent(env = process.env) {
  const fallback = env.NODE_ENV === "test" ? 0 : 1;
  const configured = Number(env.ATHENA_SYNC_V2_HASH_SAMPLE_PERCENT);
  if (!Number.isFinite(configured)) return fallback;
  return Math.min(Math.max(configured, 0), 100);
}

module.exports = {
  DEFAULT_RETENTION_MS,
  rolloutPercent,
  syncV2CohortEnabled,
  syncV2DomainEnabled,
  syncV2Enabled,
  syncV2HashSamplePercent,
  syncV2RetentionMs,
};
