const http = require("http");
const https = require("https");
const { DataAccessCenter } = require("../dataAccess/dataAccessCenter");
const { READER_WORKER_EVENTS, READER_WORKER_TASKS } = require("./contract");
const {
  STANDALONE_READER_SCOPE,
  readerPreviewEngineStatus,
  runReaderPostprocessJob,
} = require("../readerDocumentRuntime");
const {
  metricsRequestAuthorized,
  registry,
} = require("../observability/metrics");
const { distributedTopology } = require("../microModules/serviceHost");
const { moduleReadinessEnvelope } = require("../modulePlatform/readiness");
const { loadServiceIdentity } = require("../security/serviceIdentity");

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
    this.healthServer = null;
    this.processing = false;
    this.ready = false;
    this.lifecycleStatus = "created";
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
      this.ready = false;
      this.lifecycleStatus = "not-ready";
      this.lastError = {
        at: this.now().toISOString(),
        code: "READER_WORKER_QUEUE_DISABLED",
        message: "Durable reader queue is disabled.",
      };
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
    this.pollTimer.unref?.();
    this.ready = true;
    this.lifecycleStatus = "running";
    this.lastError = null;
    tick();
    console.log(
      `[ReaderWorker] durable queue polling enabled worker=${this.workerId} interval=${intervalMs}ms`
    );
    return this.pollTimer;
  }

  stopQueuePolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.ready = false;
  }

  fail(error) {
    this.ready = false;
    this.lifecycleStatus = "failed";
    this.lastError = {
      at: this.now().toISOString(),
      code: error?.code || null,
      message: error?.message || String(error || "unknown"),
    };
    return this.snapshot();
  }

  async stop() {
    this.lifecycleStatus = "stopping";
    this.stopQueuePolling();
    const deadline = Date.now() + 30_000;
    while (this.processing && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.healthServer) {
      await new Promise((resolve) => this.healthServer.close(() => resolve()));
      this.healthServer = null;
    }
    this.lifecycleStatus = "stopped";
    return this.snapshot();
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

    const component = {
      role: "reader-worker",
      status: this.processing ? "processing" : "idle",
      ready: this.ready,
      lifecycleStatus: this.lifecycleStatus,
      lastError: this.lastError,
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
    return {
      ...moduleReadinessEnvelope("reader-worker", component, {
        source: "reader-worker-runtime",
        ready: this.ready,
      }),
      ...component,
    };
  }

  startHealthServer({ port = 3011 } = {}) {
    if (this.healthServer) return this.healthServer;
    const handler = (request, response) => {
      if (request.url === "/metrics") {
        if (!metricsRequestAuthorized(request)) {
          response.writeHead(403, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ success: false, error: "metrics_forbidden" })
          );
          return;
        }
        registry.metrics().then((body) => {
          response.writeHead(200, { "Content-Type": registry.contentType });
          response.end(body);
        });
        return;
      }
      if (request.url === "/health") {
        const snapshot = this.snapshot();
        response.writeHead(snapshot.ready ? 200 : 503, {
          "Content-Type": "application/json",
        });
        response.end(
          JSON.stringify({
            success: snapshot.ready,
            ...snapshot,
            status: snapshot.lifecycleStatus,
            error: snapshot.ready ? null : this.lastError?.code || "not_ready",
          })
        );
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
    };
    const identity = loadServiceIdentity("reader-worker", {
      required: distributedTopology(process.env),
    });
    const server = identity
      ? https.createServer(
          {
            ca: identity.ca,
            cert: identity.cert,
            key: identity.key,
            minVersion: "TLSv1.3",
            requestCert: true,
            rejectUnauthorized: false,
          },
          handler
        )
      : http.createServer(handler);

    server.listen(port, () => {
      console.log(`[ReaderWorker] health server listening on ${port}`);
    });
    this.healthServer = server;
    return this.healthServer;
  }
}

module.exports = { ReaderWorkerRuntime };
