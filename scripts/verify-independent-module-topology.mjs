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
  "coordination-plane": [
    "anything-llm-coordination-plane",
    "coordination-plane-build",
  ],
  "chat-runtime": ["anything-llm-chat-runtime", "chat-runtime-build"],
  "agent-runtime": ["anything-llm-agent-runtime", "agent-runtime-build"],
  "model-gateway": ["anything-llm-model-gateway", "model-gateway-build"],
  "responses-runtime": [
    "anything-llm-responses-runtime",
    "responses-runtime-build",
  ],
  "character-performance-runtime": [
    "anything-llm-character-performance-runtime",
    "character-performance-runtime-build",
  ],
  "external-mcp-gateway": [
    "anything-llm-external-mcp-gateway",
    "external-mcp-gateway-build",
  ],
  "local-runtime-center": [
    "anything-llm-local-runtime-center",
    "local-runtime-center-build",
  ],
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
  "browser-plane": ["anything-llm-browser-plane", "browser-plane-build"],
  "browser-worker": ["anything-llm-browser-worker", "browser-worker-build"],
  "browser-egress": ["anything-llm-browser-egress", "browser-egress-build"],
});

const RUNTIME_SOURCES = Object.freeze({
  "athena-api": "server/utils/modulePlatform/apiProbeHost.js",
  "edge-web": "server/edge-probe.js",
  "background-worker": "server/background-worker.js",
  "sync-v2": "server/realtime-gateway.js",
  "reader-worker": "server/reader-worker.js",
  scheduler: "server/scheduler.js",
  "operations-plane": "server/operations-plane.js",
  "coordination-plane": "server/coordination-plane.js",
  "chat-runtime": "server/chat-runtime.js",
  "agent-runtime": "server/agent-runtime.js",
  "model-gateway": "server/model-gateway.js",
  "responses-runtime": "server/responses-runtime.js",
  "character-performance-runtime": "server/character-performance-runtime.js",
  "external-mcp-gateway": "server/external-mcp-gateway.js",
  "local-runtime-center": "server/local-runtime-center.js",
  "tool-runtime": "server/tool-broker.js",
  "crypto-market": "server/crypto-market.js",
  "crypto-account-access": "server/crypto-account.js",
  "crypto-forecast": "server/crypto-forecast.js",
  "key-custody": "server/key-custody.js",
  collector: "collector/utils/moduleLifecycle.js",
  authentication: "server/identity.js",
  "knowledge-ingest": "server/knowledge-ingest.js",
  rag: "server/rag.js",
  "operations-shadow-agents": "server/operations-shadow-agents.js",
  "browser-plane": "server/browser-plane.js",
  "browser-worker": "server/browser-worker.js",
  "browser-egress": "server/browser-egress.js",
});

const STANDARD_LIFECYCLE_CAPABILITIES = Object.freeze([
  "module.describe",
  "module.self-test",
  "module.lifecycle.query",
  "module.drain",
  "module.quiesce",
  "module.resume",
]);

// RPC edges must not become Compose lifecycle edges. Otherwise pausing an
// optional module can block an unrelated caller from restarting or rolling
// back independently.
const FORBIDDEN_STARTUP_COUPLINGS = Object.freeze([
  ["anything-llm-api", "anything-llm-collector"],
  ["anything-llm-api", "anything-llm-identity"],
  ["anything-llm-api", "anything-llm-knowledge-ingest"],
  ["anything-llm-api", "anything-llm-rag"],
  ["anything-llm-api", "anything-llm-browser-plane"],
  ["anything-llm-api", "anything-llm-browser-worker"],
  ["anything-llm-api-tls", "anything-llm-api"],
  ["anything-llm-api-tls", "anything-llm-api-green"],
  ["anything-llm-web", "anything-llm-api-tls"],
  ["anything-llm-web", "anything-llm-chat-runtime"],
  ["anything-llm-web", "anything-llm-agent-runtime"],
  ["anything-llm-web", "anything-llm-realtime-gateway"],
  ["anything-llm-web", "anything-llm-browser-worker"],
  ["anything-llm-tool-broker", "anything-llm-crypto-account"],
  ["anything-llm-knowledge-ingest", "anything-llm-collector"],
  ["anything-llm-knowledge-ingest", "anything-llm-reader-worker"],
  ["anything-llm-knowledge-ingest", "anything-llm-rag"],
  ["anything-llm-operations-shadow-agents", "anything-llm-operations-plane"],
  ["anything-llm-browser-plane", "anything-llm-browser-worker"],
]);

