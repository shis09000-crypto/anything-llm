const {
  reconcileSecurityAuditSpool,
  securityAuditDurabilitySnapshot,
  verifySecurityAudit,
} = require("./auditLedger");
const { metrics } = require("../observability/metrics");
const { exportSecurityAuditArchive } = require("./auditArchive");

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_VERIFY_INTERVAL_MS = 6 * 60 * 60_000;
let timer = null;
let active = null;
let lastVerifiedAt = 0;
const state = {
  lastReconciledAt: null,
  lastVerification: null,
  lastArchive: null,
  lastError: null,
  consecutiveFailures: 0,
};

async function runSecurityAuditMaintenance() {
  if (active) return active;
  active = (async () => {
    const reconciled = await reconcileSecurityAuditSpool();
    state.lastReconciledAt = new Date().toISOString();
    const verifyInterval = Math.max(
      Number(
        process.env.ATHENA_SECURITY_AUDIT_VERIFY_INTERVAL_MS ||
          DEFAULT_VERIFY_INTERVAL_MS
      ),
      60_000
    );
    if (Date.now() - lastVerifiedAt >= verifyInterval) {
      state.lastVerification = await verifySecurityAudit();
      metrics.securityAuditChainValid.set(state.lastVerification.valid ? 1 : 0);
      lastVerifiedAt = Date.now();
      if (!state.lastVerification.valid) {
        const error = new Error("security_audit_chain_invalid");
        error.code = "SECURITY_AUDIT_CHAIN_INVALID";
        throw error;
      }
      state.lastArchive = await exportSecurityAuditArchive();
      metrics.securityAuditArchiveHealthy.set(1);
    }
    state.lastError = null;
    state.consecutiveFailures = 0;
    return { reconciled, verification: state.lastVerification };
  })()
    .catch((error) => {
      state.lastError =
        error?.code || error?.message || "audit_maintenance_failed";
      state.consecutiveFailures += 1;
      metrics.securityAuditArchiveHealthy.set(0);
      metrics.securityAuditEvents.inc({ outcome: "maintenance_failure" });
      throw error;
    })
    .finally(() => {
      active = null;
    });
  return active;
}

async function startSecurityAuditMaintenance({
  intervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
} = {}) {
  if (timer) return false;
  await runSecurityAuditMaintenance();
  const tick = () =>
    void runSecurityAuditMaintenance().catch((error) =>
      console.error("[SecurityAudit] maintenance failed", {
        code: error?.code || "audit_maintenance_failed",
      })
    );
  timer = setInterval(
    tick,
    Math.max(Number(intervalMs) || DEFAULT_RECONCILE_INTERVAL_MS, 5_000)
  );
  timer.unref?.();
  return true;
}

async function stopSecurityAuditMaintenance() {
  if (timer) clearInterval(timer);
  timer = null;
  if (active) await active.catch(() => null);
}

function securityAuditMaintenanceSnapshot() {
  const durability = securityAuditDurabilitySnapshot();
  return {
    running: Boolean(timer),
    healthy:
      durability.healthy &&
      state.lastError !== "SECURITY_AUDIT_CHAIN_INVALID" &&
      state.consecutiveFailures < 3,
    durability,
    ...state,
  };
}

module.exports = {
  runSecurityAuditMaintenance,
  securityAuditMaintenanceSnapshot,
  startSecurityAuditMaintenance,
  stopSecurityAuditMaintenance,
};
