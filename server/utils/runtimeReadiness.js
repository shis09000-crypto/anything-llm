const { runtimeCoordinator } = require("./runtimeCoordinator");

function detailedReadinessSnapshot() {
  const snapshot = runtimeCoordinator.snapshot();
  const keyCustody = require("./security/keyRuntimeState").securityState();
  const outbox = require("./syncV2/outboxDispatcher").syncV2OutboxSnapshot();
  const receipts =
    require("./mutationReceiptSweeper").mutationReceiptSweeperSnapshot();
  const securityAudit =
    require("./security/auditLedgerRuntime").securityAuditMaintenanceSnapshot();
  const authSessions =
    require("./security/authSessionSyncReconciler").authSessionSyncReconcilerSnapshot();
  const outboxRequired =
    require("./syncV2/config").syncV2OutboxDispatchEnabled();
  const controlPlaneReady =
    keyCustody.status === "ready" &&
    !keyCustody.quarantined &&
    !keyCustody.writeBarrier &&
    receipts.running &&
    receipts.healthy &&
    authSessions.running &&
    authSessions.healthy &&
    (!outboxRequired || (outbox.running && outbox.healthy)) &&
    securityAudit.running &&
    securityAudit.healthy;
  return {
    ...snapshot,
    ready: snapshot.ready && controlPlaneReady,
    controlPlane: {
      keyCustody,
      outbox,
      receipts,
      authSessions,
      securityAudit,
    },
  };
}

function readinessReason(snapshot) {
  if (snapshot.ready) return "ready";
  if (snapshot.status !== "running")
    return `runtime_${snapshot.status || "unknown"}`;
  if (
    snapshot.controlPlane?.keyCustody?.status !== "ready" ||
    snapshot.controlPlane?.keyCustody?.quarantined ||
    snapshot.controlPlane?.keyCustody?.writeBarrier
  )
    return "key_custody_unhealthy";
  return "control_plane_unhealthy";
}

function publicReadinessSnapshot() {
  const snapshot = detailedReadinessSnapshot();
  return {
    status: snapshot.ready ? "ready" : "not_ready",
    ready: snapshot.ready,
    reasonCode: readinessReason(snapshot),
  };
}

function livenessSnapshot() {
  return { status: "alive", live: true };
}

function strictReadinessEnabled(env = process.env) {
  if (env.ATHENA_STRICT_READY === "true") return true;
  if (env.ATHENA_STRICT_READY === "false") return false;
  return env.NODE_ENV === "production";
}

module.exports = {
  detailedReadinessSnapshot,
  livenessSnapshot,
  publicReadinessSnapshot,
  strictReadinessEnabled,
};
