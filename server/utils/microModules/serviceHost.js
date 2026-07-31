const express = require("express");
const http = require("http");
const https = require("https");
const { moduleManifest } = require("../modulePlatform/manifestRegistry");
const {
  expectedServiceId,
  loadServiceIdentity,
  serviceIdentitySummary,
} = require("../security/serviceIdentity");
const { metricsEndpoint } = require("../observability/metrics");

function distributedTopology(env = process.env) {
  return ["distributed", "micro-modules"].includes(
    String(env.ATHENA_RUNTIME_TOPOLOGY || "")
      .trim()
      .toLowerCase()
  );
}

function peerServiceIds(request) {
  const certificate = request.socket?.getPeerCertificate?.();
  return String(
    certificate?.subjectaltname || certificate?.subjectAltName || ""
  )
    .split(/,\s*/)
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice(4));
}

function internalPeerAuthorized(request, manifest, env = process.env) {
  if (!distributedTopology(env)) return { authorized: true, caller: "local" };
  if (!request.socket?.authorized)
    return {
      authorized: false,
      reason: request.socket?.authorizationError || "mtls_peer_unverified",
    };
  const allowed = new Set(
    manifest.security.allowedCallers.map((caller) => {
      const callerManifest = moduleManifest(caller);
      return expectedServiceId(callerManifest?.runtimeRole || caller, env);
    })
  );
  const caller = peerServiceIds(request).find((serviceId) =>
    allowed.has(serviceId)
  );
  return caller
    ? { authorized: true, caller }
    : { authorized: false, reason: "mtls_caller_not_allowed" };
}

function safeError(error) {
  return String(error?.code || error?.message || "internal_service_failed")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 160);
}

function wrapAsyncRouteHandler(handler) {
  if (Array.isArray(handler)) return handler.map(wrapAsyncRouteHandler);
  if (typeof handler !== "function" || handler.length === 4) return handler;
  return function asyncRouteBoundary(request, response, next) {
    try {
      const result = handler.call(this, request, response, next);
      if (result && typeof result.then === "function") result.catch(next);
      return result;
    } catch (error) {
      next(error);
    }
  };
}

function installAsyncRouteBoundary(app) {
  for (const method of [
    "all",
    "delete",
    "get",
    "head",
    "options",
    "patch",
    "post",
    "put",
    "use",
  ]) {
    const original = app[method];
    if (typeof original !== "function") continue;
    app[method] = function boundedRouteRegistration(...args) {
      return original.apply(
        this,
        args.map((argument) => wrapAsyncRouteHandler(argument))
      );
    };
  }
}

class MicroModuleServiceHost {
  constructor({
    manifestId,
    role,
    port,
    env = process.env,
    registerRoutes = () => {},
    enableWebSockets = false,
    parseJson = true,
    jsonLimit = "256kb",
    onStart = async () => {},
    onDrain = async () => {},
    onStop = async () => {},
    readiness = null,
  } = {}) {
    this.env = env;
    this.manifest = moduleManifest(manifestId);
    if (!this.manifest)
      throw new Error(`module_manifest_missing:${manifestId}`);
    this.role = role || this.manifest.runtimeRole;
    this.port = Number(port);
    if (!Number.isInteger(this.port) || this.port < 0)
      throw new Error(`module_port_invalid:${manifestId}`);
    this.registerRoutes = registerRoutes;
    this.enableWebSockets = enableWebSockets;
    this.parseJson = parseJson;
    this.jsonLimit = jsonLimit;
    this.onStart = onStart;
    this.onDrain = onDrain;
    this.onStop = onStop;
    this.readiness = readiness;
    this.app = express();
    this.server = null;
    this.status = "created";
    this.startedAt = null;
    this.lastError = null;
    this.inflight = 0;
    this.stopping = false;
    this.drainStarted = false;
  }

  snapshot() {
    const component = this.readiness?.() || {};
    const componentReady =
      component.ready === undefined ? true : Boolean(component.ready);
    return {
      moduleId: this.manifest.id,
      role: this.role,
      version: this.manifest.version,
      manifestFingerprint: this.manifest.fingerprint,
      status: this.status,
      ready: this.status === "running" && componentReady,
      inflight: this.inflight,
      startedAt: this.startedAt,
      lastError: this.lastError,
      component,
      serviceIdentity: serviceIdentitySummary(this.role, {
        env: this.env,
        required: false,
      }),
    };
  }

