const { canonicalJson, sha256 } = require("../canonical");
const { loadManifests } = require("../manifestRegistry");
const { stableLinkId } = require("./links");
const schemaCatalog = require("../../../aicp-schemas/catalog.json");

const CENTER_SET = new Set(["task", "data", "cache", "recovery", "optimistic"]);
const PRIORITY_SET = new Set(["P0", "P1", "P2", "P3", "P4"]);
const ENFORCEMENT_MODES = new Set(["off", "observe", "enforce"]);

function aicpContractError(code, httpStatus = 409, details = {}) {
  const error = new Error(code);
  error.code = code.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  error.httpStatus = httpStatus;
  error.details = details;
  return error;
}

function aicpEnforcementMode(env = process.env) {
  const value = String(env.ATHENA_AICP_ENFORCEMENT_MODE || "observe")
    .trim()
    .toLowerCase();
  return ENFORCEMENT_MODES.has(value) ? value : "observe";
}

function aicpLinkEnforcementMode({
  callerModule,
  targetModule,
  capability,
  env = process.env,
  manifests = loadManifests,
} = {}) {
  const globalMode = aicpEnforcementMode(env);
  if (globalMode !== "observe") return globalMode;
  const target = manifests().find(
    (manifest) =>
      manifest.id === String(targetModule) ||
      manifest.runtimeRole === String(targetModule)
  );
  const policy = target?.coordination?.aicpPolicy;
  if (!policy) return globalMode;
  const rule = (policy.links || []).find(
    (entry) =>
      ["*", String(callerModule)].includes(String(entry.caller)) &&
      ["*", String(capability)].includes(String(entry.capability))
  );
  return rule?.mode || policy.defaultMode || globalMode;
}

function major(version) {
  return String(version || "").split(".")[0];
}

function compatibleVersion(requested, provided, protocolVersion = "1.0") {
  if (String(protocolVersion) === "1.1")
    return String(requested || "") === String(provided || "");
  return major(requested) === major(provided);
}

function schemaFingerprint(uri) {
  const schema = schemaCatalog.schemas?.[String(uri)];
  return schema ? sha256(canonicalJson(schema)) : null;
}

function legacyCallType(capability) {
  const value = String(capability || "");
  if (/stream|subscribe|replay/.test(value)) return "Stream";
  if (/publish|heartbeat|event/.test(value)) return "Event";
  if (
    /(?:^|\.)(?:read|get|status|validate|introspect|assert|describe|query)$/.test(
      value
    ) ||
    /self-test/.test(value)
  )
    return "Query";
  if (/wrap|unwrap|submit|dispatch/.test(value)) return "Call";
  return "Command";
}

function legacyContract(capability) {
  const id = String(capability);
  return {
    id,
    version: "1.0",
    callType: legacyCallType(id),
    requestSchema: `athena://contracts/legacy/${id}/request/1.0`,
    responseSchema: `athena://contracts/legacy/${id}/response/1.0`,
    errorCodes: [
      "contract_invalid",
      "deadline_exceeded",
      "caller_denied",
      "dependency_unavailable",
    ],
    timeoutMs: 10_000,
    idempotency: "supported",
    dataClassification: "confidential",
  };
}

function manifestContracts(manifest, direction) {
  const declared = manifest?.contracts?.[direction];
  if (Array.isArray(declared)) return declared;
  return (manifest?.rpc?.[direction] || []).map(legacyContract);
}

function validateCoordinationContext(value = {}, { required = false } = {}) {
  if (!value || typeof value !== "object")
    return { valid: !required, findings: required ? ["context_missing"] : [] };
  const findings = [];
  for (const field of [
    "coordinationRunId",
    "stepId",
    "correlationId",
    "deadlineAt",
  ])
    if (!String(value[field] || "")) findings.push(`${field}_missing`);
  if (!CENTER_SET.has(value.center)) findings.push("center_invalid");
  if (!PRIORITY_SET.has(value.priority)) findings.push("priority_invalid");
  if (!Number.isFinite(Date.parse(value.deadlineAt)))
    findings.push("deadline_invalid");
  else if (Date.parse(value.deadlineAt) <= Date.now())
    findings.push("deadline_expired");
  if (
    value.causationId !== null &&
    value.causationId !== undefined &&
    !String(value.causationId)
  )
    findings.push("causation_id_invalid");
  return { valid: findings.length === 0, findings };
}

class AicpContractRegistry {
  constructor({ manifests = loadManifests } = {}) {
    this.manifests = manifests();
    this.byId = new Map(
      this.manifests.map((manifest) => [manifest.id, manifest])
    );
    this.byRole = new Map(
      this.manifests.map((manifest) => [manifest.runtimeRole, manifest])
    );
    this.providers = new Map();
    for (const manifest of this.manifests) {
      for (const contract of manifestContracts(manifest, "provides")) {
        const providers = this.providers.get(contract.id) || [];
        this.providers.set(contract.id, [...providers, { manifest, contract }]);
      }
    }
  }

