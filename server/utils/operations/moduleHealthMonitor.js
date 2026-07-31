const { loadManifests } = require("../modulePlatform/manifestRegistry");
const { requestInternalService } = require("../microModules/internalClient");
const { emitSemanticEvent } = require("../observability/semanticEvents");

const DEFAULT_INTERVAL_MS = 15_000;

function boundedInterval(value) {
  return Math.max(
    5_000,
    Math.min(Number(value) || DEFAULT_INTERVAL_MS, 5 * 60_000)
  );
}

function normalizedEndpoint(value) {
  if (typeof value === "string") {
    const url = value.trim().replace(/\/$/, "");
    return url || null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const url = String(value.url || value.baseUrl || "")
    .trim()
    .replace(/\/$/, "");
  if (!url) return null;
  const readinessPath = String(value.readinessPath || value.path || "").trim();
  return {
    url,
    ...(readinessPath
      ? {
          readinessPath: readinessPath.startsWith("/")
            ? readinessPath
            : `/${readinessPath}`,
        }
      : {}),
  };
}

function endpointUrl(endpoint, manifest) {
  if (!endpoint) return null;
  if (typeof endpoint === "string")
    return `${endpoint}${manifest.deployment.readinessPath}`;
  return `${endpoint.url}${
    endpoint.readinessPath || manifest.deployment.readinessPath
  }`;
}

function parseEndpointMap(env = process.env) {
  const endpoints = {};
  const configured = String(env.ATHENA_MODULE_RUNTIME_ENDPOINTS || "").trim();
  if (configured) {
    try {
      const parsed = JSON.parse(configured);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, value] of Object.entries(parsed)) {
          const normalized = normalizedEndpoint(value);
          if (normalized) endpoints[id] = normalized;
        }
      }
    } catch {
      // The invalid configuration is surfaced by configError in the snapshot.
    }
  }
  const conventional = {
    "athena-api": env.ATHENA_API_INTERNAL_URL,
    authentication: env.ATHENA_IDENTITY_URL,
    "edge-web": env.ATHENA_EDGE_WEB_URL,
    "chat-runtime": env.ATHENA_CHAT_RUNTIME_URL || env.ATHENA_CHAT_UPSTREAM,
    "agent-runtime": env.ATHENA_AGENT_RUNTIME_URL || env.ATHENA_AGENT_UPSTREAM,
    "model-gateway": env.ATHENA_MODEL_GATEWAY_URL,
    "tool-runtime": env.ATHENA_TOOL_BROKER_URL || env.ATHENA_TOOL_UPSTREAM,
    "crypto-market": env.ATHENA_CRYPTO_MARKET_URL,
    "crypto-account-access":
      env.ATHENA_CRYPTO_ACCOUNT_URL || env.ATHENA_CRYPTO_ACCOUNT_UPSTREAM,
    "crypto-forecast":
      env.ATHENA_CRYPTO_FORECAST_URL || env.ATHENA_CRYPTO_FORECAST_UPSTREAM,
    "key-custody": env.ATHENA_KEY_CUSTODY_URL,
    "knowledge-ingest": env.ATHENA_KNOWLEDGE_INGEST_URL,
    rag: env.ATHENA_RAG_URL,
    "operations-shadow-agents": env.ATHENA_OPERATIONS_SHADOW_AGENTS_URL,
    scheduler: env.ATHENA_SCHEDULER_INTERNAL_URL,
    "reader-worker": env.ATHENA_READER_WORKER_URL,
    "background-worker": env.ATHENA_BACKGROUND_WORKER_URL,
    "sync-v2": env.ATHENA_REALTIME_GATEWAY_URL,
    collector: env.ATHENA_COLLECTOR_INTERNAL_URL,
  };
  for (const [id, value] of Object.entries(conventional)) {
    const normalized = normalizedEndpoint(value);
    if (!endpoints[id] && normalized) endpoints[id] = normalized;
  }
  const apiInternal = normalizedEndpoint(env.ATHENA_API_INTERNAL_URL);
  const legacyColocated =
    String(
      env.ATHENA_ALLOW_COLOCATED_MODULE_PROBES || "false"
    ).toLowerCase() === "true";
  if (apiInternal && legacyColocated) {
    const baseUrl =
      typeof apiInternal === "string" ? apiInternal : apiInternal.url;
    for (const id of ["authentication", "knowledge-ingest", "rag"]) {
      if (!endpoints[id])
        endpoints[id] = {
          url: baseUrl,
          readinessPath: `/internal/v1/module-readiness/${id}`,
        };
    }
  }
  return endpoints;
}

