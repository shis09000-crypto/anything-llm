const { DataAccessCenter } = require("../dataAccess");
const { metrics } = require("../observability/metrics");

const AuthSession = DataAccessCenter.adminSystem.authSession;
const DEFAULT_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
let timer = null;
let active = null;
let lastPrunedAt = 0;
const state = {
  passes: 0,
  checked: 0,
  lastRunAt: null,
  lastError: null,
  consecutiveFailures: 0,
};

async function reconcileAuthSessionSyncState() {
  if (active) return active;
  active = (async () => {
    const result = await AuthSession.reconcileSyncState();
    state.passes += 1;
    state.checked += Number(result.checked || 0);
    if (Date.now() - lastPrunedAt >= PRUNE_INTERVAL_MS) {
      await AuthSession.pruneExpired();
      lastPrunedAt = Date.now();
    }
    state.lastRunAt = new Date().toISOString();
    state.lastError = null;
    state.consecutiveFailures = 0;
    metrics.authSessionReconciles.inc({ outcome: "completed" });
    if (result.checked)
      metrics.authSessionReconciles.inc(
        { outcome: "account_checked" },
        Number(result.checked)
      );
    return result;
  })()
    .catch((error) => {
      state.lastError =
        error?.code || error?.message || "auth_session_reconcile_failed";
      state.consecutiveFailures += 1;
      metrics.authSessionReconciles.inc({ outcome: "failed" });
      throw error;
    })
    .finally(() => {
      active = null;
    });
  return active;
}

async function startAuthSessionSyncReconciler({
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  if (timer) return false;
  await reconcileAuthSessionSyncState();
  const tick = () =>
    void reconcileAuthSessionSyncState().catch((error) =>
      console.error("[AuthSession] authority reconciliation failed", {
        code: error?.code || "auth_session_reconcile_failed",
      })
    );
  timer = setInterval(
    tick,
    Math.max(Number(intervalMs) || DEFAULT_INTERVAL_MS, 5_000)
  );
  timer.unref?.();
  return true;
}

async function stopAuthSessionSyncReconciler() {
  if (timer) clearInterval(timer);
  timer = null;
  if (active) await active.catch(() => null);
}

function authSessionSyncReconcilerSnapshot() {
  return {
    running: Boolean(timer),
    healthy: state.consecutiveFailures < 3,
    ...state,
  };
}

module.exports = {
  authSessionSyncReconcilerSnapshot,
  reconcileAuthSessionSyncState,
  startAuthSessionSyncReconciler,
  stopAuthSessionSyncReconciler,
};
