const crypto = require("crypto");
const { cueCapability, validateCharacterV2Response } = require("./validator");
const { manifestDigest } = require("./profile");

function resolutionError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function capabilityMap(manifest) {
  return new Map(
    (manifest.capabilities || []).map((entry) => [entry.id, entry])
  );
}

function resolveCapability(id, required, manifest, map, warnings) {
  let current = id;
  const seen = new Set();
  for (
    let depth = 0;
    depth <= Number(manifest.fallback_policy?.max_depth || 4);
    depth += 1
  ) {
    if (seen.has(current))
      throw resolutionError("character_v2_fallback_cycle", {
        capability: current,
      });
    seen.add(current);
    const definition = map.get(current);
    if (definition?.available)
      return {
        definition,
        requested: id,
        resolved: current,
        fallbackDepth: depth,
      };
    current = definition?.fallback || manifest.fallbacks?.[current];
    if (!current) break;
  }
  if (required)
    throw resolutionError("character_v2_required_capability_unavailable", {
      capability: id,
    });
  warnings.push({
    code: "optional_capability_unavailable",
    message: `Optional capability ${id} is unavailable.`,
    capability: id,
  });
  return null;
}

function cueCapabilities(cue, trackName) {
  if (trackName === "face")
    return (cue.changes || []).map((change) => change.state);
  const id = cueCapability(cue, trackName);
  return id ? [id] : [];
}

function timingBounds(definitions) {
  return {
    minimum: Math.max(
      40,
      ...definitions.map((entry) =>
        Number(entry.timing?.minimum_duration_ms || 40)
      )
    ),
    maximum: Math.min(
      360000,
      ...definitions.map((entry) =>
        Number(entry.timing?.maximum_duration_ms || 360000)
      )
    ),
  };
}

function parameterErrors(value, schema = {}, path = "$.arguments") {
  const errors = [];
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return [{ path, message: "must be an object" }];
    const properties = schema.properties || {};
    for (const required of schema.required || [])
      if (!Object.prototype.hasOwnProperty.call(value, required))
        errors.push({ path: `${path}.${required}`, message: "is required" });
    for (const [key, entry] of Object.entries(value)) {
      const definition = properties[key];
      if (!definition) {
        if (schema.additionalProperties === false)
          errors.push({
            path: `${path}.${key}`,
            message: "is not allowed by the capability Manifest",
          });
        continue;
      }
      if (definition.type && typeof entry !== definition.type)
        errors.push({
          path: `${path}.${key}`,
          message: `must be ${definition.type}`,
        });
      if (definition.enum && !definition.enum.includes(entry))
        errors.push({
          path: `${path}.${key}`,
          message: `must be one of ${definition.enum.join(", ")}`,
        });
      if (
        typeof entry === "string" &&
        Number.isInteger(definition.maxLength) &&
        entry.length > definition.maxLength
      )
        errors.push({
          path: `${path}.${key}`,
          message: `must not exceed ${definition.maxLength} characters`,
        });
    }
  }
  return errors;
}

function faceClaimKeys(change) {
  const sides =
    change.side === "both" ? ["left", "right"] : [change.side || "center"];
  return sides.map((side) => `${change.region}:${side}`);
}

function findExclusiveConflict(track, cue, activeClaims) {
  const keys =
    track.name === "face"
      ? (cue.changes || []).flatMap(faceClaimKeys)
      : [track.name];
  for (const key of keys) {
    const active = activeClaims.get(key);
    if (active && cue.planned_start_ms < active.end_ms)
      return { ...active, resource: key };
  }
  return null;
}

function claimExclusiveResources(track, cue, activeClaims) {
  const keys =
    track.name === "face"
      ? (cue.changes || []).flatMap(faceClaimKeys)
      : [track.name];
  const claim = {
    cue_id: cue.cue_id,
    end_ms: cue.planned_start_ms + cue.planned_duration_ms,
  };
  for (const key of keys) activeClaims.set(key, claim);
}

