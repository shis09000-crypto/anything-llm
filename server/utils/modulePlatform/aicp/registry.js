const { loadManifests } = require("../manifestRegistry");
const { validateAicpEnvelope } = require("./envelope");
const { moduleDescription, moduleSelfTest } = require("./describe");
const { buildRuntimeTopology } = require("./links");
const { aicpShadowObserver } = require("./shadowObserver");
const { AicpContractRegistry } = require("./contractRegistry");

const AICP_CAPABILITIES = Object.freeze({
  "module.describe": {
    callType: "Describe",
    requiredScope: "module:describe",
    readOnly: true,
  },
  "module.self-test": {
    callType: "SelfTest",
    requiredScope: "module:self-test",
    readOnly: true,
  },
  "topology.query": {
    callType: "Query",
    requiredScope: "topology:read",
    readOnly: true,
  },
  "module.lifecycle.query": {
    callType: "Query",
    requiredScope: "module:lifecycle:read",
    readOnly: true,
  },
  "link.negotiate": {
    callType: "Query",
    requiredScope: "link:negotiate",
    readOnly: true,
  },
  "link.status": {
    callType: "Query",
    requiredScope: "link:read",
    readOnly: true,
  },
});

function registryError(message, code, httpStatus = 400) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

class AicpCapabilityRegistry {
  constructor({
    manifests = loadManifests,
    observer = aicpShadowObserver,
  } = {}) {
    this.load = manifests;
    this.observer = observer;
    this.providers = new Map();
  }

  manifests() {
    return this.load();
  }

  manifest(moduleId) {
    return (
      this.manifests().find((manifest) => manifest.id === String(moduleId)) ||
      null
    );
  }

  registerRuntimeProvider(moduleId, provider = {}) {
    if (!this.manifest(moduleId))
      throw registryError(
        `aicp_module_unknown:${moduleId}`,
        "AICP_MODULE_UNKNOWN"
      );
    if (
      provider.runtime !== undefined &&
      typeof provider.runtime !== "function"
    )
      throw registryError(
        "aicp_runtime_provider_invalid",
        "AICP_RUNTIME_PROVIDER_INVALID"
      );
    if (
      provider.selfTest !== undefined &&
      typeof provider.selfTest !== "function"
    )
      throw registryError(
        "aicp_self_test_provider_invalid",
        "AICP_SELF_TEST_PROVIDER_INVALID"
      );
    this.providers.set(String(moduleId), {
      runtime: provider.runtime || null,
      selfTest: provider.selfTest || null,
    });
    return () => this.providers.delete(String(moduleId));
  }

  async runtime(moduleId) {
    const provider = this.providers.get(String(moduleId));
    if (!provider?.runtime) return {};
    const snapshot = await provider.runtime();
    return snapshot && typeof snapshot === "object" ? snapshot : {};
  }

  catalog() {
    return {
      schema: "athena.aicp.capability-catalog",
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      protocol: {
        name: "Athena Internal Capability Protocol",
        version: "1.0",
        phase: "production-contracts-shadow-enforcement",
      },
      capabilities: Object.entries(AICP_CAPABILITIES).map(
        ([id, definition]) => ({ id, ...definition })
      ),
      modules: this.manifests().map((manifest) => ({
        id: manifest.id,
        version: manifest.version,
        kind: manifest.kind,
        owner: manifest.owner,
        manifestFingerprint: manifest.fingerprint,
        runtimeProviderRegistered: this.providers.has(manifest.id),
      })),
    };
  }

  async describe(moduleId, options = {}) {
    const manifest = this.manifest(moduleId);
    if (!manifest)
      throw registryError(
        `aicp_module_unknown:${moduleId}`,
        "AICP_MODULE_UNKNOWN",
        404
      );
    const runtime = options.runtime || (await this.runtime(moduleId));
    return moduleDescription(manifest, {
      runtime,
      linkObservations:
        options.linkObservations || this.observer?.observations() || [],
      allManifests: this.manifests(),
    });
  }

  async selfTest(moduleId, options = {}) {
    const manifest = this.manifest(moduleId);
    if (!manifest)
      throw registryError(
        `aicp_module_unknown:${moduleId}`,
        "AICP_MODULE_UNKNOWN",
        404
      );
    const runtime = options.runtime || (await this.runtime(moduleId));
    const contract = moduleSelfTest(manifest, { runtime });
    const provider = this.providers.get(String(moduleId));
    if (!provider?.selfTest) return contract;
    const implementation = await provider.selfTest({ runtime, manifest });
    return {
      ...contract,
      status:
        contract.status === "failed" || implementation?.status === "failed"
          ? "failed"
          : implementation?.status || contract.status,
      checks: [
        ...contract.checks,
        {
          id: "module-implementation",
          status: implementation?.status || "not-observed",
          findings: Array.isArray(implementation?.findings)
            ? implementation.findings.slice(0, 50)
            : [],
        },
      ],
    };
  }

  topology(options = {}) {
    return buildRuntimeTopology({
      manifests: this.manifests(),
      observations: options.observations || this.observer?.observations() || [],
      runtimeLinks:
        options.runtimeLinks || this.observer?.runtimeLinkSnapshot() || [],
    });
  }

  async dispatch(
    envelope,
    { principalVerified = false, authorizedScopes = [] } = {}
  ) {
    const validation = validateAicpEnvelope(envelope);
    if (!validation.valid) {
      const error = registryError(
        "aicp_envelope_invalid",
        "AICP_ENVELOPE_INVALID"
      );
      error.findings = validation.findings;
      throw error;
    }
    if (principalVerified !== true)
      throw registryError(
        "aicp_principal_unverified",
        "AICP_PRINCIPAL_UNVERIFIED",
        401
      );
    const definition = AICP_CAPABILITIES[envelope.capability];
    if (!definition)
      throw registryError(
        "aicp_capability_not_exposed",
        "AICP_CAPABILITY_NOT_EXPOSED",
        404
      );
    if (definition.callType !== envelope.callType)
      throw registryError("aicp_call_type_mismatch", "AICP_CALL_TYPE_MISMATCH");
    if (
      !envelope.auth.scopes.includes(definition.requiredScope) ||
      !authorizedScopes.includes(definition.requiredScope)
    )
      throw registryError("aicp_scope_denied", "AICP_SCOPE_DENIED", 403);
    if (envelope.capability === "module.describe")
      return this.describe(envelope.target);
    if (envelope.capability === "module.self-test")
      return this.selfTest(envelope.target);
    if (envelope.capability === "topology.query") return this.topology();
    if (envelope.capability === "module.lifecycle.query")
      return this.runtime(envelope.target);
    if (envelope.capability === "link.negotiate")
      return new AicpContractRegistry().negotiate({
        callerModule: envelope.payload?.callerModule || envelope.producer,
        targetModule: envelope.payload?.targetModule || envelope.target,
        capability: envelope.payload?.capability,
        version: envelope.payload?.version || null,
        callType: envelope.payload?.callType || null,
      });
    if (envelope.capability === "link.status") {
      const linkId = String(envelope.payload?.linkId || "");
      const link = this.topology().links.find((entry) => entry.id === linkId);
      if (!link)
        throw registryError("aicp_link_unknown", "AICP_LINK_UNKNOWN", 404);
      return link;
    }
    throw registryError(
      "aicp_capability_not_implemented",
      "AICP_CAPABILITY_NOT_IMPLEMENTED",
      501
    );
  }
}

module.exports = {
  AICP_CAPABILITIES,
  AicpCapabilityRegistry,
  PHASE0_CAPABILITIES: AICP_CAPABILITIES,
};
