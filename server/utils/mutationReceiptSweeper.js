const { DataAccessCenter } = require("./dataAccess");
const { metrics } = require("./observability/metrics");

const MutationReceipt = DataAccessCenter.athenaMutationReceipt;
const SyncV2 = DataAccessCenter.syncV2;
const DEFAULT_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
let timer = null;
let activeSweep = null;
let lastPrunedAt = 0;
const state = {
  sweeps: 0,
  recovered: 0,
  released: 0,
  failed: 0,
  lastSweepAt: null,
  lastError: null,
  consecutiveFailures: 0,
  pending: 0,
  recoverable: 0,
  stale: 0,
};

async function sweepMutationReceipts() {
  if (activeSweep) return activeSweep;
  activeSweep = (async () => {
    state.sweeps += 1;
    const swept = await MutationReceipt.sweepStale({
      replayResolver: async (options) => {
        if (!(await SyncV2.schemaReady())) return null;
        return await SyncV2.mutationReplay(options);
      },
    });
    state.recovered += Number(swept.recovered || 0);
    state.released += Number(swept.released || 0);
    state.failed += Number(swept.failed || 0);
    if (swept.recovered)
      metrics.syncReceiptEvents.inc({ action: "recovered" }, swept.recovered);
    if (swept.released)
      metrics.syncReceiptEvents.inc({ action: "released" }, swept.released);
    if (swept.failed)
      metrics.syncReceiptEvents.inc({ action: "failed" }, swept.failed);
    if (Date.now() - lastPrunedAt >= PRUNE_INTERVAL_MS) {
      await MutationReceipt.pruneExpired();
      lastPrunedAt = Date.now();
    }
    const snapshot = await MutationReceipt.snapshot();
    state.pending = Number(snapshot.pending || 0);
    state.recoverable = Number(snapshot.recoverable || 0);
    state.stale = Number(snapshot.stale || 0);
    metrics.syncReceiptPending.set(
      { status: "pending" },
      Number(snapshot.pending || 0)
    );
    metrics.syncReceiptPending.set(
      { status: "recoverable" },
      Number(snapshot.recoverable || 0)
    );
    metrics.syncReceiptPending.set(
      { status: "stale" },
      Number(snapshot.stale || 0)
    );
    state.lastSweepAt = new Date().toISOString();
    state.lastError = null;
    state.consecutiveFailures = 0;
    return swept;
  })()
    .catch((error) => {
      state.lastError = error?.code || error?.message || "receipt_sweep_failed";
      state.consecutiveFailures += 1;
      throw error;
    })
    .finally(() => {
      activeSweep = null;
    });
  return activeSweep;
}

async function startMutationReceiptSweeper({
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  if (timer) return false;
  await sweepMutationReceipts();
  const tick = () =>
    void sweepMutationReceipts().catch((error) =>
      console.error("[MutationReceipt] sweep failed", {
        code: error?.code || "receipt_sweep_failed",
      })
    );
  timer = setInterval(
    tick,
    Math.max(Number(intervalMs) || DEFAULT_INTERVAL_MS, 5_000)
  );
  timer.unref?.();
  return true;
}

async function stopMutationReceiptSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
  if (activeSweep) await activeSweep.catch(() => null);
}

function mutationReceiptSweeperSnapshot() {
  return {
    running: Boolean(timer),
    healthy: state.consecutiveFailures < 3,
    ...state,
  };
}

module.exports = {
  mutationReceiptSweeperSnapshot,
  startMutationReceiptSweeper,
  stopMutationReceiptSweeper,
  sweepMutationReceipts,
};
