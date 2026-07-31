#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const {
  loadManifests,
} = require("../server/utils/modulePlatform/manifestRegistry");

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const loadYaml = (file) => yaml.load(read(file));

const RUNTIME_BINDINGS = Object.freeze({
  "athena-api": ["anything-llm-api", "api-production-build"],
  "edge-web": ["anything-llm-edge-probe", "edge-probe-build"],
  "background-worker": [
    "anything-llm-background-worker",
    "background-worker-build",
  ],
  "sync-v2": ["anything-llm-realtime-gateway", "realtime-gateway-build"],
  "reader-worker": ["anything-llm-reader-worker", "reader-worker-build"],
  scheduler: ["anything-llm-scheduler", "scheduler-build"],
  "operations-plane": [
    "anything-llm-operations-plane",
    "operations-plane-build",
  ],
  "chat-runtime": ["anything-llm-chat-runtime", "chat-runtime-build"],
  "agent-runtime": ["anything-llm-agent-runtime", "agent-runtime-build"],
  "model-gateway": ["anything-llm-model-gateway", "model-gateway-build"],
  "tool-runtime": ["anything-llm-tool-broker", "tool-broker-build"],
  "crypto-market": ["anything-llm-crypto-market", "crypto-market-build"],
  "crypto-account-access": [
    "anything-llm-crypto-account",
    "crypto-account-build",
  ],
  "crypto-forecast": ["anything-llm-crypto-forecast", "crypto-forecast-build"],
  "key-custody": ["anything-llm-key-custody", "key-custody-build"],
  collector: ["anything-llm-collector", "collector-build"],
  authentication: ["anything-llm-identity", "identity-build"],
  "knowledge-ingest": [
    "anything-llm-knowledge-ingest",
    "knowledge-ingest-build",
  ],
  rag: ["anything-llm-rag", "rag-build"],
  "operations-shadow-agents": [
    "anything-llm-operations-shadow-agents",
    "operations-shadow-agents-build",
  ],
});

function environment(service = {}) {
  return service.environment && typeof service.environment === "object"
    ? service.environment
    : {};
}

function mtlsConfigured(moduleId, env) {
  if (moduleId === "collector")
    return Boolean(env.COLLECTOR_MTLS_CERT_FILE && env.COLLECTOR_MTLS_KEY_FILE);
  return Boolean(env.ATHENA_MTLS_CERT_FILE && env.ATHENA_MTLS_KEY_FILE);
}

function writableNamedVolumeMounts(service = {}) {
  return (service.volumes || [])
    .map((mount) => String(mount))
    .filter((mount) => !mount.endsWith(":ro"))
    .map((mount) => {
      const [source, target] = mount.split(":");
      return { source, target };
    })
    .filter(({ source, target }) => source && target && !source.startsWith("."));
}