function dependencies(service = {}) {
  const value = service.depends_on || {};
  return new Set(Array.isArray(value) ? value : Object.keys(value));
}

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
      const parts = mount.split(":");
      const maybeMode = parts.at(-1);
      if (["ro", "rw"].includes(maybeMode)) parts.pop();
      const target = parts.pop();
      const source = parts.join(":");
      return { source, target };
    })
    .filter(
      ({ source, target }) => source && target && !source.startsWith(".")
    );
}

function approvedDocumentPipelineHandoff({ mount, consumers }) {
  const approvedConsumers = [
    "anything-llm-collector",
    "anything-llm-knowledge-ingest",
  ];
  if (
    consumers.length !== approvedConsumers.length ||
    consumers.some((consumer, index) => consumer !== approvedConsumers[index])
  )
    return false;
  return [
    "/app/server/storage/production/documents",
    "/app/server/storage/production/direct-uploads",
  ].some((target) => mount.endsWith(`:${target}`));
}

function main() {
  const manifests = loadManifests();
  const manifestIds = new Set(manifests.map(({ id }) => id));
  const base = loadYaml("docker/docker-compose.modular.yml");
  const preproduction = loadYaml("docker/docker-compose.preproduction.yml");
  const production = JSON.parse(
    read("docker/docker-compose.production-micro.json")
  );
  const prometheus = loadYaml(
    "docker/observability/prometheus.preproduction.yaml"
  );
  const dockerfile = read("docker/Dockerfile");
  const browserWorkerRuntimeDockerfile = read(
    "docker/Dockerfile.browser-worker-runtime"
  );
  const entrypoint = read("docker/docker-entrypoint.sh");
  const apiMtlsProxy = read("docker/preproduction/api-mtls-proxy.conf");
  const apiRollout = read("scripts/production/roll-api-blue-green.sh");
  const backendRuntimeSourceBuild = read(
    "scripts/production/build-backend-runtime-source.sh"
  );
  const backendRuntimeSourceDockerfile = read(
    "docker/Dockerfile.backend-runtime-source"
  );
  const moduleRollout = read("scripts/production/roll-micro-module.sh");
  const hostProvisioner = read(
    "scripts/production/provision-micro-module-host.sh"
  );
  const databaseRoleInitializer = read("docker/postgresql/init-athena.sh");
  const databaseRoleProvisioner = read(
    "scripts/production/provision-module-database-roles.sh"
  );
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
  const ingress =
    preproduction.services?.["athena-preproduction-ingress"] || {};
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
  if (
    !(ingress.volumes || []).some((mount) =>
      String(mount).includes("preproduction/Caddyfile:/etc/caddy/Caddyfile:ro")
    )
  )
    findings.push("preproduction_caddy_config_missing");
  for (const port of ["80:80", "443:443"]) {
    if (
      !(ingress.ports || []).some((mapping) => String(mapping).includes(port))
    )
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
    const runtimeSourceFile = RUNTIME_SOURCES[manifest.id];
    const runtimeSource = runtimeSourceFile ? read(runtimeSourceFile) : "";

    if (!runtimeSourceFile)
      findings.push(`runtime_source_missing:${manifest.id}`);
    else if (
      manifest.id === "collector"
        ? !runtimeSource.includes("class CollectorModuleLifecycle")
        : !runtimeSource.includes("MicroModuleServiceHost")
    )
      findings.push(`lifecycle_runtime_adapter_missing:${manifest.id}`);
    for (const capability of STANDARD_LIFECYCLE_CAPABILITIES)
      if (!manifest.rpc.provides.includes(capability))
        findings.push(
          `lifecycle_capability_missing:${manifest.id}:${capability}`
        );

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
    if (
      !new RegExp(`\\s${manifest.runtimeRole}(?:\\s|$)`).test(hostProvisioner)
    )
      findings.push(`host_provision_role_missing:${manifest.id}`);
    if (!hostProvisioner.includes(`${manifest.runtimeRole}) printf`))
      findings.push(`host_provision_dns_missing:${manifest.id}`);
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
  const productionMasterKeyConsumers = Object.entries(production.services || {})
    .filter(([, service]) =>
      (service.volumes || []).some((volume) =>
        String(volume).includes("runtime-secrets/master-key")
      )
    )
    .map(([service]) => service);
  if (
    productionMasterKeyConsumers.length !== 1 ||
    productionMasterKeyConsumers[0] !== "anything-llm-key-custody"
  )
    findings.push(
      `production_master_key_mount_scope_invalid:${productionMasterKeyConsumers.sort().join(",")}`
    );
  for (const apiSlot of ["anything-llm-api", "anything-llm-api-green"])
    if (!apiMtlsProxy.includes(`server ${apiSlot}:3001 resolve`))
      findings.push(`api_zero_downtime_slot_missing:${apiSlot}`);
  if (!apiMtlsProxy.includes("proxy_next_upstream_tries 2"))
    findings.push("api_zero_downtime_failover_missing");
  if (
    !apiRollout.includes("proxy_switched=false") ||
    !apiRollout.includes('if [[ "$proxy_switched" != "true" ]]') ||
    !apiRollout.includes("rm -sf anything-llm-api-green")
  )
    findings.push("api_pre_switch_rollback_can_restart_active_blue_slot");
  for (const immutableInput of [
    "server/package.json",
    "server/yarn.lock",
    "server/prisma/schema.prisma",
    "server/prisma/postgresql/schema.prisma",
  ])
    if (!backendRuntimeSourceBuild.includes(immutableInput))
      findings.push(
        `runtime_source_dependency_guard_missing:${immutableInput}`
      );
  if (!backendRuntimeSourceBuild.includes("full_rebuild_required"))
    findings.push("runtime_source_dependency_change_not_fail_closed");
  if (
    !backendRuntimeSourceDockerfile.includes(
      "./docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh"
    ) ||
    !backendRuntimeSourceBuild.includes("runtime_source_entrypoint_mismatch")
  )
    findings.push("runtime_source_entrypoint_not_refreshed");
  for (const role of [
    "athena_main_observer",
    "athena_auth_observer",
    "athena_key_custody",
    "athena_crypto_forecast",
    "athena_browser_plane",
    "athena_browser_egress",
  ])
    if (!databaseRoleInitializer.includes(`ALTER ROLE ${role} PASSWORD`))
      findings.push(`database_role_password_reconciliation_missing:${role}`);
  if (
    !databaseRoleInitializer.includes(
      "SELECT format('ALTER ROLE %I PASSWORD %L', :'admin_user', :'admin_password')"
    )
  )
    findings.push("database_admin_password_reconciliation_missing");
  for (const secret of [
    "ATHENA_PROD_POSTGRES_ADMIN_PASSWORD",
    "ATHENA_PROD_POSTGRES_MAIN_PASSWORD",
    "ATHENA_PROD_POSTGRES_AUTH_PASSWORD",
  ])
    if (!databaseRoleProvisioner.includes(secret))
      findings.push(`database_role_provisioner_secret_missing:${secret}`);
  if (
    !String(
      preproduction["x-authoritative-runtime"]
        ?.ATHENA_KEY_CUSTODY_MAIN_DATABASE_URL || ""
    ).includes("athena_key_custody:")
  )
    findings.push("key_custody_dedicated_main_principal_missing");
  for (const table of [
    "security_key_registry",
    "security_key_domain_bindings",
    "security_key_rotation_jobs",
    "security_key_rotation_approvals",
    "security_key_events",
  ])
    if (!databaseRoleInitializer.includes(table))
      findings.push(`key_custody_legacy_table_acl_missing:${table}`);
  if (
    !databaseRoleProvisioner.includes("IFS= read -r POSTGRES_PASSWORD") ||
    !databaseRoleProvisioner.includes("exec sh -s")
  )
    findings.push("database_role_provisioner_stdin_reconciliation_missing");
  if (!dockerfile.includes(".bin/playwright-core install --with-deps chromium"))
    findings.push("browser_worker_standard_build_uses_invalid_playwright_cli");
  if (
    !browserWorkerRuntimeDockerfile.includes(
      ".bin/playwright-core install --with-deps chromium"
    ) ||
    !browserWorkerRuntimeDockerfile.includes("ATHENA_BACKEND_BASE_IMAGE")
  )
    findings.push("browser_worker_independent_runtime_build_invalid");
  for (const [environment, topology] of [
    ["modular", base],
    ["preproduction", preproduction],
    ["production", production],
  ]) {
    const worker = topology.services?.["anything-llm-browser-worker"] || {};
    const capabilities = new Set(worker.cap_add || []);
    const dropped = new Set(worker.cap_drop || []);
    const security = new Set(worker.security_opt || []);
    if (
      capabilities.size !== 1 ||
      !capabilities.has("SYS_CHROOT") ||
      !dropped.has("ALL") ||
      !security.has("no-new-privileges:true") ||
      ![...security].some((value) =>
        String(value).startsWith("seccomp=./playwright-seccomp-profile.json")
      )
    )
      findings.push(`browser_worker_sandbox_policy_invalid:${environment}`);
  }
  for (const apiSlot of ["anything-llm-api", "anything-llm-api-green"])
    if (!production.services?.[apiSlot])
      findings.push(`production_api_zero_downtime_slot_missing:${apiSlot}`);
  for (const [moduleId, [serviceName]] of Object.entries(RUNTIME_BINDINGS)) {
    const suffix = serviceName
      .replace(/^anything-llm-/, "")
      .replaceAll("-", "_")
      .toUpperCase();
    const expected = `\${ATHENA_PROD_${suffix}_IMAGE:?required}`;
    if (production.services?.[serviceName]?.image !== expected)
      findings.push(`production_module_image_not_independent:${moduleId}`);
    if (
      serviceName !== "anything-llm-api" &&
      !moduleRollout.includes(`${serviceName}) image_variable=`)
    )
      findings.push(`production_module_rollout_missing:${moduleId}`);
  }
  const cryptoAccount =
    preproduction.services?.["anything-llm-crypto-account"] || {};
  const toolBroker = preproduction.services?.["anything-llm-tool-broker"] || {};
  if (!cryptoAccount.depends_on?.["anything-llm-key-custody"])
    findings.push("crypto_account_key_custody_dependency_missing");
  const optionalStartupCouplings = [];
  for (const [caller, callee] of FORBIDDEN_STARTUP_COUPLINGS) {
    for (const [topology, compose] of [
      ["preproduction", preproduction],
      ["production", production],
    ]) {
      if (!dependencies(compose.services?.[caller]).has(callee)) continue;
      optionalStartupCouplings.push({ topology, caller, callee });
      findings.push(
        `optional_startup_coupling_detected:${topology}:${caller}:${callee}`
      );
    }
  }

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
  const productionRuntimeNames = new Set([
    ...runtimeServiceNames,
    "anything-llm-api-green",
  ]);
  const productionWritableVolumes = new Map();
  for (const [serviceName, service] of Object.entries(
    production.services || {}
  )) {
    if (!productionRuntimeNames.has(serviceName)) continue;
    for (const mount of writableNamedVolumeMounts(service)) {
      const key = `${mount.source}:${mount.target}`;
      if (!productionWritableVolumes.has(key))
        productionWritableVolumes.set(key, []);
      productionWritableVolumes.get(key).push(serviceName);
    }
  }
  const productionSharedWritableStorageConsumers = [
    ...productionWritableVolumes.entries(),
  ]
    .filter(([, consumers]) => consumers.length > 1)
    .map(([mount, consumers]) => ({ mount, consumers: consumers.sort() }));
  const unapprovedProductionSharedWritableStorageConsumers =
    productionSharedWritableStorageConsumers.filter(
      (entry) => !approvedDocumentPipelineHandoff(entry)
    );
  if (unapprovedProductionSharedWritableStorageConsumers.length)
    findings.push("production_shared_writable_storage_detected");

  if (
    !read("docker/nginx-web.conf.template").includes(
      "upload|upload-link|upload-and-embed|update-embeddings"
    )
  )
    findings.push("knowledge_ingest_upload_and_embed_route_missing");
  if (!read("server/knowledge-ingest.js").includes("upload-and-embed"))
    findings.push("knowledge_ingest_upload_and_embed_scope_missing");

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
      productionSharedWritableStorageConsumers,
      unapprovedProductionSharedWritableStorageConsumers,
      independentRuntimeStorage:
        sharedWritableStorageConsumers.length === 0 && sharedStorageCutover,
      optionalStartupCouplings,
    },
    cryptoChain: {
      masterKeyConsumers,
      productionMasterKeyConsumers,
      cryptoAccountUsesRemoteCustody: Boolean(
        cryptoAccount.depends_on?.["anything-llm-key-custody"]
      ),
      toolBrokerUsesCryptoAccount: Boolean(
        String(
          toolBroker.environment?.ATHENA_CRYPTO_ACCOUNT_URL || ""
        ).startsWith("https://anything-llm-crypto-account:")
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
