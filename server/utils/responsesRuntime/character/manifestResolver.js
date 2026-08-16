const { ITEM_CAPABILITY_FIELDS, isPlainObject } = require("./contract");
const { validateCapabilityManifest } = require("./validator");

function resolutionError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.details = details;
  return error;
}

function capabilityIndex(manifest) {
  return new Map(
    (manifest.capabilities || []).map((capability) => [
      capability.id,
      capability,
    ])
  );
}

function resolveCapability(
  requestedCapability,
  manifest,
  { required = false, maxDepth = 4 } = {}
) {
  const manifestValidation = validateCapabilityManifest(manifest);
  if (!manifestValidation.ok)
    throw resolutionError(
      "character_manifest_invalid",
      "Character capability manifest is invalid.",
      { errors: manifestValidation.errors }
    );

  const capabilities = capabilityIndex(manifest);
  const visited = new Set();
  const path = [];
  let current = requestedCapability;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (visited.has(current))
      throw resolutionError(
        "capability_fallback_cycle",
        `Capability fallback cycle detected at ${current}.`,
        { requestedCapability, path: [...path, current] }
      );
    visited.add(current);
    path.push(current);

    const capability = capabilities.get(current);
    if (capability && capability.available !== false)
      return {
        status: "resolved",
        requested_capability: requestedCapability,
        resolved_capability: current,
        fallback_depth: depth,
        capability,
        path,
      };

    const fallback =
      capability?.fallback ||
      (isPlainObject(manifest.fallbacks) ? manifest.fallbacks[current] : null);
    if (!fallback) {
      if (required)
        throw resolutionError(
          "required_capability_unavailable",
          `Required capability is unavailable: ${requestedCapability}.`,
          { requestedCapability, path }
        );
      return {
        status: "ignored",
        requested_capability: requestedCapability,
        resolved_capability: null,
        fallback_depth: depth,
        capability: null,
        path,
        warning: {
          code: "optional_capability_unavailable",
          message: `Optional capability was ignored: ${requestedCapability}.`,
          capability: requestedCapability,
        },
      };
    }
    current = fallback;
  }

  throw resolutionError(
    "capability_fallback_depth_exceeded",
    `Capability fallback exceeded ${maxDepth} levels.`,
    { requestedCapability, path }
  );
}

function itemCapability(item) {
  const field = ITEM_CAPABILITY_FIELDS[item?.type];
  if (field) return { field, value: item[field] };
  if (item?.type === "gaze") return { field: "style", value: item.style };
  return null;
}

function resolveResponseCapabilities(response, manifest) {
  const output = [];
  const warnings = [...(response.warnings || [])];

  for (const item of response.output || []) {
    const reference = itemCapability(item);
    if (!reference) {
      output.push(item);
      continue;
    }
    const resolution = resolveCapability(reference.value, manifest, {
      required: item.required === true,
      maxDepth: manifest.fallback_policy?.max_depth || 4,
    });
    if (resolution.status === "ignored") {
      warnings.push({ ...resolution.warning, item_id: item.id });
      continue;
    }
    output.push({
      ...item,
      [reference.field]: resolution.resolved_capability,
      resolution: {
        requested_capability: resolution.requested_capability,
        resolved_capability: resolution.resolved_capability,
        fallback_depth: resolution.fallback_depth,
      },
    });
  }

  return { ...response, output, warnings };
}

module.exports = {
  capabilityIndex,
  resolveCapability,
  resolveResponseCapabilities,
  resolutionError,
};
