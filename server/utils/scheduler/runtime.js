const { BackgroundService } = require("../BackgroundWorkers");
const { DataAccessCenter } = require("../dataAccess");

class SchedulerRuntime {
  constructor({
    serviceFactory = () => new BackgroundService({ mode: "scheduler" }),
    reconcileIntervalMs = Number(
      process.env.ATHENA_SCHEDULER_RECONCILE_INTERVAL_MS || 5_000
    ),
  } = {}) {
    this.serviceFactory = serviceFactory;
    this.reconcileIntervalMs = Math.max(
      1_000,
      Math.min(Number(reconcileIntervalMs) || 5_000, 60_000)
    );
    this.service = null;
    this.reconcileTimer = null;
    this.status = "created";
    this.lastError = null;
    this.lastReconciledAt = null;
  }

  async start() {
    if (this.status === "running") return this.snapshot();
    this.status = "starting";
    this.service = this.serviceFactory();
    await this.service.boot();
    this.status = "running";
    this.startReconciliation();
    return this.snapshot();
  }

  startReconciliation() {
    if (this.reconcileTimer) return;
    const tick = () =>
      this.service
        ?.reconcileScheduledJobs()
        .then(() => {
          this.lastReconciledAt = new Date().toISOString();
          this.lastError = null;
        })
        .catch((error) => {
          this.lastError = error?.code || error?.message || String(error);
        });
    this.reconcileTimer = setInterval(tick, this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  async syncJob(jobId) {
    await this.service.syncScheduledJob(Number(jobId));
    this.lastReconciledAt = new Date().toISOString();
    return { synced: true, jobId: Number(jobId) };
  }

  async removeJob(jobId) {
    this.service.removeScheduledJob(Number(jobId));
    return { removed: true, jobId: Number(jobId) };
  }

  async triggerJob(jobId, { idempotencyKey } = {}) {
    const run = await this.service.enqueueScheduledJob(Number(jobId), {
      idempotencyKey,
    });
    return {
      triggered: Boolean(run),
      skipped: !run,
      idempotentReplay: Boolean(run?.idempotentReplay),
      run: run ? { id: run.id, jobId: run.jobId, status: run.status } : null,
    };
  }

  async killRun(jobId, runId) {
    const killedProcess = this.service.killRun(Number(jobId), Number(runId));
    const marked = await DataAccessCenter.scheduledJob.run.kill(Number(runId));
    return {
      killed: Boolean(killedProcess || marked),
      processSignalled: Boolean(killedProcess),
      runId: Number(runId),
    };
  }

  snapshot() {
    return {
      ready: this.status === "running",
      status: this.status,
      mode: this.service?.mode || "scheduler",
      jobs: this.service?.jobs?.().map((job) => job.name) || [],
      reconcileIntervalMs: this.reconcileIntervalMs,
      lastReconciledAt: this.lastReconciledAt,
      lastError: this.lastError,
    };
  }

  async stop() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    await this.service?.stop?.();
    this.service = null;
    this.status = "stopped";
    return this.snapshot();
  }
}

module.exports = { SchedulerRuntime };