function main() {
  const manifests = loadManifests();
  const manifestIds = new Set(manifests.map(({ id }) => id));
  const base = loadYaml("docker/docker-compose.modular.yml");
  const preproduction = loadYaml("docker/docker-compose.preproduction.yml");
  const prometheus = loadYaml(
    "docker/observability/prometheus.preproduction.yaml"
  );
  const dockerfile = read("docker/Dockerfile");
  const entrypoint = read("docker/docker-entrypoint.sh");
  const findings = [];
  const warnings = [];

  const configuredBindings = new Set(Object.keys(RUNTIME_BINDINGS));
  for (const moduleId of manifestIds)
    if (!configuredBindings.has(moduleId))
      findings.push(`runtime_binding_missing:${moduleId}`);
  for (const moduleId of configuredBindings)
    if (!manifestIds.has(moduleId))
      findings.push(`runtime_binding_unknown:${moduleId}`);

  const endpoints = JSON.parse(
    String(
      preproduction.services?.["anything-llm-operations-plane"]?.environment
        ?.ATHENA_MODULE_RUNTIME_ENDPOINTS || "{}"
    )
  );
  const prometheusIds = new Set(
    (prometheus.scrape_configs || []).flatMap((job) =>
      (job.static_configs || [])
        .map((config) => config.labels?.module_id)
        .filter((moduleId) => moduleId && moduleId !== "observability-infra")
    )
  );
  const authority = preproduction["x-authoritative-runtime"] || {};
  const ingress = preproduction.services?.["athena-preproduction-ingress"] || {};
  const requiredAuthority = {
    ATHENA_RUNTIME_TOPOLOGY: "distributed",
    ATHENA_DATABASE_PROVIDER: "postgresql",
    ATHENA_SQLITE_RUNTIME_FALLBACK: "false",
    ATHENA_BROADCAST_TRANSPORT: "nats",
    ATHENA_MEMORY_TRANSPORT_FALLBACK: "false",
    ATHENA_CONTENT_STORE: "s3",
    ATHENA_SERVICE_MTLS_REQUIRED: "true",
    ATHENA_READER_WORKER_QUEUE: "true",
    ATHENA_READER_WORKER_FALLBACK_IN_PROCESS: "false",
    ATHENA_KEY_CUSTODY_CUTOVER: "true",
    ATHENA_PLUGIN_CAPABILITY_HYBRID_REQUIRED: "true",
    ATHENA_RAG_CUTOVER: "true",
  };
  for (const [name, expected] of Object.entries(requiredAuthority))
    if (String(authority[name] || "") !== expected)
      findings.push(`authoritative_path_invalid:${name}:${expected}`);
  if (String(authority.ATHENA_MODULE_SCHEMA_CUTOVER || "") !== "true")
    warnings.push("logical_schema_cutover_pending_expand_contract_migration");
  const sharedStorageCutover =
    String(authority.ATHENA_SHARED_STORAGE_CUTOVER || "") === "true";

  if (!String(ingress.image || "").startsWith("caddy:"))
    findings.push("preproduction_caddy_ingress_missing");
  if (!ingress.depends_on?.["anything-llm-web"])
    findings.push("preproduction_caddy_web_dependency_missing");
  if (!(ingress.volumes || []).some((mount) =>
    String(mount).includes("preproduction/Caddyfile:/etc/caddy/Caddyfile:ro")
  ))
    findings.push("preproduction_caddy_config_missing");
  for (const port of ["80:80", "443:443"]) {
    if (!(ingress.ports || []).some((mapping) => String(mapping).includes(port)))
      findings.push(`preproduction_caddy_port_missing:${port}`);
  }
  if (
    String(
      preproduction.services?.["anything-llm-edge-probe"]?.environment
        ?.ATHENA_EDGE_LOCAL_HEALTH_URL || ""
    ) !== "http://athena-preproduction-ingress:8080/health"
  )
    findings.push("edge_probe_does_not_traverse_caddy");

  for (const manifest of manifests) {
    const [serviceName, target] = RUNTIME_BINDINGS[manifest.id] || [];
    const baseService = base.services?.[serviceName] || {};
    const overlayService = preproduction.services?.[serviceName] || {};
    const service = { ...baseService, ...overlayService };
    const env = environment(overlayService);

    if (!Object.keys(service).length)
      findings.push(`compose_service_missing:${manifest.id}:${serviceName}`);
    if ((overlayService.build?.target || baseService.build?.target) !== target)
      findings.push(`compose_build_target_mismatch:${manifest.id}:${target}`);
    if (!new RegExp(`^FROM .+ AS ${target}$`, "m").test(dockerfile))
      findings.push(`docker_target_missing:${manifest.id}:${target}`);
    if (String(env.ATHENA_RUNTIME_ROLE || "") !== manifest.runtimeRole)
      findings.push(
        `runtime_role_mismatch:${manifest.id}:${manifest.runtimeRole}`
      );
    if (
      String(env.ATHENA_SERVICE_ID || "") !==
      manifest.security.serviceIdentity.replace(
        "{environment}",
        "preproduction"
      )
    )
      findings.push(`service_identity_mismatch:${manifest.id}`);
    if (!mtlsConfigured(manifest.id, env))
      findings.push(`service_mtls_missing:${manifest.id}`);
    if (!prometheusIds.has(manifest.id))
      findings.push(`prometheus_target_missing:${manifest.id}`);
    if (
      manifest.id !== "operations-plane" &&
      !String(endpoints[manifest.id] || "").startsWith("https://")
    )
      findings.push(`operations_readiness_endpoint_missing:${manifest.id}`);
    if (
      manifest.id !== "collector" &&
      !new RegExp(
        `^\\s*${manifest.runtimeRole.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)$`,
        "m"
      ).test(entrypoint)
    )
      findings.push(`entrypoint_role_missing:${manifest.id}`);

    const scrape = (prometheus.scrape_configs || []).find((job) =>
      (job.static_configs || []).some(
        (config) => config.labels?.module_id === manifest.id
      )
    );
    if (
      scrape?.scheme !== "https" ||
      scrape?.metrics_path !== "/metrics" ||
      !scrape?.authorization?.credentials_file ||
      !scrape?.tls_config?.ca_file ||
      !scrape?.tls_config?.cert_file ||
      !scrape?.tls_config?.key_file
    )
      findings.push(`prometheus_mtls_invalid:${manifest.id}`);
  }

  for (const moduleId of prometheusIds)
    if (!manifestIds.has(moduleId))
      findings.push(`prometheus_target_unknown:${moduleId}`);
  for (const moduleId of Object.keys(endpoints))
    if (!manifestIds.has(moduleId))
      findings.push(`operations_endpoint_unknown:${moduleId}`);

  const masterKeyConsumers = Object.entries(preproduction.services || {})
    .filter(([, service]) =>
      (service.volumes || []).some((volume) =>
        String(volume).includes("runtime-secrets/master-key")
      )
    )
    .map(([service]) => service);
  if (
    masterKeyConsumers.length !== 1 ||
    masterKeyConsumers[0] !== "anything-llm-key-custody"
  )
    findings.push(
      `master_key_mount_scope_invalid:${masterKeyConsumers.sort().join(",")}`
    );
  const cryptoAccount =
    preproduction.services?.["anything-llm-crypto-account"] || {};
  const toolBroker = preproduction.services?.["anything-llm-tool-broker"] || {};
  if (!cryptoAccount.depends_on?.["anything-llm-key-custody"])
    findings.push("crypto_account_key_custody_dependency_missing");
  if (!toolBroker.depends_on?.["anything-llm-crypto-account"])
    findings.push("tool_broker_crypto_account_dependency_missing");

  const runtimeServiceNames = new Set(
    Object.values(RUNTIME_BINDINGS).map(([serviceName]) => serviceName)
  );
  const sharedWritableVolumes = new Map();
  for (const [serviceName, service] of Object.entries(
    preproduction.services || {}
  )) {
    if (!runtimeServiceNames.has(serviceName)) continue;
    for (const mount of writableNamedVolumeMounts(service)) {
      const key = `${mount.source}:${mount.target}`;
      if (!sharedWritableVolumes.has(key)) sharedWritableVolumes.set(key, []);
      sharedWritableVolumes.get(key).push(serviceName);
    }
  }
  const sharedWritableStorageConsumers = [...sharedWritableVolumes.entries()]
    .filter(([, consumers]) => consumers.length > 1)
    .map(([mount, consumers]) => ({
      mount,
      consumers: consumers.sort(),
    }))
    .sort((left, right) => left.mount.localeCompare(right.mount));
  if (sharedWritableStorageConsumers.length) {
    const code = "shared_writable_storage_transport_pending";
    if (sharedStorageCutover) findings.push(code);
    else warnings.push(code);
  }

  const summary = {
    version: "athena.independent-module-topology:v1",
    manifests: manifests.length,
    physicalRuntimes:
      manifests.length -
      findings.filter((finding) =>
        /^(runtime_binding|compose_service|compose_build|docker_target|entrypoint_role)/.test(
          finding
        )
      ).length,
    prometheusTargets: prometheusIds.size,
    operationsReadinessEndpoints:
      Object.keys(endpoints).length +
      (manifestIds.has("operations-plane") ? 1 : 0),
    mtlsIdentities:
      manifests.length -
      findings.filter((finding) =>
        /^(service_identity|service_mtls)/.test(finding)
      ).length,
    ingress: {
      provider: String(ingress.image || "").split(":")[0] || null,
      publicHttps: (ingress.ports || []).some((mapping) =>
        String(mapping).includes("443:443")
      ),
      edgeProbeTraversesIngress:
        preproduction.services?.["anything-llm-edge-probe"]?.environment
          ?.ATHENA_EDGE_LOCAL_HEALTH_URL ===
        "http://athena-preproduction-ingress:8080/health",
    },
    authoritativePaths: {
      postgresql: authority.ATHENA_DATABASE_PROVIDER === "postgresql",
      nats: authority.ATHENA_BROADCAST_TRANSPORT === "nats",
      objectStore: authority.ATHENA_CONTENT_STORE === "s3",
      serviceMtls: authority.ATHENA_SERVICE_MTLS_REQUIRED === "true",
      remoteKeyCustody: authority.ATHENA_KEY_CUSTODY_CUTOVER === "true",
      hybridToolCapabilities:
        authority.ATHENA_PLUGIN_CAPABILITY_HYBRID_REQUIRED === "true",
      logicalSchemaCutover: authority.ATHENA_MODULE_SCHEMA_CUTOVER === "true",
      sharedStorageCutover,
    },
    dataIsolation: {
      sharedWritableStorageConsumers,
      independentRuntimeStorage:
        sharedWritableStorageConsumers.length === 0 && sharedStorageCutover,
    },
    cryptoChain: {
      masterKeyConsumers,
      cryptoAccountUsesRemoteCustody: Boolean(
        cryptoAccount.depends_on?.["anything-llm-key-custody"]
      ),
      toolBrokerUsesCryptoAccount: Boolean(
        toolBroker.depends_on?.["anything-llm-crypto-account"]
      ),
    },
    warnings,
    findings,
    ready: findings.length === 0,
    productionCutoverReady:
      findings.length === 0 &&
      warnings.length === 0 &&
      authority.ATHENA_MODULE_SCHEMA_CUTOVER === "true" &&
      sharedStorageCutover,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (findings.length) process.exitCode = 1;
}

main();
