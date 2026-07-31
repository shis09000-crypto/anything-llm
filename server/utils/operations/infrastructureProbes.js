const http = require("http");
const https = require("https");
const {
  contentObjectProvider,
} = require("../../providers/storage/contentObjectProvider");
const { DataAccessCenter } = require("../dataAccess");
const { requestInternalService } = require("../microModules/internalClient");
const {
  expectedCapabilities,
  runtimeCapabilities,
} = require("../security/cryptoRuntimeCapabilities");

function httpHealth(url, { timeoutMs = 5_000 } = {}) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(
      target,
      { timeout: Math.max(1_000, Number(timeoutMs) || 0) },
      (response) => {
        response.resume();
        response.once("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300)
            return resolve({ ready: true });
          const error = new Error(
            `infrastructure_http_${response.statusCode || 0}`
          );
          error.code = "INFRASTRUCTURE_HTTP_NOT_READY";
          reject(error);
        });
      }
    );
    request.once("timeout", () => {
      request.destroy(
        Object.assign(new Error("infrastructure_probe_timeout"), {
          code: "INFRASTRUCTURE_PROBE_TIMEOUT",
        })
      );
    });
    request.once("error", reject);
  });
}

async function mainDatabaseProbe() {
  const readiness = await DataAccessCenter.runtimeLifecycle.databaseReadiness();
  return {
    ready: readiness?.ready === true,
    provider: readiness?.mainProvider || "unknown",
  };
}

async function objectStorageProbe(env = process.env) {
  return contentObjectProvider(env).health();
}

function operationsDependencyProbe(plane, dependency) {
  const state = plane.health()?.[dependency] || {};
  const ready =
    dependency === "jetstream"
      ? state.ready === true || state.connected === true
      : state.ready === true;
  return {
    ready,
    reasonCode: ready
      ? null
      : String(
          state.lastError ||
            state.reasonCode ||
            `${dependency}_reported_not_ready`
        ).slice(0, 160),
  };
}

async function remoteDependencyProbe({
  env,
  request,
  baseUrl,
  path,
  selector,
}) {
  if (!String(baseUrl || "").trim())
    return {
      ready: false,
      reasonCode: "dependency_runtime_endpoint_missing",
    };
  const response = await request({
    callerRole: "operations-plane",
    url: `${String(baseUrl).replace(/\/+$/, "")}${path}`,
    method: "GET",
    env,
    timeoutMs: Math.max(
      1_000,
      Number(env.ATHENA_OPERATIONS_INFRA_TIMEOUT_MS || 5_000)
    ),
  });
  const selected = selector(response);
  return {
    ready: selected?.ready === true,
    reasonCode:
      selected?.ready === true
        ? null
        : String(
            selected?.reasonCode || "dependency_runtime_reported_not_ready"
          ).slice(0, 160),
  };
}

function postQuantumProbeFactory(env = process.env) {
  let cached = null;
  let cachedAt = 0;
  return async () => {
    const now = Date.now();
    if (!cached || now - cachedAt >= 60_000) {
      const current = runtimeCapabilities();
      const expected = expectedCapabilities(current, env);
      const missing = Object.entries(expected)
        .filter(([, required]) => required === true)
        .filter(([capability]) => current[capability] !== true)
        .map(([capability]) => capability);
      cached = {
        ready: missing.length === 0,
        reasonCode: missing.length
          ? `post_quantum_capability_missing:${missing.join(",")}`
          : null,
      };
      cachedAt = now;
    }
    return cached;
  };
}

function buildInfrastructureProbeProviders({
  plane,
  env = process.env,
  request = requestInternalService,
} = {}) {
  if (!plane) throw new Error("operations_plane_required_for_infra_probes");
  const ragProbe = (selector) => () =>
    remoteDependencyProbe({
      env,
      request,
      baseUrl: env.ATHENA_RAG_URL,
      path: "/internal/v1/rag/dependencies",
      selector,
    });
  return {
    "main-database": mainDatabaseProbe,
    "object-storage": () => objectStorageProbe(env),
    "nats-jetstream": () => operationsDependencyProbe(plane, "jetstream"),
    clickhouse: () => operationsDependencyProbe(plane, "clickhouse"),
    "otel-collector": () =>
      httpHealth(env.ATHENA_OTEL_HEALTH_URL || "http://otel-collector:13133", {
        timeoutMs: env.ATHENA_OPERATIONS_INFRA_TIMEOUT_MS,
      }),
    "model-provider": () =>
      remoteDependencyProbe({
        env,
        request,
        baseUrl: env.ATHENA_MODEL_GATEWAY_URL,
        path: "/internal/v1/models/health",
        selector: (response) => response.dependencies?.modelProvider,
      }),
    "vector-database": ragProbe(
      (response) => response.dependencies?.vectorDatabase
    ),
    "embedding-provider": ragProbe(
      (response) => response.dependencies?.embeddingProvider
    ),
    "post-quantum-security": postQuantumProbeFactory(env),
  };
}

module.exports = {
  buildInfrastructureProbeProviders,
  httpHealth,
  mainDatabaseProbe,
  objectStorageProbe,
  operationsDependencyProbe,
  postQuantumProbeFactory,
  remoteDependencyProbe,
};