function resolvePerformanceSequence(response, manifest) {
  const observedDigest = manifestDigest(manifest);
  if (observedDigest !== manifest.integrity?.sha256)
    throw resolutionError("character_v2_manifest_digest_invalid", {
      expected: manifest.integrity?.sha256 || null,
      observed: observedDigest,
    });
  if (response.capability_manifest?.sha256 !== observedDigest)
    throw resolutionError("character_v2_manifest_reference_mismatch", {
      expected: observedDigest,
      observed: response.capability_manifest?.sha256 || null,
    });
  const validation = validateCharacterV2Response(response);
  if (!validation.ok)
    throw resolutionError("character_v2_response_invalid", {
      errors: validation.errors,
    });
  const sequence = response.output[1];
  const map = capabilityMap(manifest);
  const warnings = [];
  const resolvedCues = [];
  const suppressedCues = [];
  const activeClaims = new Map();
  let resolvedDuration = sequence.planned_duration_ms;

  for (const track of sequence.tracks) {
    for (const cue of track.cues) {
      const resolutions = cueCapabilities(cue, track.name)
        .map((id) =>
          resolveCapability(id, cue.required, manifest, map, warnings)
        )
        .filter(Boolean);
      if (!resolutions.length && !cue.required) continue;
      const bounds = timingBounds(resolutions.map((entry) => entry.definition));
      if (track.name === "action") {
        const errors = parameterErrors(
          cue.arguments,
          resolutions[0]?.definition?.parameters
        );
        if (errors.length)
          throw resolutionError("character_v2_action_arguments_invalid", {
            cue_id: cue.cue_id,
            capability: cue.action,
            errors,
          });
      }
      const resolvedCueDuration = Math.min(
        bounds.maximum,
        Math.max(bounds.minimum, cue.planned_duration_ms)
      );
      const resolvedCue = {
        ...cue,
        planned_duration_ms: resolvedCueDuration,
      };
      const conflict = findExclusiveConflict(track, resolvedCue, activeClaims);
      if (conflict) {
        const suppressed = {
          cue_id: cue.cue_id,
          track: track.name,
          kept_cue_id: conflict.cue_id,
          resource: conflict.resource,
          policy: "first_wins",
        };
        suppressedCues.push(suppressed);
        warnings.push({
          code: "cue_conflict_suppressed",
          message: `Cue ${cue.cue_id} was suppressed because ${conflict.cue_id} already claims ${conflict.resource}; first_wins policy applied.`,
          item_id: sequence.id,
          cue_id: cue.cue_id,
          track: track.name,
          kept_cue_id: conflict.cue_id,
          policy: "first_wins",
        });
        continue;
      }
      claimExclusiveResources(track, resolvedCue, activeClaims);
      const changed = resolvedCueDuration !== cue.planned_duration_ms;
      if (changed)
        warnings.push({
          code: "cue_duration_resolved",
          message: `Cue ${cue.cue_id} duration was resolved from ${cue.planned_duration_ms}ms to ${resolvedCueDuration}ms.`,
          item_id: sequence.id,
        });
      resolvedDuration = Math.max(
        resolvedDuration,
        cue.planned_start_ms + resolvedCueDuration
      );
      resolvedCues.push({
        cue_id: cue.cue_id,
        track: track.name,
        planned_start_ms: cue.planned_start_ms,
        planned_duration_ms: cue.planned_duration_ms,
        resolved_start_ms: cue.planned_start_ms,
        resolved_duration_ms: resolvedCueDuration,
        capabilities: resolutions.map((entry) => ({
          requested_capability: entry.requested,
          resolved_capability: entry.resolved,
          fallback_depth: entry.fallbackDepth,
        })),
      });
    }
  }

  const event = {
    type: "character.performance.sequence.resolved",
    event_id: `chr_evt_${crypto.randomUUID().replace(/-/g, "")}`,
    sequence_number: 0,
    created_at: Date.now(),
    response_id: response.id,
    item_id: sequence.id,
    revision: sequence.revision,
    planned_duration_ms: sequence.planned_duration_ms,
    resolved_duration_ms: resolvedDuration,
    cues: resolvedCues,
    suppressed_cues: suppressedCues,
    warnings,
  };
  return {
    event,
    warnings,
    resolvedCues,
    suppressedCues,
    resolvedDuration,
  };
}

module.exports = {
  resolvePerformanceSequence,
  resolutionError,
};
