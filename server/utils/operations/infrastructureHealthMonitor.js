const { emitSemanticEvent } = require("../observability/semanticEvents");
const { serviceCatalog } = require("./serviceCatalog");

const DEFAULT_INTERVAL_MS = 15_000;

function infrastructureServices() {
  return serviceCatalog().filter((service) => !service.manifest);
}

function boundedInterval(value) {
  return Math.max(
    5_000,
    Math.min(Number(value) || DEFAULT_INTERVAL_MS, 5 * 60_000)
  );
}

function normalizedProbeState(response, durationMs) {
  if (!response || typeof response !== "object")
    return {
      status: "degraded",
      ready: false,
      reasonCode: "infrastructure_probe_contract_missing",
      durationMs,
    };
  if (response.ready !== true)
    return {
      status: "degraded",
      ready: false,
      reasonCode: String(
        response.reasonCode || "infrastructure_reported_not_ready"
      ).slice(0, 160),
      durationMs,
    };
  return {
    status: "healthy",
    ready: true,
    reasonCode: null,
    durationMs,
  };
}

class InfrastructureHealthMonitor {
  constructor({
    env = process.env,
    emit = emitSemanticEvent,
    services = infrastructureServices,
  } = {}) {
    this.env = env;
    this.emit = emit;
    this.services = services;
    this.timer = null;
    this.running = null;
    this.started = false;
    this.lastCheckedAt = null;
    this.states = new Map();
    this.providers = new Map();
  }

  start({ providers = {} } = {}) {
    if (this.started) return this.snapshot();
    this.started = true;
    this.providers = new Map(Object.entries(providers));
    void this.refresh();
    this.schedule();
    return this.snapshot();
  }

  schedule() {
    if (this.timer || !this.started) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.refresh();
      this.schedule();
    }, boundedInterval(this.env.ATHENA_OPERATIONS_INFRA_POLL_MS));
    this.timer.unref?.();
  }

  async stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => null);
    return this.snapshot();
  }

  async probe(service) {
    const provider = this.providers.get(service.id);
    if (!provider)
      return {
        status: "unmonitored",
        ready: null,
        reasonCode: "infrastructure_probe_not_configured",
        durationMs: 0,
        source: "none",
      };
    const startedAt = Date.now();
    try {
      const response = await provider();
      return {
        ...normalizedProbeState(response, Date.now() - startedAt),
        source: "authoritative-probe",
      };
    } catch (error) {
      return {
        status: "degraded",
        ready: false,
        reasonCode: String(
          error?.reasonCode ||
            error?.code ||
            error?.message ||
            "infrastructure_probe_failed"
        ).slice(0, 160),
        durationMs: Date.now() - startedAt,
        source: "authoritative-probe",
      };
    }
  }

  recordTransition(service, previous, current) {
    if (
      !previous ||
      (previous.status === current.status &&
        previous.reasonCode === current.reasonCode)
    )
      return;
    this.emit({
      eventType: "infrastructure.health.changed",
      category: "infrastructure_health",
      severity: current.status === "degraded" ? "error" : "info",
      outcome:
        current.status === "healthy"
          ? "recovered"
          : current.status === "degraded"
            ? "degraded"
            : "observed",
      subject: {
        type: service.kind,
        id: service.id,
        component: service.id,
        operation: "authoritative_health_probe",
      },
      stateTransition: {
        from: previous.status,
        to: current.status,
        reasonCode: current.reasonCode,
      },
      impact: {
        scope: service.criticality,
        status: current.status,
      },
      evidence: [
        {
          type: "metric",
          metric: `probe_duration_ms=${current.durationMs || 0}`,
        },
      ],
      metadata: {
        durationMs: current.durationMs || 0,
        reasonCode: current.reasonCode,
      },
      sensitivity: "metadata_only",
    });
  }

  recordHeartbeat(service, current) {
    if (current.status !== "healthy" || current.ready !== true) return;
    this.emit({
      eventType: "infrastructure.telemetry.heartbeat",
      category: "infrastructure_health",
      severity: "info",
      outcome: "observed",
      subject: {
        type: service.kind,
        id: service.id,
        component: service.id,
        operation: "authoritative_health_heartbeat",
      },
      impact: {
        scope: service.criticality,
        status: "connected",
      },
      evidence: [
        {
          type: "metric",
          metric: `probe_duration_ms=${current.durationMs || 0}`,
        },
      ],
      metadata: {
        durationMs: current.durationMs || 0,
      },
      sensitivity: "metadata_only",
    });
  }

  async refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      const checkedAt = new Date().toISOString();
      const results = await Promise.all(
        this.services().map(async (service) => {
          const current = {
            componentId: service.id,
            criticality: service.criticality,
            probeConfigured: this.providers.has(service.id),
            checkedAt,
            ...(await this.probe(service)),
          };
          this.recordTransition(service, this.states.get(service.id), current);
          this.recordHeartbeat(service, current);
          return current;
        })
      );
      this.states = new Map(results.map((state) => [state.componentId, state]));
      this.lastCheckedAt = checkedAt;
      return this.snapshot();
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  snapshot() {
    const components = this.services().map(
      (service) =>
        this.states.get(service.id) || {
          componentId: service.id,
          criticality: service.criticality,
          probeConfigured: false,
          status: "unmonitored",
          ready: null,
          reasonCode: "infrastructure_health_not_checked",
          durationMs: 0,
          checkedAt: null,
          source: "none",
        }
    );
    const healthy = components.filter(
      (component) => component.status === "healthy"
    ).length;
    const degraded = components.filter(
      (component) => component.status === "degraded"
    ).length;
    const unmonitored = components.filter(
      (component) => component.status === "unmonitored"
    ).length;
    const monitored = components.length - unmonitored;
    return {
      enabled: this.started,
      status: !this.started
        ? "disabled"
        : degraded
          ? "degraded"
          : unmonitored
            ? "coverage-incomplete"
            : "running",
      lastCheckedAt: this.lastCheckedAt,
      components,
      summary: {
        total: components.length,
        healthy,
        degraded,
        unmonitored,
        monitored,
        coverageRatio: components.length ? monitored / components.length : 0,
        complete: components.length > 0 && healthy === components.length,
      },
    };
  }
}

const infrastructureHealthMonitor = new InfrastructureHealthMonitor();

module.exports = {
  InfrastructureHealthMonitor,
  infrastructureHealthMonitor,
  infrastructureServices,
  normalizedProbeState,
};
