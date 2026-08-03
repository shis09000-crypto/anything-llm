const { sensitivePaths } = require("../eventEnvelope");

const HEALTH_STATUSES = new Set([
  "healthy",
  "degraded",
  "not-ready",
  "unmonitored",
  "unknown",
]);
const HEALTH_SOURCES = new Set([
  "runtime",
  "probe",
  "heartbeat",
  "event",
  "none",
]);

function safeReasonCode(value) {
  const candidate = String(value || "").slice(0, 160);
  return /^[A-Za-z0-9_.:-]+$/.test(candidate) ? candidate : null;
}

function normalizeChecks(checks = []) {
  return Array.isArray(checks)
    ? checks.slice(0, 100).map((check, index) => ({
        id: String(check?.id || `check-${index}`).slice(0, 120),
        status: ["passed", "failed", "degraded", "not-observed"].includes(
          check?.status
        )
          ? check.status
          : "not-observed",
        reasonCode: safeReasonCode(check?.reasonCode),
      }))
    : [];
}

function healthScore({ status, ready, checks }) {
  let score = 100;
  if (ready === false) score -= 60;
  if (status === "degraded") score -= 25;
  if (status === "unmonitored" || status === "unknown") score -= 35;
  score -= checks.filter((check) => check.status === "failed").length * 10;
  score -= checks.filter((check) => check.status === "degraded").length * 5;
  return Math.max(0, Math.min(score, 100));
}

function createModuleHealth({
  moduleId,
  runtime = {},
  source = "runtime",
  checkedAt = new Date().toISOString(),
  checks = [],
} = {}) {
  const normalizedChecks = normalizeChecks(checks);
  const ready =
    runtime.ready === undefined || runtime.ready === null
      ? null
      : Boolean(runtime.ready);
  const status = HEALTH_STATUSES.has(runtime.status)
    ? runtime.status
    : ready === true
      ? "healthy"
      : ready === false
        ? "not-ready"
        : source === "none"
          ? "unmonitored"
          : "unknown";
  const health = {
    schema: "athena.aicp.module-health",
    schemaVersion: "1.0",
    moduleId: String(moduleId || ""),
    status,
    ready,
    healthScore: healthScore({ status, ready, checks: normalizedChecks }),
    checkedAt: checkedAt || null,
    source: HEALTH_SOURCES.has(source) ? source : "none",
    reasonCode: safeReasonCode(runtime.reasonCode || runtime.lastError),
    checks: normalizedChecks,
  };
  const validation = validateModuleHealth(health);
  if (!validation.valid) {
    const error = new Error("aicp_module_health_invalid");
    error.code = "AICP_MODULE_HEALTH_INVALID";
    error.findings = validation.findings;
    throw error;
  }
  return health;
}

function validateModuleHealth(value = {}) {
  const findings = [];
  if (value.schema !== "athena.aicp.module-health")
    findings.push("schema_invalid");
  if (value.schemaVersion !== "1.0") findings.push("schema_version_invalid");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(String(value.moduleId || "")))
    findings.push("module_id_invalid");
  if (!HEALTH_STATUSES.has(value.status)) findings.push("status_invalid");
  if (![true, false, null].includes(value.ready))
    findings.push("ready_invalid");
  if (
    !Number.isFinite(value.healthScore) ||
    value.healthScore < 0 ||
    value.healthScore > 100
  )
    findings.push("health_score_invalid");
  if (value.checkedAt && !Number.isFinite(Date.parse(value.checkedAt)))
    findings.push("checked_at_invalid");
  if (!HEALTH_SOURCES.has(value.source)) findings.push("source_invalid");
  if (!Array.isArray(value.checks)) findings.push("checks_invalid");
  const sensitive = sensitivePaths(value, "health");
  if (sensitive.length)
    findings.push(...sensitive.map((path) => `sensitive_field:${path}`));
  return { valid: findings.length === 0, findings };
}

module.exports = {
  createModuleHealth,
  healthScore,
  validateModuleHealth,
};
