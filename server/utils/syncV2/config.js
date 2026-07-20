const crypto = require("crypto");
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_ACTIVE_OUTBOX_INTERVAL_MS = 250;
const DEFAULT_SHADOW_OUTBOX_INTERVAL_MS = 5_000;

function syncV2Enabled(env = process.env) {
  return String(env.ATHENA_SYNC_V2_ENABLED || "false").toLowerCase() === "true";
}

function envBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

// The Outbox is an internal transaction/control-plane concern. It must not be
// coupled to whether clients are currently in a Sync V2 rollout cohort.
function syncV2OutboxDispatchEnabled(env = process.env) {
  if (syncV2Enabled(env)) return true;
  return envBoolean(env.ATHENA_SYNC_V2_OUTBOX_DISPATCH, true);
}

function syncV2ControlPlaneMode(env = process.env) {
  if (!syncV2OutboxDispatchEnabled(env)) return "disabled";
  return syncV2Enabled(env) ? "active" : "shadow";
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function syncV2OutboxIntervalMs(env = process.env) {
  const fallback = syncV2Enabled(env)
    ? DEFAULT_ACTIVE_OUTBOX_INTERVAL_MS
    : DEFAULT_SHADOW_OUTBOX_INTERVAL_MS;
  return positiveInteger(env.SYNC_V2_OUTBOX_INTERVAL_MS, fallback, 60 * 60_000);
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
  DEFAULT_ACTIVE_OUTBOX_INTERVAL_MS,
  DEFAULT_RETENTION_MS,
  DEFAULT_SHADOW_OUTBOX_INTERVAL_MS,
  rolloutPercent,
  syncV2CohortEnabled,
  syncV2ControlPlaneMode,
  syncV2DomainEnabled,
  syncV2Enabled,
  syncV2HashSamplePercent,
  syncV2OutboxDispatchEnabled,
  syncV2OutboxIntervalMs,
  syncV2RetentionMs,
};
