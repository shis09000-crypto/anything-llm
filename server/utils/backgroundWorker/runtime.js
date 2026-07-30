const http = require("http");
const https = require("https");
const { BackgroundService } = require("../BackgroundWorkers");
const {
  metricsRequestAuthorized,
  registry,
} = require("../observability/metrics");
const {
  loadServiceIdentity,
  serviceIdentitySummary,
} = require("../security/serviceIdentity");
const { distributedTopology } = require("../microModules/serviceHost");
const { moduleReadinessEnvelope } = require("../modulePlatform/readiness");

class BackgroundWorkerRuntime {
  constructor({
    now = () => new Date(),
    backgroundServiceFactory = () =>
      new BackgroundService({
        mode:
          process.env.ATHENA_RUNTIME_TOPOLOGY === "distributed"
            ? "maintenance"
            : "combined",
      }),
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
      const identity = serviceIdentitySummary("background-worker");
      if (!identity.valid) throw new Error(identity.error);
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
    const component = {
      role: "background-worker",
      status: this.status,
      startedAt: this.startedAt,
      now: this.now().toISOString(),
      inline: false,
      mode: this.service?.mode || null,
      jobs: this.service?.jobs?.().map((job) => job.name) || [],
      lastError: this.lastError,
      serviceIdentity: serviceIdentitySummary("background-worker", {
        required: false,
      }),
    };
    const ready = this.status === "running";
    return {
      ...moduleReadinessEnvelope("background-worker", component, {
        source: "background-worker-runtime",
        ready,
      }),
      ...component,
      ready,
    };
  }

  fail(error) {
    this.status = "failed";
    this.lastError = error?.message || String(error || "unknown");
    return this.snapshot();
  }

  startHealthServer({ port = 3012 } = {}) {
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
        const ok = snapshot.ready;
        response.writeHead(ok ? 200 : 503, {
          "Content-Type": "application/json",
        });
        response.end(JSON.stringify({ success: ok, ...snapshot }));
        return;
      }

      if (request.url === "/snapshot") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(this.snapshot()));
        return;
      }

      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, error: "not_found" }));
    };
    const identity = loadServiceIdentity("background-worker", {
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
