const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const LEGACY_DRAIN_TIMEOUT_MS = 1_000;
const { metrics } = require("../observability/metrics");

function deadlineTimeout(promise, timeoutMs, label = "operation") {
  const bounded = Math.max(Number(timeoutMs) || 0, 0);
  if (!Number.isFinite(bounded))
    return Promise.resolve(promise)
      .then((value) => ({ timedOut: false, value, label }))
      .catch((error) => ({ timedOut: false, error, label }));
  if (bounded <= 0) return Promise.resolve({ timedOut: true, label });
  let timer;
  return Promise.race([
    Promise.resolve(promise)
      .then((value) => ({ timedOut: false, value, label }))
      .catch((error) => ({ timedOut: false, error, label })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true, label }), bounded);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function gracefulShutdownEnabled(env = process.env) {
  return (
    String(env.ATHENA_GRACEFUL_SHUTDOWN_V2 || "true").toLowerCase() !== "false"
  );
}

async function disconnectRuntimeDatabases() {
  const { DataAccessCenter } = require("../dataAccess");
  return DataAccessCenter.runtimeLifecycle.disconnectDatabases();
}

async function shutdownStandaloneRuntime({
  name = "runtime",
  stop = async () => {},
  closeServer = async () => {},
  timeoutMs = gracefulShutdownEnabled()
    ? DEFAULT_DRAIN_TIMEOUT_MS
    : LEGACY_DRAIN_TIMEOUT_MS,
} = {}) {
  const boundedTimeout = Math.max(1_000, Number(timeoutMs) || 0);
  const deadlineAt = Date.now() + boundedTimeout;
  const drain = await deadlineTimeout(
    Promise.all([
      Promise.resolve().then(stop),
      Promise.resolve().then(closeServer),
    ]),
    boundedTimeout,
    `${name}-drain`
  );
  const disconnectRemaining = deadlineAt - Date.now();
  const disconnect =
    disconnectRemaining > 0
      ? await deadlineTimeout(
          Promise.resolve().then(() => disconnectRuntimeDatabases()),
          disconnectRemaining,
          `${name}-database-disconnect`
        )
      : { timedOut: true, label: `${name}-database-disconnect` };
  if (drain.error || disconnect.error) {
    console.error(`[Runtime] ${name} shutdown failed.`, {
      drain: drain.error?.message || null,
      disconnect: disconnect.error?.message || null,
    });
  }
  metrics.runtimeShutdowns.inc({
    outcome:
      drain.timedOut || disconnect.timedOut
        ? "timed_out"
        : drain.error || disconnect.error
          ? "failed"
          : "drained",
  });
  return {
    drained: !drain.timedOut && !drain.error,
    disconnected: !disconnect.timedOut && !disconnect.error,
    timedOut: drain.timedOut || disconnect.timedOut,
  };
}

class RuntimeCoordinator {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.startedAt = now().toISOString();
    this.status = "created";
    this.ready = false;
    this.started = [];
    this.components = new Map();
    this.server = null;
    this.startPromise = null;
    this.shutdownRequested = false;
    this.shutdownPromise = null;
    this.lastError = null;
  }

  register({
    name,
    start = async () => {},
    stop = async () => {},
    order = 100,
    stopOrder = order,
  }) {
    if (!name) throw new Error("Runtime component name is required.");
    if (this.status !== "created")
      throw new Error("Runtime components must be registered before startup.");
    if (this.components.has(name))
      throw new Error(`Runtime component already registered: ${name}`);
    if (!Number.isFinite(Number(order)) || !Number.isFinite(Number(stopOrder)))
      throw new Error(`Runtime component order is invalid: ${name}`);
    this.components.set(name, {
      name,
      start,
      stop,
      order: Number(order),
      stopOrder: Number(stopOrder),
    });
    return this;
  }

  attachServer(server) {
    this.server = server || null;
    return this;
  }

  start() {
    if (this.status === "running") return Promise.resolve(this.snapshot());
    if (this.startPromise) return this.startPromise;
    if (this.status === "stopping" || this.status === "stopped")
      return Promise.reject(
        new Error("Runtime cannot be started after shutdown has begun.")
      );
    this.startPromise = (async () => {
      this.status = "starting";
      this.ready = false;
      const ordered = [...this.components.values()].sort(
        (left, right) => left.order - right.order
      );
      try {
        for (const component of ordered) {
          await component.start();
          this.started.push(component);
          if (this.shutdownRequested) {
            const error = new Error("Runtime startup interrupted by shutdown.");
            error.code = "RUNTIME_STARTUP_ABORTED";
            throw error;
          }
        }
        this.status = "running";
        this.ready = true;
        return this.snapshot();
      } catch (error) {
        const aborted = error?.code === "RUNTIME_STARTUP_ABORTED";
        this.status = aborted ? "stopping" : "failed";
        if (!aborted) this.lastError = error?.message || String(error);
        if (!this.shutdownRequested) await this.stopComponents();
        throw error;
      }
    })();
    return this.startPromise;
  }

  async stopComponents({
    deadlineAt = Number.POSITIVE_INFINITY,
    minStopOrder = Number.NEGATIVE_INFINITY,
    maxStopOrder = Number.POSITIVE_INFINITY,
  } = {}) {
    const ordered = this.started
      .filter(
        (component) =>
          component.stopOrder >= minStopOrder &&
          component.stopOrder <= maxStopOrder
      )
      .sort((left, right) => left.stopOrder - right.stopOrder);
    const results = [];
    for (const component of ordered) {
      this.started = this.started.filter(
        (candidate) => candidate !== component
      );
      const remaining = deadlineAt - Date.now();
      const result = await deadlineTimeout(
        Promise.resolve().then(() => component.stop()),
        remaining,
        component.name
      );
      results.push(result);
      if (result.error) {
        this.lastError =
          this.lastError || `shutdown_component_failed:${component.name}`;
        console.error(
          `[Runtime] Failed to stop ${component.name}.`,
          result.error
        );
      }
      if (result.timedOut) {
        this.lastError = `shutdown_deadline_exceeded:${component.name}`;
        break;
      }
    }
    return results;
  }

  async closeHttpServer(timeoutMs) {
    if (!this.server) return { drained: true };
    const server = this.server;
    let timeout;
    const drained = await Promise.race([
      new Promise((resolve) => server.close(() => resolve(true))),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    clearTimeout(timeout);
    if (!drained) server.closeAllConnections?.();
    return { drained };
  }

  shutdown({
    timeoutMs = gracefulShutdownEnabled()
      ? DEFAULT_DRAIN_TIMEOUT_MS
      : LEGACY_DRAIN_TIMEOUT_MS,
  } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    this.shutdownPromise = (async () => {
      this.ready = false;
      this.status = "stopping";
      const boundedTimeout = Math.max(1_000, Number(timeoutMs) || 0);
      const deadlineAt = Date.now() + boundedTimeout;
      const startupSettlement = this.startPromise
        ? await deadlineTimeout(
            this.startPromise,
            Math.max(deadlineAt - Date.now(), 0),
            "runtime-startup-settlement"
          )
        : { timedOut: false, label: "runtime-startup-settlement" };
      if (startupSettlement.timedOut)
        this.lastError = this.lastError || "startup_shutdown_deadline_exceeded";
      this.status = "stopping";
      // Stop accepting new work immediately. Producers may drain in parallel
      // with already accepted HTTP requests, but durable consumers and
      // telemetry remain alive until both ingress and producers are closed.
      const ingressAndProducers = await deadlineTimeout(
        Promise.all([
          this.closeHttpServer(boundedTimeout),
          this.stopComponents({ deadlineAt, maxStopOrder: 69 }),
        ]),
        Math.max(deadlineAt - Date.now(), 0),
        "runtime-ingress-and-producers"
      );
      const producerTimedOut = Array.isArray(ingressAndProducers.value?.[1])
        ? ingressAndProducers.value[1].some((entry) => entry.timedOut)
        : false;
      const remainingForConsumers = deadlineAt - Date.now();
      const consumers =
        remainingForConsumers > 0 && !ingressAndProducers.timedOut
          ? await deadlineTimeout(
              this.stopComponents({ deadlineAt, minStopOrder: 70 }),
              remainingForConsumers,
              "runtime-durable-consumers"
            )
          : { timedOut: true, label: "runtime-durable-consumers" };
      const consumerTimedOut = Array.isArray(consumers.value)
        ? consumers.value.some((entry) => entry.timedOut)
        : false;
      if (
        ingressAndProducers.timedOut ||
        producerTimedOut ||
        consumers.timedOut ||
        consumerTimedOut
      ) {
        this.server?.closeAllConnections?.();
        this.lastError = this.lastError || "shutdown_deadline_exceeded";
      }
      const disconnectRemaining = deadlineAt - Date.now();
      const disconnect =
        disconnectRemaining > 0
          ? await deadlineTimeout(
              Promise.resolve().then(() => disconnectRuntimeDatabases()),
              disconnectRemaining,
              "database-disconnect"
            )
          : { timedOut: true, label: "database-disconnect" };
      if (disconnect.error) {
        console.error(
          "[Runtime] Failed to disconnect databases.",
          disconnect.error
        );
      }
      if (disconnect.timedOut) {
        this.lastError = this.lastError || "database_disconnect_timed_out";
      }
      this.status = "stopped";
      const httpResult = Array.isArray(ingressAndProducers.value)
        ? ingressAndProducers.value[0]
        : { drained: false };
      const result = {
        ...this.snapshot(),
        ...httpResult,
        timedOut:
          startupSettlement.timedOut ||
          ingressAndProducers.timedOut ||
          producerTimedOut ||
          consumers.timedOut ||
          consumerTimedOut ||
          disconnect.timedOut,
      };
      metrics.runtimeShutdowns.inc({
        outcome: result.timedOut
          ? "timed_out"
          : this.lastError
            ? "failed"
            : "drained",
      });
      return result;
    })();
    return this.shutdownPromise;
  }

  snapshot() {
    return {
      status: this.status,
      ready: this.ready,
      startedAt: this.startedAt,
      components: this.started.map((component) => component.name),
      lastError: this.lastError,
    };
  }
}

const runtimeCoordinator = new RuntimeCoordinator();

module.exports = {
  DEFAULT_DRAIN_TIMEOUT_MS,
  LEGACY_DRAIN_TIMEOUT_MS,
  RuntimeCoordinator,
  deadlineTimeout,
  disconnectRuntimeDatabases,
  gracefulShutdownEnabled,
  runtimeCoordinator,
  shutdownStandaloneRuntime,
};
