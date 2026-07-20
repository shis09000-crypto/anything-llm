const http = require("http");
const { BackgroundService } = require("../BackgroundWorkers");
const {
  metricsRequestAuthorized,
  registry,
} = require("../observability/metrics");

class BackgroundWorkerRuntime {
  constructor({
    now = () => new Date(),
    backgroundServiceFactory = () => new BackgroundService(),
  } = {}) {
    this.startedAt = now().toISOString();
    this.now = now;
    this.backgroundServiceFactory = backgroundServiceFactory;
    this.service = null;
    this.healthServer = null;
    this.status = "created";
    this.lastError = null;
  }

  async start() {
    if (this.service) return this.snapshot();
    this.status = "starting";
    try {
      this.service = this.backgroundServiceFactory();
      await this.service.boot();
      this.status = "running";
    } catch (error) {
      this.status = "failed";
      this.lastError = error.message;
      throw error;
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      role: "background-worker",
      status: this.status,
      startedAt: this.startedAt,
      now: this.now().toISOString(),
      inline: false,
      jobs: this.service?.jobs?.().map((job) => job.name) || [],
      lastError: this.lastError,
    };
  }

  fail(error) {
    this.status = "failed";
    this.lastError = error?.message || String(error || "unknown");
    return this.snapshot();
  }

  startHealthServer({ port = 3012 } = {}) {
    if (this.healthServer) return this.healthServer;
    const server = http.createServer((request, response) => {
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
        const ok = this.status === "running";
        response.writeHead(ok ? 200 : 503, {
          "Content-Type": "application/json",
        });
        response.end(
          JSON.stringify({ success: ok, role: "background-worker" })
        );
        return;
      }

      if (request.url === "/snapshot") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(this.snapshot()));
        return;
      }

      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, error: "not_found" }));
    });

    server.listen(port, () => {
      console.log(`[BackgroundWorker] health server listening on ${port}`);
    });
    this.healthServer = server;
    return server;
  }

  async stop() {
    if (this.status === "stopped" || this.status === "stopping")
      return this.snapshot();
    this.status = "stopping";
    if (this.healthServer) {
      await new Promise((resolve) => this.healthServer.close(() => resolve()));
      this.healthServer = null;
    }
    if (this.service?.stop) await this.service.stop();
    this.service = null;
    this.status = "stopped";
    return this.snapshot();
  }
}

module.exports = { BackgroundWorkerRuntime };
