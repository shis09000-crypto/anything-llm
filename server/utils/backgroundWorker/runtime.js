const http = require("http");
const { BackgroundService } = require("../BackgroundWorkers");

class BackgroundWorkerRuntime {
  constructor({
    now = () => new Date(),
    backgroundServiceFactory = () => new BackgroundService(),
  } = {}) {
    this.startedAt = now().toISOString();
    this.now = now;
    this.backgroundServiceFactory = backgroundServiceFactory;
    this.service = null;
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

  startHealthServer({ port = 3012 } = {}) {
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        const ok = this.status === "running" || this.status === "starting";
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
    return server;
  }
}

module.exports = { BackgroundWorkerRuntime };
