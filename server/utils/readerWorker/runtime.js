const http = require("http");
const { DataAccessCenter } = require("../dataAccess/dataAccessCenter");
const { READER_WORKER_EVENTS, READER_WORKER_TASKS } = require("./contract");
const {
  STANDALONE_READER_SCOPE,
  readerPreviewEngineStatus,
  runReaderPostprocessJob,
} = require("../readerDocumentRuntime");

const WORKER_SUPPORTED_POSTPROCESS_TASKS = new Set([
  READER_WORKER_TASKS.PREVIEW,
  READER_WORKER_TASKS.THUMBNAIL,
  READER_WORKER_TASKS.CLASSIFICATION,
  READER_WORKER_TASKS.PDF_MANIFEST,
]);

class ReaderWorkerRuntime {
  constructor({
    now = () => new Date(),
    workerId = process.env.READER_WORKER_ID || `reader-worker-${process.pid}`,
  } = {}) {
    this.startedAt = now().toISOString();
    this.now = now;
    this.workerId = workerId;
    this.pollTimer = null;
    this.processing = false;
    this.lastQueueSnapshot = null;
    this.lastProcessedAt = null;
    this.lastError = null;
  }

  queueEnabled() {
    return String(process.env.ATHENA_READER_WORKER_QUEUE || "false") === "true";
  }

  async refreshQueueSnapshot() {
    try {
      this.lastQueueSnapshot = await DataAccessCenter.readerWorkerJob.snapshot({
        recentLimit: 10,
      });
      return this.lastQueueSnapshot;
    } catch (error) {
      this.lastQueueSnapshot = {
        enabled: this.queueEnabled(),
        error: error.message,
        byStatus: {},
        byTask: {},
        recent: [],
      };
      return this.lastQueueSnapshot;
    }
  }

  async workspaceForJob(job = {}) {
    if (!job.workspaceSlug) return STANDALONE_READER_SCOPE;
    const workspace = await DataAccessCenter.workspace.get({
      slug: job.workspaceSlug,
    });
    if (!workspace) {
      const error = new Error(
        `Reader worker workspace not found: ${job.workspaceSlug}`
      );
      error.code = "READER_WORKER_WORKSPACE_NOT_FOUND";
      throw error;
    }
    return workspace;
  }

  postprocessTasksForJob(job = {}) {
    const payload = job.payload || {};
    if (Array.isArray(payload.tasks) && payload.tasks.length)
      return payload.tasks.filter((task) =>
        WORKER_SUPPORTED_POSTPROCESS_TASKS.has(task)
      );
    if (WORKER_SUPPORTED_POSTPROCESS_TASKS.has(job.task)) return [job.task];
    return [];
  }

  async executeJob(job = {}) {
    if (!job?.jobId) return null;
    const tasks = this.postprocessTasksForJob(job);
    if (!tasks.length) {
      const error = new Error(
        `Unsupported reader worker job task: ${job.task}`
      );
      error.code = "READER_WORKER_UNSUPPORTED_TASK";
      throw error;
    }

    const workspace = await this.workspaceForJob(job);
    await runReaderPostprocessJob({
      workspace,
      readerDocumentId: job.readerDocumentId,
      tasks,
      categories: job.payload?.categories || [],
      userId: job.userId || job.payload?.userId || null,
    });
    return {
      completedTasks: tasks,
      readerDocumentId: job.readerDocumentId,
      workspaceSlug: job.workspaceSlug || null,
    };
  }

  async processOne() {
    if (!this.queueEnabled()) return null;
    const job = await DataAccessCenter.readerWorkerJob.claimNext({
      workerId: this.workerId,
      now: this.now(),
    });
    if (!job) return null;

    try {
      const result = await this.executeJob(job);
      await DataAccessCenter.readerWorkerJob.complete(job.jobId, result);
      this.lastProcessedAt = this.now().toISOString();
      this.lastError = null;
      return { jobId: job.jobId, status: "completed" };
    } catch (error) {
      await DataAccessCenter.readerWorkerJob.fail(job.jobId, error.message, {
        retry: error.code !== "READER_WORKER_UNSUPPORTED_TASK",
      });
      this.lastError = {
        at: this.now().toISOString(),
        jobId: job.jobId,
        code: error.code || null,
        message: error.message,
      };
      return { jobId: job.jobId, status: "failed", error: error.message };
    } finally {
      await this.refreshQueueSnapshot();
    }
  }

  async drainOnce({ maxJobs = 5 } = {}) {
    if (this.processing) return [];
    this.processing = true;
    const results = [];
    try {
      for (let index = 0; index < maxJobs; index += 1) {
        const result = await this.processOne();
        if (!result) break;
        results.push(result);
      }
      return results;
    } finally {
      this.processing = false;
    }
  }

  startQueuePolling({
    intervalMs = Number(process.env.READER_WORKER_POLL_INTERVAL_MS || 1500),
    maxJobsPerTick = Number(process.env.READER_WORKER_MAX_JOBS_PER_TICK || 3),
  } = {}) {
    if (this.pollTimer) return this.pollTimer;
    if (!this.queueEnabled()) {
      console.log(
        "[ReaderWorker] durable queue disabled; set ATHENA_READER_WORKER_QUEUE=true to enable polling."
      );
      return null;
    }

    const tick = () =>
      this.drainOnce({ maxJobs: maxJobsPerTick }).catch((error) => {
        this.lastError = {
          at: this.now().toISOString(),
          code: error.code || null,
          message: error.message,
        };
      });
    this.refreshQueueSnapshot().catch(() => null);
    this.pollTimer = setInterval(tick, Math.max(250, intervalMs));
    tick();
    console.log(
      `[ReaderWorker] durable queue polling enabled worker=${this.workerId} interval=${intervalMs}ms`
    );
    return this.pollTimer;
  }

  stopQueuePolling() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  snapshot() {
    let previewEngine = null;
    try {
      previewEngine = readerPreviewEngineStatus();
    } catch (error) {
      previewEngine = {
        available: false,
        lastError: error.message,
      };
    }

    return {
      role: "reader-worker",
      status: this.processing ? "processing" : "idle",
      startedAt: this.startedAt,
      now: this.now().toISOString(),
      workerId: this.workerId,
      queue: {
        mode: this.queueEnabled() ? "durable-db" : "disabled",
        attached: Boolean(this.pollTimer),
        lastProcessedAt: this.lastProcessedAt,
        lastError: this.lastError,
        snapshot: this.lastQueueSnapshot,
      },
      tasks: Object.values(READER_WORKER_TASKS),
      events: Object.values(READER_WORKER_EVENTS),
      previewEngine,
    };
  }

  startHealthServer({ port = 3011 } = {}) {
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: true, role: "reader-worker" }));
        return;
      }

      if (request.url === "/snapshot") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(this.snapshot()));
        return;
      }

      if (
        request.url === "/drain-once" &&
        process.env.READER_WORKER_DEBUG_HTTP === "true"
      ) {
        this.drainOnce({ maxJobs: 5 })
          .then((results) => {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ success: true, results }));
          })
          .catch((error) => {
            response.writeHead(500, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({ success: false, error: error.message })
            );
          });
        return;
      }

      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, error: "not_found" }));
    });

    server.listen(port, () => {
      console.log(`[ReaderWorker] health server listening on ${port}`);
    });
    return server;
  }
}

module.exports = { ReaderWorkerRuntime };