function endpointConfigError(env = process.env) {
  const configured = String(env.ATHENA_MODULE_RUNTIME_ENDPOINTS || "").trim();
  if (!configured) return null;
  try {
    const parsed = JSON.parse(configured);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? null
      : "module_runtime_endpoints_invalid";
  } catch {
    return "module_runtime_endpoints_invalid";
  }
}

function normalizedRemoteState(manifest, response, durationMs) {
  if (response?.moduleId && response.moduleId !== manifest.id)
    return {
      status: "degraded",
      ready: false,
      reasonCode: "module_identity_mismatch",
      observedModuleId: response.moduleId,
      durationMs,
    };
  if (response?.version && response.version !== manifest.version)
    return {
      status: "degraded",
      ready: false,
      reasonCode: "module_version_mismatch",
      observedVersion: response.version,
      durationMs,
    };
  if (
    response?.manifestFingerprint &&
    response.manifestFingerprint !== manifest.fingerprint
  )
    return {
      status: "degraded",
      ready: false,
      reasonCode: "module_manifest_mismatch",
      observedVersion: response.version || null,
      durationMs,
    };
  if (
    !response?.moduleId ||
    !response?.version ||
    !response?.manifestFingerprint
  )
    return {
      status: "degraded",
      ready: Boolean(response?.ready ?? response?.success),
      reasonCode: "module_contract_metadata_missing",
      durationMs,
    };
  return {
    status: response.ready === false ? "degraded" : "healthy",
    ready: response.ready !== false,
    reasonCode: response.ready === false ? "module_reported_not_ready" : null,
    observedVersion: response.version,
    observedManifestFingerprint: response.manifestFingerprint,
    durationMs,
  };
}

class ModuleHealthMonitor {
  constructor({
    env = process.env,
    request = requestInternalService,
    emit = emitSemanticEvent,
    manifests = loadManifests,
  } = {}) {
    this.env = env;
    this.request = request;
    this.emit = emit;
    this.manifests = manifests;
    this.timer = null;
    this.running = null;
    this.started = false;
    this.lastCheckedAt = null;
    this.states = new Map();
    this.localProviders = new Map();
  }

  endpoints() {
    return parseEndpointMap(this.env);
  }