  module(value) {
    return (
      this.byId.get(String(value)) || this.byRole.get(String(value)) || null
    );
  }

  provider(capability, targetModule = null) {
    const providers = this.providers.get(String(capability)) || [];
    if (targetModule)
      return (
        providers.find(({ manifest }) =>
          [manifest.id, manifest.runtimeRole].includes(String(targetModule))
        ) || null
      );
    return providers.length === 1 ? providers[0] : null;
  }

  consumer(moduleId, capability) {
    return (
      manifestContracts(this.module(moduleId), "consumes").find(
        (contract) => contract.id === String(capability)
      ) || null
    );
  }

  negotiate({
    callerModule,
    targetModule,
    capability,
    version = null,
    callType = null,
    protocolVersion = "1.0",
  } = {}) {
    const caller = this.module(callerModule);
    const target = this.module(targetModule);
    if (!caller)
      throw aicpContractError("aicp_caller_module_unknown", 401, {
        callerModule,
      });
    if (!target)
      throw aicpContractError("aicp_target_module_unknown", 404, {
        targetModule,
      });
    const provided = manifestContracts(target, "provides").find(
      (contract) => contract.id === String(capability)
    );
    const consumed = this.consumer(caller.id, capability);
    if (!provided)
      throw aicpContractError("aicp_provider_contract_missing", 404, {
        targetModule: target.id,
        capability,
      });
    if (!consumed)
      throw aicpContractError("aicp_consumer_contract_missing", 403, {
        callerModule: caller.id,
        capability,
      });
    if (!target.security.allowedCallers.includes(caller.id))
      throw aicpContractError("aicp_caller_not_allowed", 403, {
        callerModule: caller.id,
        targetModule: target.id,
      });
    if (!compatibleVersion(consumed.version, provided.version, protocolVersion))
      throw aicpContractError("aicp_contract_version_incompatible", 409);
    if (version && !compatibleVersion(version, provided.version, protocolVersion))
      throw aicpContractError("aicp_requested_version_incompatible", 409);
    if (callType && provided.callType !== callType)
      throw aicpContractError("aicp_call_type_incompatible", 409);
    const identity = {
      type: "rpc",
      from: caller.id,
      to: target.id,
      capability: provided.id,
      transport: "mtls-https",
    };
    const fingerprintInput = {
      provided,
      consumed,
      caller: caller.id,
      target: target.id,
      ...(String(protocolVersion) === "1.1"
        ? { protocolVersion, schemaCatalogDigest: schemaCatalog.digest }
        : {}),
    };
    const contractFingerprint = sha256(canonicalJson(fingerprintInput));
    const requestSchemaFingerprint = schemaFingerprint(provided.requestSchema);
    const responseSchemaFingerprint = schemaFingerprint(provided.responseSchema);
    if (
      String(protocolVersion) === "1.1" &&
      (!requestSchemaFingerprint || !responseSchemaFingerprint)
    )
      throw aicpContractError("aicp_contract_schema_missing", 409, {
        capability: provided.id,
      });
    return {
      schema: "athena.aicp.link-negotiation",
      schemaVersion: String(protocolVersion),
      linkId: stableLinkId(identity),
      state: "negotiated",
      callerModule: caller.id,
      targetModule: target.id,
      capability: provided.id,
      version: provided.version,
      callType: provided.callType,
      timeoutMs: Math.min(provided.timeoutMs, consumed.timeoutMs),
      idempotency: provided.idempotency,
      dataClassification: provided.dataClassification,
      requestSchema: provided.requestSchema,
      responseSchema: provided.responseSchema,
      requestSchemaFingerprint,
      responseSchemaFingerprint,
      schemaCatalogDigest: schemaCatalog.digest,
      contractFingerprint,
    };
  }

  catalog() {
    return {
      schema: "athena.aicp.contract-catalog",
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      modules: this.manifests.length,
      schemaCatalogDigest: schemaCatalog.digest,
      contracts: [...this.providers.values()].flatMap((providers) =>
        providers.map(({ manifest, contract }) => ({
          ...contract,
          moduleId: manifest.id,
          fingerprint: sha256(canonicalJson(contract)),
        }))
      ),
    };
  }
}

function encodeAicpHeader(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeAicpHeader(value) {
  try {
    return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch {
    throw aicpContractError("aicp_header_invalid", 400);
  }
}

module.exports = {
  AicpContractRegistry,
  aicpContractError,
  aicpEnforcementMode,
  aicpLinkEnforcementMode,
  decodeAicpHeader,
  encodeAicpHeader,
  compatibleVersion,
  schemaFingerprint,
  validateCoordinationContext,
};
