const fs = require("fs");
const path = require("path");
const { sha256, canonicalJson } = require("./canonical");

const MANIFEST_SCHEMA = "athena.module.manifest";
const MANIFEST_VERSION = "1.0";
const MANIFEST_VERSION_V11 = "1.1";
const SUPPORTED_MANIFEST_VERSIONS = new Set([
  MANIFEST_VERSION,
  MANIFEST_VERSION_V11,
]);
const DEFAULT_DIR = path.resolve(__dirname, "../../module-manifests");
const KINDS = new Set([
  "service",
  "worker",
  "gateway",
  "control-plane",
  "security-service",
  "diagnostic",
  "compatibility-service",
]);
const CRITICALITIES = new Set(["critical", "high", "medium", "low"]);
const FAILURE_MODES = new Set(["fail-closed", "isolated-degraded"]);
const CONTRACT_CALL_TYPES = new Set([
  "Call",
  "Task",
  "Event",
  "Stream",
  "Query",
  "Command",
]);
const CONTRACT_IDEMPOTENCY = new Set(["required", "supported", "none"]);
const DATA_CLASSIFICATIONS = new Set([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const COORDINATION_CENTERS = new Set([
  "task",
  "data",
  "cache",
  "recovery",
  "optimistic",
]);

function nonemptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function stringArray(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function validateContract(contract = {}, prefix, findings) {
  if (!/^[a-z0-9][a-z0-9_.:-]{1,159}$/.test(String(contract.id || "")))
    findings.push(`${prefix}_id_invalid`);
  if (!/^\d+\.\d+$/.test(String(contract.version || "")))
    findings.push(`${prefix}_version_invalid`);
  if (!CONTRACT_CALL_TYPES.has(contract.callType))
    findings.push(`${prefix}_call_type_invalid`);
  for (const field of ["requestSchema", "responseSchema"])
    if (!String(contract[field] || "")) findings.push(`${prefix}_${field}_missing`);
  if (!stringArray(contract.errorCodes))
    findings.push(`${prefix}_error_codes_invalid`);
  if (!Number.isInteger(contract.timeoutMs) || contract.timeoutMs < 1_000)
    findings.push(`${prefix}_timeout_invalid`);
  if (!CONTRACT_IDEMPOTENCY.has(contract.idempotency))
    findings.push(`${prefix}_idempotency_invalid`);
  if (!DATA_CLASSIFICATIONS.has(contract.dataClassification))
    findings.push(`${prefix}_classification_invalid`);
}

function validateV11Manifest(manifest, findings) {
  if (!String(manifest.domain || "")) findings.push("domain_missing");
  if (!nonemptyArray(manifest.responsibilities))
    findings.push("responsibilities_missing");
  if (!stringArray(manifest.nonResponsibilities))
    findings.push("non_responsibilities_invalid");

  if (!manifest.contracts || typeof manifest.contracts !== "object")
    findings.push("contracts_missing");
  else {
    for (const direction of ["provides", "consumes"]) {
      const contracts = manifest.contracts[direction];
      if (!Array.isArray(contracts)) {
        findings.push(`contracts_${direction}_invalid`);
        continue;
      }
      contracts.forEach((contract, index) =>
        validateContract(contract, `contracts_${direction}_${index}`, findings)
      );
      const ids = contracts.map((contract) => contract.id);
      if (new Set(ids).size !== ids.length)
        findings.push(`contracts_${direction}_duplicate`);
      const legacyIds = manifest.rpc?.[direction] || [];
      if (
        ids.length !== legacyIds.length ||
        ids.some((id) => !legacyIds.includes(id))
      )
        findings.push(`contracts_${direction}_rpc_mismatch`);
    }
  }

  const ownership = manifest.ownership;
  if (!ownership || typeof ownership !== "object")
    findings.push("ownership_missing");
  else {
    for (const field of [
      "dataSchemas",
      "objectPrefixes",
      "keyDomains",
      "configuration",
      "runtimeState",
    ])
      if (!stringArray(ownership[field]))
        findings.push(`ownership_${field}_invalid`);
  }

  const lifecycle = manifest.lifecycle;
  if (!lifecycle || typeof lifecycle !== "object")
    findings.push("lifecycle_missing");
  else {
    for (const field of ["states", "hooks", "commands"])
      if (!nonemptyArray(lifecycle[field]))
        findings.push(`lifecycle_${field}_invalid`);
    if (!Number.isInteger(lifecycle.heartbeatIntervalMs))
      findings.push("lifecycle_heartbeat_interval_invalid");
    if (!Number.isInteger(lifecycle.leaseTtlMs))
      findings.push("lifecycle_lease_ttl_invalid");
    if (lifecycle.leaseTtlMs < lifecycle.heartbeatIntervalMs * 2)
      findings.push("lifecycle_lease_ttl_too_short");
  }

  const coordination = manifest.coordination;
  if (!coordination || typeof coordination !== "object")
    findings.push("coordination_missing");
  else {
    if (
      !Array.isArray(coordination.centers) ||
      coordination.centers.some((center) => !COORDINATION_CENTERS.has(center))
    )
      findings.push("coordination_centers_invalid");
    if (!stringArray(coordination.acceptedCommands))
      findings.push("coordination_commands_invalid");
  }

  const reliability = manifest.reliability;
  if (!reliability || typeof reliability !== "object")
    findings.push("reliability_missing");
  else {
    if (!Number.isInteger(reliability.rtoMs) || reliability.rtoMs < 0)
      findings.push("reliability_rto_invalid");
    if (!Number.isInteger(reliability.rpoMs) || reliability.rpoMs < 0)
      findings.push("reliability_rpo_invalid");
    if (!stringArray(reliability.forbiddenDegradations))
      findings.push("reliability_forbidden_degradations_invalid");
  }
}

function validateManifest(manifest = {}, { env = process.env } = {}) {
  const findings = [];
  if (manifest.schema !== MANIFEST_SCHEMA) findings.push("schema_invalid");
  if (!SUPPORTED_MANIFEST_VERSIONS.has(manifest.schemaVersion))
    findings.push("schema_version_invalid");
  if (
    String(env.ATHENA_MODULE_MANIFEST_V11_REQUIRED || "false").toLowerCase() ===
      "true" &&
    manifest.schemaVersion !== MANIFEST_VERSION_V11
  )
    findings.push("schema_version_v11_required");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(String(manifest.id || "")))
    findings.push("id_invalid");
  if (!String(manifest.name || "")) findings.push("name_missing");
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(
      String(manifest.version || "")
    )
  )
    findings.push("version_invalid");
  if (!KINDS.has(manifest.kind)) findings.push("kind_invalid");
  if (!CRITICALITIES.has(manifest.criticality))
    findings.push("criticality_invalid");
  if (!String(manifest.owner || "")) findings.push("owner_missing");
  if (!String(manifest.runtimeRole || ""))
    findings.push("runtime_role_missing");
  if (!nonemptyArray(manifest.sourcePaths))
    findings.push("source_paths_missing");
  for (const field of ["capabilities", "dependsOn"])
    if (!stringArray(manifest[field])) findings.push(`${field}_invalid`);
  for (const section of [
    ["routes", ["public", "internal"]],
    ["rpc", ["provides", "consumes"]],
    ["events", ["publishes", "subscribes"]],
    ["data", ["schemas", "objectPrefixes"]],
  ]) {
    const [name, fields] = section;
    if (!manifest[name] || typeof manifest[name] !== "object") {
      findings.push(`${name}_missing`);
      continue;
    }
    for (const field of fields)
      if (!stringArray(manifest[name][field]))
        findings.push(`${name}_${field}_invalid`);
  }
  const security = manifest.security;
  if (!security || typeof security !== "object")
    findings.push("security_missing");
  else {
    if (
      !/^spiffe:\/\/athena\/\{environment\}\/[a-z0-9-]+$/.test(
        String(security.serviceIdentity || "")
      )
    )
      findings.push("service_identity_invalid");
    if (!stringArray(security.keyDomains)) findings.push("key_domains_invalid");
    if (!stringArray(security.allowedCallers))
      findings.push("allowed_callers_invalid");
    if (!FAILURE_MODES.has(security.failureMode))
      findings.push("failure_mode_invalid");
    if (
      !Number.isInteger(security.principalFreshnessMs) ||
      security.principalFreshnessMs < 1_000 ||
      security.principalFreshnessMs > 60_000
    )
      findings.push("principal_freshness_invalid");
  }
  const deployment = manifest.deployment;
  if (!deployment || typeof deployment !== "object")
    findings.push("deployment_missing");
  else {
    for (const field of ["image", "healthPath", "readinessPath", "drainPath"])
      if (!String(deployment[field] || ""))
        findings.push(`deployment_${field}_missing`);
    if (
      !Number.isFinite(deployment.availabilityTarget) ||
      deployment.availabilityTarget < 0.9 ||
      deployment.availabilityTarget > 1
    )
      findings.push("availability_target_invalid");
    if (
      !Number.isInteger(deployment.reconnectP95Ms) ||
      deployment.reconnectP95Ms < 0 ||
      deployment.reconnectP95Ms > 60_000
    )
      findings.push("reconnect_p95_invalid");
  }
  if (manifest.schemaVersion === MANIFEST_VERSION_V11)
    validateV11Manifest(manifest, findings);
  return { valid: findings.length === 0, findings };
}

const manifestCache = new Map();

function loadManifests({
  directory = DEFAULT_DIR,
  cache = process.env.NODE_ENV === "production",
  refresh = false,
} = {}) {
  const cacheKey = path.resolve(directory);
  if (cache && !refresh && manifestCache.has(cacheKey))
    return manifestCache.get(cacheKey);
  const files = fs
    .readdirSync(directory)
    .filter((file) => !file.startsWith(".") && file.endsWith(".json"))
    .sort();
  const manifests = files.map((file) => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, file), "utf8")
    );
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      const error = new Error(`module_manifest_invalid:${file}`);
      error.code = "MODULE_MANIFEST_INVALID";
      error.findings = validation.findings;
      throw error;
    }
    return Object.freeze({
      ...manifest,
      manifestFile: file,
      fingerprint: sha256(canonicalJson(manifest)),
    });
  });
  const byId = new Map();
  for (const manifest of manifests) {
    if (byId.has(manifest.id))
      throw new Error(`module_manifest_duplicate:${manifest.id}`);
    byId.set(manifest.id, manifest);
  }
  for (const manifest of manifests)
    for (const dependency of manifest.dependsOn)
      if (!byId.has(dependency) && !dependency.startsWith("infra:"))
        throw new Error(
          `module_manifest_dependency_unknown:${manifest.id}:${dependency}`
        );
  const result = Object.freeze(manifests);
  if (cache) manifestCache.set(cacheKey, result);
  return result;
}

function moduleManifest(id, options = {}) {
  return (
    loadManifests(options).find((manifest) => manifest.id === String(id)) ||
    null
  );
}

function manifestSnapshot(options = {}) {
  return loadManifests(options).map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    runtimeRole: manifest.runtimeRole,
    criticality: manifest.criticality,
    capabilities: [...manifest.capabilities],
    dependsOn: [...manifest.dependsOn],
    deployment: { ...manifest.deployment },
    fingerprint: manifest.fingerprint,
  }));
}

module.exports = {
  DEFAULT_DIR,
  MANIFEST_SCHEMA,
  MANIFEST_VERSION,
  MANIFEST_VERSION_V11,
  SUPPORTED_MANIFEST_VERSIONS,
  loadManifests,
  manifestSnapshot,
  moduleManifest,
  validateManifest,
};
