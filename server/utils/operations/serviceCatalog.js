const { loadManifests } = require("../modulePlatform/manifestRegistry");

const INFRA_DEPENDENCY_MAP = Object.freeze({
  "infra:postgresql": "main-database",
  "infra:vector-database": "vector-database",
  "infra:nats": "nats-jetstream",
  "infra:clickhouse": "clickhouse",
  "infra:otel": "otel-collector",
  "infra:object-store": "object-storage",
  "infra:model-provider": "model-provider",
  "infra:embedding-provider": "embedding-provider",
});

const INFRASTRUCTURE = Object.freeze([
  {
    id: "main-database",
    name: "Primary Database",
    kind: "data-store",
    owner: "platform",
    criticality: "critical",
    capabilities: ["business-authority", "transactions", "service-schemas"],
    dependsOn: [],
  },
  {
    id: "object-storage",
    name: "Content Object Store",
    kind: "data-store",
    owner: "platform",
    criticality: "high",
    capabilities: ["immutable-objects", "checksums", "multipart"],
    dependsOn: [],
  },
  {
    id: "vector-database",
    name: "Vector Database",
    kind: "data-store",
    owner: "knowledge",
    criticality: "high",
    capabilities: ["vector-search"],
    dependsOn: [],
  },
  {
    id: "nats-jetstream",
    name: "NATS JetStream",
    kind: "transport",
    owner: "platform",
    criticality: "critical",
    capabilities: ["durable-events", "fanout", "replay"],
    dependsOn: [],
  },
  {
    id: "clickhouse",
    name: "ClickHouse Operations Store",
    kind: "data-store",
    owner: "sre",
    criticality: "high",
    capabilities: ["timeline", "analytics"],
    dependsOn: [],
  },
  {
    id: "otel-collector",
    name: "OpenTelemetry Collector",
    kind: "telemetry",
    owner: "sre",
    criticality: "high",
    capabilities: ["traces", "metrics", "logs"],
    dependsOn: [],
  },
  {
    id: "model-provider",
    name: "Model Provider",
    kind: "external-service",
    owner: "ai-platform",
    criticality: "critical",
    capabilities: ["chat-completion", "streaming"],
    dependsOn: [],
  },
  {
    id: "embedding-provider",
    name: "Embedding Provider",
    kind: "external-service",
    owner: "knowledge",
    criticality: "high",
    capabilities: ["embedding"],
    dependsOn: [],
  },
  {
    id: "post-quantum-security",
    name: "Post-Quantum Security Controls",
    kind: "security-control",
    owner: "security",
    criticality: "critical",
    capabilities: [
      "runtime-provider-validation",
      "hybrid-signature-validation",
      "hybrid-kem-validation",
      "downgrade-detection",
      "bounded-resilience-testing",
    ],
    dependsOn: ["key-custody", "operations-plane", "otel-collector"],
  },
]);

function dependencyId(value) {
  return INFRA_DEPENDENCY_MAP[value] || value;
}

function serviceFromManifest(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    kind: manifest.kind,
    owner: manifest.owner,
    criticality: manifest.criticality,
    capabilities: [...manifest.capabilities],
    dependsOn: manifest.dependsOn.map(dependencyId),
    manifest: {
      schemaVersion: manifest.schemaVersion,
      version: manifest.version,
      runtimeRole: manifest.runtimeRole,
      fingerprint: manifest.fingerprint,
      healthPath: manifest.deployment.healthPath,
      readinessPath: manifest.deployment.readinessPath,
      drainPath: manifest.deployment.drainPath,
      failureMode: manifest.security.failureMode,
      serviceIdentity: manifest.security.serviceIdentity,
    },
  };
}

function serviceCatalog() {
  const modules = loadManifests().map(serviceFromManifest);
  return [...modules, ...INFRASTRUCTURE].map((service) => ({
    ...service,
    capabilities: [...service.capabilities],
    dependsOn: [...service.dependsOn],
    manifest: service.manifest ? { ...service.manifest } : undefined,
  }));
}

function serviceById(id) {
  const service = serviceCatalog().find((entry) => entry.id === id);
  return service || null;
}

module.exports = {
  INFRA_DEPENDENCY_MAP,
  serviceById,
  serviceCatalog,
  serviceFromManifest,
};
