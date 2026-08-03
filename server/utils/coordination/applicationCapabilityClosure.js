const crypto = require("crypto");
const { distributedTopology } = require("../microModules/serviceHost");
const {
  probeIdentityCapabilities,
} = require("../authz/identityOperationsClient");
const {
  unwrapMaterial,
  wrapMaterial,
} = require("../security/keyCustody/remoteClient");
const { emitSemanticEvent } = require("../observability/semanticEvents");

const APPLICATION_IDENTITY_CAPABILITIES = Object.freeze([
  "identity.session.validate",
  "identity.client.attach",
  "identity.user-state.read",
  "identity.user-state.upsert",
  "identity.user-state.delete",
]);

async function assertApplicationCapabilityClosure(env = process.env) {
  if (!distributedTopology(env)) return { ready: true, topology: "colocated" };

  const identity = await probeIdentityCapabilities(
    env,
    APPLICATION_IDENTITY_CAPABILITIES
  );
  if (!identity.ready) {
    const error = new Error("application_identity_capability_incomplete");
    error.code = "application_identity_capability_incomplete";
    error.capabilities = identity.capabilities;
    emitCapabilityState("missing", {
      missingCapabilities: Object.entries(identity.capabilities || {})
        .filter(([, state]) => state !== "ready")
        .map(([capability]) => capability),
    });
    throw error;
  }

  const canary = crypto.randomBytes(32).toString("base64url");
  const context = {
    purpose: "chat-conversation-key",
    domain: "chat-history",
    resource: "readiness-canary",
    operation: "application-capability-readiness",
  };
  const wrapped = await wrapMaterial(canary, context, env);
  const unwrapped = await unwrapMaterial(wrapped, context, env);
  if (unwrapped !== canary) {
    const error = new Error("application_key_custody_canary_mismatch");
    error.code = "application_key_custody_canary_mismatch";
    emitCapabilityState("missing", {
      missingCapabilities: ["key-custody.wrap", "key-custody.unwrap"],
    });
    throw error;
  }
  emitCapabilityState("recovered", { missingCapabilities: [] });
  return {
    ready: true,
    topology: "distributed",
    identity: identity.capabilities,
    keyCustody: "ready",
  };
}

function emitCapabilityState(state, metadata) {
  try {
    emitSemanticEvent({
      eventType: `runtime.database_capability.${state}`,
      category: "runtime",
      severity: state === "missing" ? "error" : "info",
      outcome: state === "missing" ? "degraded" : "recovered",
      subject: {
        type: "component",
        component: "athena-api",
        operation: "application-capability-closure",
      },
      metadata,
      sensitivity: "metadata_only",
    });
  } catch {
    // Capability evidence must not replace the actual readiness result.
  }
}

module.exports = {
  APPLICATION_IDENTITY_CAPABILITIES,
  assertApplicationCapabilityClosure,
};