  configureApp() {
    // Express 4 does not forward rejected async route promises to its error
    // middleware. A rejected module RPC must become a scoped 4xx/5xx response,
    // never an unhandled rejection that restarts the whole runtime.
    installAsyncRouteBoundary(this.app);
    this.app.disable("x-powered-by");
    if (this.parseJson) this.app.use(express.json({ limit: this.jsonLimit }));
    this.app.use((request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      next();
    });
    this.app.get("/live", (_request, response) => {
      const live = !["failed", "stopped"].includes(this.status);
      response.status(live ? 200 : 503).json({
        success: live,
        ...this.snapshot(),
      });
    });
    this.app.get("/ready", (_request, response) => {
      const snapshot = this.snapshot();
      response.status(snapshot.ready ? 200 : 503).json({
        success: snapshot.ready,
        ...snapshot,
      });
    });
    this.app.get("/metrics", metricsEndpoint);
    this.app.use("/internal", (request, response, next) => {
      const decision = internalPeerAuthorized(request, this.manifest, this.env);
      if (!decision.authorized)
        return response.status(401).json({
          success: false,
          error: "internal_service_identity_rejected",
          reasonCode: decision.reason,
        });
      response.locals.serviceCaller = decision.caller;
      next();
    });
    this.app.post("/internal/drain", async (_request, response) => {
      if (this.status === "running") {
        this.status = "draining";
        await this.runDrain();
      }
      response.status(202).json({ success: true, ...this.snapshot() });
    });
    this.app.use((request, response, next) => {
      if (this.status !== "running")
        return response.status(503).json({
          success: false,
          error: "module_not_accepting_work",
          status: this.status,
        });
      this.inflight += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.inflight = Math.max(0, this.inflight - 1);
      };
      response.once("finish", release);
      response.once("close", release);
      next();
    });
    this.registerRoutes(this.app, this);
    this.app.use((error, _request, response, _next) => {
      this.lastError = safeError(error);
      response.status(Number(error?.httpStatus) || 500).json({
        success: false,
        error: this.lastError,
      });
    });
  }

  createServer() {
    const required = distributedTopology(this.env);
    const identity = loadServiceIdentity(this.role, {
      env: this.env,
      required,
    });
    if (!identity) return http.createServer(this.app);
    return https.createServer(
      {
        key: identity.key,
        cert: identity.cert,
        ca: identity.ca,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
      },
      this.app
    );
  }

  async start() {
    if (this.server) return this.snapshot();
    this.status = "starting";
    try {
      await this.onStart();
      this.server = this.createServer();
      if (this.enableWebSockets)
        require("@mintplex-labs/express-ws").default(this.app, this.server);
      this.configureApp();
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          this.server?.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.server?.off("error", onError);
          resolve();
        };
        this.server.once("error", onError);
        this.server.once("listening", onListening);
        this.server.listen(this.port);
      });
      this.status = "running";
      this.startedAt = new Date().toISOString();
      this.port = Number(this.server.address()?.port || this.port);
      return this.snapshot();
    } catch (error) {
      this.status = "failed";
      this.lastError = safeError(error);
      throw error;
    }
  }

  async waitForInflight(timeoutMs = 30_000) {
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 0);
    while (this.inflight > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    return this.inflight === 0;
  }

  async runDrain() {
    if (this.drainStarted) return;
    this.drainStarted = true;
    await this.onDrain();
  }

  async stop({ timeoutMs = 30_000 } = {}) {
    if (this.stopping || this.status === "stopped") return this.snapshot();
    this.stopping = true;
    this.status = "draining";
    await this.runDrain().catch((error) => {
      this.lastError = safeError(error);
    });
    const drained = await this.waitForInflight(timeoutMs);
    if (this.server)
      await new Promise((resolve) => {
        this.server.close(() => resolve());
        if (!drained) this.server.closeAllConnections?.();
      });
    await this.onStop();
    this.server = null;
    this.status = "stopped";
    return this.snapshot();
  }
}

module.exports = {
  MicroModuleServiceHost,
  distributedTopology,
  internalPeerAuthorized,
  peerServiceIds,
};
