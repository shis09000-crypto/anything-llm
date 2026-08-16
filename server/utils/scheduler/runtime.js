const { BackgroundService } = require("../BackgroundWorkers");
const { DataAccessCenter } = require("../dataAccess");
const crypto = require("crypto");
const { requestInternalService } = require("../microModules/internalClient");

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
    this.responsesTimer = null;
    this.responsesTaskActive = false;
    this.responsesMaintenanceTimer = null;
    this.responsesMaintenanceActive = false;
    this.threadTitleTimer = null;
    this.threadTitleActive = false;
    this.responsesRuntimeUrl = String(
      process.env.ATHENA_RESPONSES_RUNTIME_URL || ""
    ).replace(/\/+$/, "");
    this.chatRuntimeUrl = String(
      process.env.ATHENA_CHAT_RUNTIME_URL || ""
    ).replace(/\/+$/, "");
  }

  async start() {
    if (this.status === "running") return this.snapshot();
    this.status = "starting";
    this.service = this.serviceFactory();
    await this.service.boot();
    this.status = "running";
    this.startReconciliation();
    this.startResponsesDispatcher();
    this.startResponsesMaintenance();
    this.startThreadTitleReconciliation();
    return this.snapshot();
  }

  startResponsesDispatcher() {
    if (!this.responsesRuntimeUrl || this.responsesTimer) return;
    const ownerId = `scheduler:${process.pid}:${crypto.randomUUID()}`;
    const dispatch = async () => {
      if (this.responsesTaskActive || this.status !== "running") return;
      this.responsesTaskActive = true;
      try {
        const claim = await requestInternalService({
          callerRole: "scheduler",
          targetModule: "responses-runtime",
          capability: "responses.background.claim",
          contractVersion: "1.0",
          url: `${this.responsesRuntimeUrl}/internal/v1/responses/background/claim`,
          body: { ownerId, leaseMs: 300_000, taskPriority: "P3" },
          idempotencyKey: crypto.randomUUID(),
          timeoutMs: 10_000,
        });
        const responseId = claim?.response?.id;
        if (!responseId) return;
        const taskPriority = ["P0", "P1", "P2", "P3", "P4"].includes(
          claim.response.taskPriority
        )
          ? claim.response.taskPriority
          : "P2";
        await requestInternalService({
          callerRole: "scheduler",
          targetModule: "responses-runtime",
          capability: "responses.background.execute",
          contractVersion: "1.0",
          url: `${this.responsesRuntimeUrl}/internal/v1/responses/background/${responseId}/execute`,
          body: {
            ownerId,
            taskPriority,
            taskIntent: claim.response.taskIntent || null,
          },
          idempotencyKey: responseId,
          timeoutMs: Number(
            process.env.ATHENA_RESPONSES_BACKGROUND_TIMEOUT_MS || 900_000
          ),
        });
      } catch (error) {
        this.lastError = error?.code || error?.message || String(error);
      } finally {
        this.responsesTaskActive = false;
      }
    };
    this.responsesTimer = setInterval(
      dispatch,
      Math.max(
        500,
        Number(process.env.ATHENA_RESPONSES_SCHEDULER_POLL_MS || 1_000)
      )
    );
    this.responsesTimer.unref?.();
    void dispatch();
  }

  startResponsesMaintenance() {
    if (!this.responsesRuntimeUrl || this.responsesMaintenanceTimer) return;
    const maintain = async () => {
      if (this.responsesMaintenanceActive || this.status !== "running") return;
      this.responsesMaintenanceActive = true;
      try {
        await requestInternalService({
          callerRole: "scheduler",
          targetModule: "responses-runtime",
          capability: "responses.maintenance",
          contractVersion: "1.0",
          url: `${this.responsesRuntimeUrl}/internal/v1/responses/maintenance`,
          body: { taskPriority: "P4", limit: 25 },
          idempotencyKey: `responses-maintenance:${new Date()
            .toISOString()
            .slice(0, 13)}`,
          timeoutMs: Number(
            process.env.ATHENA_RESPONSES_MAINTENANCE_TIMEOUT_MS || 300_000
          ),
        });
      } catch (error) {
        this.lastError = error?.code || error?.message || String(error);
      } finally {
        this.responsesMaintenanceActive = false;
      }
    };
    this.responsesMaintenanceTimer = setInterval(
      maintain,
      Math.max(
        60_000,
        Number(
          process.env.ATHENA_RESPONSES_MAINTENANCE_INTERVAL_MS || 3_600_000
        )
      )
    );
    this.responsesMaintenanceTimer.unref?.();
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

  startThreadTitleReconciliation() {
    if (!this.chatRuntimeUrl || this.threadTitleTimer) return;
    const reconcile = async () => {
      if (this.threadTitleActive || this.status !== "running") return;
      this.threadTitleActive = true;
      try {
        await requestInternalService({
          callerRole: "scheduler",
          targetModule: "chat-runtime",
          capability: "chat.thread-title.reconcile",
          contractVersion: "1.0",
          url: `${this.chatRuntimeUrl}/internal/v1/chat/thread-title/reconcile`,
          body: { taskPriority: "P4", pageSize: 100, waitForIdle: false },
          idempotencyKey: `thread-title-reconcile:${new Date()
            .toISOString()
            .slice(0, 10)}`,
          timeoutMs: 300_000,
        });
      } catch (error) {
        this.lastError = error?.code || error?.message || String(error);
      } finally {
        this.threadTitleActive = false;
      }
    };
    this.threadTitleTimer = setInterval(
      reconcile,
      Math.max(
        60_000,
        Number(
          process.env.ATHENA_THREAD_TITLE_RECONCILE_INTERVAL_MS ||
            14 * 24 * 60 * 60 * 1000
        )
      )
    );
    this.threadTitleTimer.unref?.();
    setTimeout(reconcile, 30_000).unref?.();
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
      responsesDispatcher: {
        enabled: Boolean(this.responsesRuntimeUrl),
        active: this.responsesTaskActive,
        leasePriority: "P3",
        executionPriority: "inherited",
      },
      responsesMaintenance: {
        enabled: Boolean(this.responsesRuntimeUrl),
        active: this.responsesMaintenanceActive,
        taskPriority: "P4",
      },
      threadTitleReconciliation: {
        enabled: Boolean(this.chatRuntimeUrl),
        active: this.threadTitleActive,
        taskPriority: "P4",
      },
    };
  }

  async stop() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.responsesTimer) clearInterval(this.responsesTimer);
    if (this.responsesMaintenanceTimer)
      clearInterval(this.responsesMaintenanceTimer);
    if (this.threadTitleTimer) clearInterval(this.threadTitleTimer);
    this.reconcileTimer = null;
    this.responsesTimer = null;
    this.responsesMaintenanceTimer = null;
    this.threadTitleTimer = null;
    await this.service?.stop?.();
    this.service = null;
    this.status = "stopped";
    return this.snapshot();
  }
}

module.exports = { SchedulerRuntime };