  start({ localProviders = {} } = {}) {
    if (this.started) return this.snapshot();
    this.started = true;
    this.localProviders = new Map(Object.entries(localProviders));
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
    }, boundedInterval(this.env.ATHENA_OPERATIONS_MODULE_POLL_MS));
    this.timer.unref?.();
  }

  async stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => null);
    return this.snapshot();
  }

  async probe(manifest, endpoint) {
    const startedAt = Date.now();
    if (this.localProviders.has(manifest.id)) {
      try {
        const response = await this.localProviders.get(manifest.id)();
        return {
          ...normalizedRemoteState(
            manifest,
            {
              moduleId: manifest.id,
              version: manifest.version,
              manifestFingerprint: manifest.fingerprint,
              ready: response?.ready !== false,
            },
            Date.now() - startedAt
          ),
          source: "local",
        };
      } catch (error) {
        return {
          status: "degraded",
          ready: false,
          reasonCode: String(
            error?.code || error?.message || "module_local_probe_failed"
          ).slice(0, 160),
          durationMs: Date.now() - startedAt,
          source: "local",
        };
      }
    }
    if (!endpoint)
      return {
        status: "unmonitored",
        ready: null,
        reasonCode: "module_endpoint_not_configured",
        durationMs: 0,
        source: "none",
      };
    try {
      const response = await this.request({
        callerRole: "operations-plane",
        url: endpointUrl(endpoint, manifest),
        method: "GET",
        env: this.env,
        timeoutMs: Math.max(
          1_000,
          Math.min(
            Number(this.env.ATHENA_OPERATIONS_MODULE_TIMEOUT_MS) || 3_000,
            10_000
          )
        ),
      });
      return {
        ...normalizedRemoteState(manifest, response, Date.now() - startedAt),
        source: "probe",
      };
    } catch (error) {
      return {
        status: "degraded",
        ready: false,
        reasonCode: String(
          error?.reasonCode ||
            error?.code ||
            error?.message ||
            "module_probe_failed"
        ).slice(0, 160),
        durationMs: Date.now() - startedAt,
        source: "probe",
      };
    }
  }

  recordTransition(manifest, previous, current) {
    if (
      !previous ||
      (previous.status === current.status &&
        previous.reasonCode === current.reasonCode)
    )
      return;
    this.emit({
      eventType: "module.health.changed",
      category: "module_health",
      severity: current.status === "degraded" ? "error" : "info",
      outcome:
        current.status === "healthy"
          ? "recovered"
          : current.status === "degraded"
            ? "degraded"
            : "observed",
      subject: {
        type: "service",
        id: manifest.id,
        component: manifest.id,
        operation: "readiness_probe",
      },
      stateTransition: {
        from: previous.status,
        to: current.status,
        reasonCode: current.reasonCode,
      },
      impact: {
        scope: manifest.security.failureMode,
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

  recordProbeHeartbeat(manifest, current) {
    if (current.status !== "healthy" || current.ready !== true) return;
    this.emit({
      eventType: "module.telemetry.heartbeat",
      category: "module_health",
      severity: "info",
      outcome: "observed",
      subject: {
        type: "service",
        id: manifest.id,
        component: manifest.id,
        operation: "readiness_probe_heartbeat",
      },
      impact: {
        scope: manifest.security.failureMode,
        status: "connected",
      },
      evidence: [
        {
          type: "metric",
          metric: `probe_duration_ms=${current.durationMs || 0}`,
        },
      ],
      metadata: {
        source: current.source,
        checkedAt: current.checkedAt,
      },
      sensitivity: "metadata_only",
    });
  }

  async refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      const endpoints = this.endpoints();
      const checkedAt = new Date().toISOString();
      const results = await Promise.all(
        this.manifests().map(async (manifest) => {
          const current = {
            moduleId: manifest.id,
            expectedVersion: manifest.version,
            expectedManifestFingerprint: manifest.fingerprint,
            endpointConfigured:
              this.localProviders.has(manifest.id) ||
              Boolean(endpoints[manifest.id]),
            checkedAt,
            ...(await this.probe(manifest, endpoints[manifest.id])),
          };
          this.recordTransition(
            manifest,
            this.states.get(manifest.id),
            current
          );
          this.recordProbeHeartbeat(manifest, current);
          return current;
        })
      );
      this.states = new Map(results.map((state) => [state.moduleId, state]));
      this.lastCheckedAt = checkedAt;
      return this.snapshot();
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  snapshot() {
    const modules = this.manifests().map((manifest) => {
      return (
        this.states.get(manifest.id) || {
          moduleId: manifest.id,
          expectedVersion: manifest.version,
          expectedManifestFingerprint: manifest.fingerprint,
          endpointConfigured: false,
          status: "unmonitored",
          ready: null,
          reasonCode: "module_health_not_checked",
          durationMs: 0,
          checkedAt: null,
          source: "none",
        }
      );
    });
    const healthy = modules.filter(
      (module) => module.status === "healthy"
    ).length;
    const degraded = modules.filter(
      (module) => module.status === "degraded"
    ).length;
    const unmonitored = modules.filter(
      (module) => module.status === "unmonitored"
    ).length;
    const monitored = modules.length - unmonitored;
    return {
      enabled: this.started,
      status: !this.started
        ? "disabled"
        : degraded
          ? "degraded"
          : unmonitored
            ? "coverage-incomplete"
            : "running",
      configError: endpointConfigError(this.env),
      lastCheckedAt: this.lastCheckedAt,
      modules,
      summary: {
        total: modules.length,
        healthy,
        degraded,
        unmonitored,
        monitored,
        coverageRatio: modules.length ? monitored / modules.length : 0,
        complete: modules.length > 0 && healthy === modules.length,
      },
    };
  }
}

const moduleHealthMonitor = new ModuleHealthMonitor();

module.exports = {
  ModuleHealthMonitor,
  endpointConfigError,
  moduleHealthMonitor,
  normalizedRemoteState,
  endpointUrl,
  normalizedEndpoint,
  parseEndpointMap,
};
