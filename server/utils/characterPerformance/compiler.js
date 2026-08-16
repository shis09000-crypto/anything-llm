const {
  PLAN_SCHEMA,
  PROTOCOL_VERSION,
  digest,
  identifier,
  performanceError,
} = require("./contract");

function replaceTemplate(template, values) {
  return String(template || "").replace(/\{([a-z_]+)\}/g, (_match, key) =>
    String(values[key] ?? "center")
  );
}

function matchingBinding(pack, capabilityId, track) {
  const seen = new Set();
  let current = capabilityId;
  for (let depth = 0; current && depth <= 4; depth += 1) {
    if (seen.has(current))
      throw performanceError("performance_pack_fallback_cycle", 409, {
        capability_id: capabilityId,
      });
    seen.add(current);
    const binding = pack.bindings.find(
      (entry) =>
        entry.tracks.includes(track) &&
        new RegExp(entry.capability_pattern).test(current)
    );
    if (binding)
      return {
        binding,
        capabilityId: current,
        fallbackDepth: depth,
      };
    current = pack.fallbacks?.[current];
  }
  return null;
}

function cueById(response) {
  const result = new Map();
  const sequence = response.output.find(
    (item) => item.type === "performance_sequence"
  );
  for (const track of sequence?.tracks || [])
    for (const cue of track.cues || []) result.set(cue.cue_id, { track, cue });
  return { sequence, result };
}

function commandParameters(trackName, cue, capabilityId, change = null) {
  const parameters = {
    capability_id: capabilityId,
    intensity: Number(change?.intensity ?? cue.intensity ?? 0),
    amplitude: cue.amplitude || "micro",
    required: cue.required === true,
  };
  if (trackName === "gaze") parameters.target = cue.target;
  if (trackName === "speech") {
    parameters.text = cue.text;
    parameters.language = cue.language;
    parameters.delivery = cue.delivery;
  }
  if (trackName === "action") {
    parameters.target = cue.target || null;
    parameters.arguments = cue.arguments || {};
  }
  if (cue.direction) parameters.direction = cue.direction;
  if (change) parameters.face = change;
  return parameters;
}

function compilePerformancePlan({
  session,
  response,
  resolution,
  pack,
  now = Date.now(),
}) {
  if (response.capability_manifest?.sha256 !== pack.manifest_ref.sha256)
    throw performanceError("performance_plan_manifest_mismatch", 409);
  const { sequence, result: cues } = cueById(response);
  if (!sequence) throw performanceError("performance_sequence_required");
  const commands = [];
  const warnings = [...(resolution.warnings || [])];
  for (const resolved of resolution.cues || []) {
    const source = cues.get(resolved.cue_id);
    if (!source)
      throw performanceError("performance_resolved_cue_missing", 409);
    const capabilityEntries = Array.isArray(resolved.capabilities)
      ? resolved.capabilities
      : [];
    const expanded =
      source.track.name === "face"
        ? capabilityEntries.map((entry, index) => ({
            entry,
            change: source.cue.changes?.[index] || null,
          }))
        : capabilityEntries.map((entry) => ({ entry, change: null }));
    for (const { entry, change } of expanded) {
      const capabilityId = entry.resolved_capability;
      const matched = matchingBinding(pack, capabilityId, source.track.name);
      if (!matched) {
        if (source.cue.required)
          throw performanceError("performance_required_binding_missing", 409, {
            cue_id: source.cue.cue_id,
            capability_id: capabilityId,
          });
        warnings.push({
          code: "performance_optional_binding_missing",
          cue_id: source.cue.cue_id,
          capability_id: capabilityId,
        });
        continue;
      }
      const { binding } = matched;
      if (matched.fallbackDepth > 0)
        warnings.push({
          code: "performance_binding_fallback",
          cue_id: source.cue.cue_id,
          requested_capability: capabilityId,
          resolved_capability: matched.capabilityId,
          fallback_depth: matched.fallbackDepth,
        });
      const match = matched.capabilityId.match(
        new RegExp(binding.capability_pattern)
      );
      const values = {
        capability: capabilityId,
        track: source.track.name,
        region: change?.region || match?.groups?.region,
        side: change?.side || "center",
        state: match?.groups?.state || match?.groups?.name,
      };
      commands.push({
        command_id: identifier("chr_cmd"),
        cue_id: source.cue.cue_id,
        track: source.track.name,
        start_ms: resolved.resolved_start_ms,
        duration_ms: resolved.resolved_duration_ms,
        timing: {
          planned_start_ms: resolved.planned_start_ms,
          planned_duration_ms: resolved.planned_duration_ms,
          resolved_start_ms: resolved.resolved_start_ms,
          resolved_duration_ms: resolved.resolved_duration_ms,
          actual_start_ms: null,
          actual_duration_ms: null,
        },
        easing: source.cue.easing,
        intensity: Number(change?.intensity ?? source.cue.intensity ?? 0),
        binding_id: binding.binding_id,
        primitive: binding.primitive,
        target: replaceTemplate(binding.target_template, values),
        parameters: commandParameters(
          source.track.name,
          source.cue,
          capabilityId,
          change
        ),
      });
    }
  }
  const plan = {
    schema: PLAN_SCHEMA,
    schema_version: PROTOCOL_VERSION,
    id: identifier("chr_perf_plan"),
    session_id: session.id,
    response_id: response.id,
    sequence_id: sequence.id,
    pack_ref: {
      id: pack.id,
      version: pack.version,
      sha256: pack.integrity.sha256,
    },
    status: "ready",
    created_at: now,
    clock: { unit: "ms", origin: "plan_dispatch" },
    planned_duration_ms: sequence.planned_duration_ms,
    resolved_duration_ms: resolution.resolved_duration_ms,
    commands,
    suppressed_cues: resolution.suppressed_cues || [],
    warnings,
  };
  plan.integrity = { sha256: digest(plan) };
  return plan;
}

module.exports = { compilePerformancePlan, matchingBinding };
