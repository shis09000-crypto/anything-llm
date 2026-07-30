const fs = require("fs");
const path = require("path");
const { sha256, canonicalJson } = require("./canonical");

const MANIFEST_SCHEMA = "athena.module.manifest";
const MANIFEST_VERSION = "1.0";
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

function nonemptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function stringArray(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function validateManifest(manifest = {}) {
  const findings = [];
  if (manifest.schema !== MANIFEST_SCHEMA) findings.push("schema_invalid");
  if (manifest.schemaVersion !== MANIFEST_VERSION)
    findings.push("schema_version_invalid");
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
  return { valid: findings.length === 0, findings };
}

function loadManifests({ directory = DEFAULT_DIR } = {}) {
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
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
  return manifests;
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
  loadManifests,
  manifestSnapshot,
  moduleManifest,
  validateManifest,
};
