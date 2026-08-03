const { validateManifest } = require("../manifestRegistry");
const { buildDeclaredLinks } = require("./links");

const RUNTIME_FIELDS = Object.freeze([
  "status",
  "ready",
  "startedAt",
  "inflight",
  "lastError",
  "lastReconciledAt",
  "lastCheckedAt",
]);

function safeRuntimeSnapshot(runtime = {}) {
  const snapshot = {};
  for (const field of RUNTIME_FIELDS) {
    if (runtime[field] === undefined) continue;
    if (field === "lastError") {
      const candidate = String(runtime[field] || "").slice(0, 160);
      snapshot.lastErrorCode = /^[A-Za-z0-9_.:-]+$/.test(candidate)
        ? candidate
        : "runtime_error_redacted";
      continue;
    }
    snapshot[field] = runtime[field];
  }
  if (runtime.counters && typeof runtime.counters === "object") {
    snapshot.counters = Object.fromEntries(
      Object.entries(runtime.counters)
        .filter(([, value]) => Number.isFinite(value))
        .slice(0, 50)
    );
  }
  return snapshot;
}

function ruleSummary(manifest, runtime = {}) {
  if (
    runtime.ready === false ||
    ["failed", "not-ready"].includes(runtime.status)
  )
    return `${manifest.name} is not ready; ${manifest.security.failureMode} policy remains authoritative.`;
  if (["degraded", "draining"].includes(runtime.status))
    return `${manifest.name} is ${runtime.status}; new work must follow its declared drain and failure policy.`;
  if (runtime.ready === true || runtime.status === "running")
    return `${manifest.name} is ready and exposes ${manifest.capabilities.length} declared capabilities.`;
  return `${manifest.name} is registered; live readiness has not been supplied to the descriptor.`;
}

function moduleDescription(
  manifest,
  { runtime = {}, linkObservations = [], allManifests = [manifest] } = {}
) {
  const links = buildDeclaredLinks({ manifests: allManifests }).filter(
    (link) => link.from === manifest.id || link.to === manifest.id
  );
  const observedById = new Map(
    linkObservations.map((observation) => [observation.linkId, observation])
  );
  const runtimeSnapshot = safeRuntimeSnapshot(runtime);
  const description = {
    schema: "athena.aicp.module-describe",
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    module: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      owner: manifest.owner,
      runtimeRole: manifest.runtimeRole,
      criticality: manifest.criticality,
      manifestFingerprint: manifest.fingerprint,
      sourcePaths: [...manifest.sourcePaths],
    },
    capabilities: {
      declared: [...manifest.capabilities],
      callTypes: ["Describe", "SelfTest", "Query"],
      rpc: {
        provides: [...manifest.rpc.provides],
        consumes: [...manifest.rpc.consumes],
      },
      events: {
        publishes: [...manifest.events.publishes],
        subscribes: [...manifest.events.subscribes],
      },
    },
    boundaries: {
      publicRoutes: [...manifest.routes.public],
      internalRoutes: [...manifest.routes.internal],
      dataSchemas: [...manifest.data.schemas],
      objectPrefixes: [...manifest.data.objectPrefixes],
      keyDomains: [...manifest.security.keyDomains],
      allowedCallers: [...manifest.security.allowedCallers],
      failureMode: manifest.security.failureMode,
      principalFreshnessMs: manifest.security.principalFreshnessMs,
    },
    lifecycle: {
      healthPath: manifest.deployment.healthPath,
      readinessPath: manifest.deployment.readinessPath,
      drainPath: manifest.deployment.drainPath,
      availabilityTarget: manifest.deployment.availabilityTarget,
      reconnectP95Ms: manifest.deployment.reconnectP95Ms,
    },
    operations: {
      maximumDefaultLevel: "L2",
      controlRequiresOperationsAction: true,
      controlExposedByAicpPhase0: false,
      summary: ruleSummary(manifest, runtimeSnapshot),
    },
    runtime: runtimeSnapshot,
    links: {
      declared: links.length,
      observed: links.filter((link) => observedById.has(link.id)).length,
      unresolved: links.filter((link) =>
        String(link.to).startsWith("unresolved:")
      ).length,
    },
  };
  const validation = validateModuleDescription(description);
  if (!validation.valid) {
    const error = new Error("aicp_module_description_invalid");
    error.code = "AICP_MODULE_DESCRIPTION_INVALID";
    error.findings = validation.findings;
    throw error;
  }
  return description;
}

function validateModuleDescription(value = {}) {
  const findings = [];
  if (value.schema !== "athena.aicp.module-describe")
    findings.push("schema_invalid");
  if (value.schemaVersion !== "1.0") findings.push("schema_version_invalid");
  if (!Number.isFinite(Date.parse(value.generatedAt)))
    findings.push("generated_at_invalid");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(String(value.module?.id || "")))
    findings.push("module_id_invalid");
  if (!Array.isArray(value.capabilities?.declared))
    findings.push("capabilities_invalid");
  if (!String(value.operations?.summary || ""))
    findings.push("operations_summary_missing");
  if (value.operations?.controlExposedByAicpPhase0 !== false)
    findings.push("phase0_control_exposure_invalid");
  for (const field of ["declared", "observed", "unresolved"])
    if (!Number.isInteger(value.links?.[field]) || value.links[field] < 0)
      findings.push(`links_${field}_invalid`);
  return { valid: findings.length === 0, findings };
}

function moduleSelfTest(manifest, { runtime = {} } = {}) {
  const manifestValidation = validateManifest(manifest);
  const checks = [
    {
      id: "manifest-contract",
      status: manifestValidation.valid ? "passed" : "failed",
      findings: manifestValidation.findings,
    },
    {
      id: "runtime-readiness",
      status:
        runtime.ready === false ||
        ["failed", "not-ready"].includes(runtime.status)
          ? "failed"
          : runtime.ready === true || runtime.status === "running"
            ? "passed"
            : "not-observed",
      findings: [],
    },
    {
      id: "security-boundary",
      status:
        manifest.security.allowedCallers.length > 0 &&
        manifest.security.principalFreshnessMs <= 60_000
          ? "passed"
          : "failed",
      findings: [],
    },
  ];
  return {
    schema: "athena.aicp.self-test",
    schemaVersion: "1.0",
    moduleId: manifest.id,
    generatedAt: new Date().toISOString(),
    status: checks.some((check) => check.status === "failed")
      ? "failed"
      : checks.some((check) => check.status === "not-observed")
        ? "partial"
        : "passed",
    checks,
    sideEffects: false,
  };
}

module.exports = {
  moduleDescription,
  moduleSelfTest,
  ruleSummary,
  safeRuntimeSnapshot,
  validateModuleDescription,
};
