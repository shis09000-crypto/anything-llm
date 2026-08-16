const {
  AMPLITUDES,
  CAPABILITY_ID_PATTERN,
  EASINGS,
  FACE_REGIONS,
  FORBIDDEN_KEYS,
  INTERRUPTIBILITIES,
  PAIRED_FACE_REGIONS,
  PERFORMANCE_PROFILE,
  PHASE_ORDER,
  PROTOCOL_VERSION,
  RESPONSE_OBJECT,
  SIDES,
  SOURCES,
  TRACK_ORDER,
} = require("./constants");

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function result(errors, value) {
  return errors.length
    ? { ok: false, errors }
    : { ok: true, errors: [], value };
}

function add(errors, code, path, message, details = {}) {
  errors.push({ code, path, message, details });
}

function requiredString(errors, value, path) {
  if (typeof value !== "string" || value.length === 0)
    add(errors, "string_required", path, `${path} must be a non-empty string.`);
}

function unit(errors, value, path) {
  if (typeof value !== "number" || value < 0 || value > 1)
    add(errors, "range_invalid", path, `${path} must be between 0 and 1.`);
}

function integer(errors, value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < min || value > max)
    add(
      errors,
      "integer_range_invalid",
      path,
      `${path} must be an integer from ${min} to ${max}.`
    );
}

function capability(errors, value, path) {
  if (typeof value !== "string" || !CAPABILITY_ID_PATTERN.test(value))
    add(
      errors,
      "capability_id_invalid",
      path,
      `${path} must be a namespaced capability id.`
    );
}

function capabilityKind(value) {
  return String(value || "")
    .split(":")[1]
    ?.split("/")[0];
}

function requireCapabilityKind(errors, value, expected, path) {
  capability(errors, value, path);
  const observed = capabilityKind(value);
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (observed && !allowed.includes(observed))
    add(
      errors,
      "capability_track_mismatch",
      path,
      `${path} requires capability kind ${allowed.join(" or ")}, received ${observed}.`
    );
}

function scanForbidden(errors, value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForbidden(errors, entry, `${path}[${index}]`)
    );
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase()))
      add(
        errors,
        "low_level_field_forbidden",
        `${path}.${key}`,
        `${key} is outside Character v2 semantic control.`
      );
    scanForbidden(errors, entry, `${path}.${key}`);
  }
}

function validateManifestRef(errors, ref, path) {
  if (!isObject(ref))
    return add(
      errors,
      "manifest_ref_invalid",
      path,
      `${path} must be an object.`
    );
  requiredString(errors, ref.id, `${path}.id`);
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(String(ref.version || "")))
    add(
      errors,
      "semver_invalid",
      `${path}.version`,
      "Manifest version must use semantic versioning."
    );
  if (!/^[a-f0-9]{64}$/.test(String(ref.sha256 || "")))
    add(
      errors,
      "sha256_invalid",
      `${path}.sha256`,
      "Manifest digest must be lowercase SHA-256."
    );
}

function validateRequest(request) {
  const errors = [];
  if (!isObject(request))
    return result([
      {
        code: "object_required",
        path: "$",
        message: "Request must be an object.",
        details: {},
      },
    ]);
  if (request.protocol_version !== PROTOCOL_VERSION)
    add(
      errors,
      "protocol_version_unsupported",
      "$.protocol_version",
      "Character v2 requires protocol_version 2.0."
    );
  if (!isObject(request.character))
    add(errors, "character_required", "$.character", "character is required.");
  else {
    requiredString(
      errors,
      request.character.character_id,
      "$.character.character_id"
    );
    requiredString(
      errors,
      request.character.instance_id,
      "$.character.instance_id"
    );
    validateManifestRef(
      errors,
      request.character.capability_manifest,
      "$.character.capability_manifest"
    );
  }
  if (!Array.isArray(request.input) || request.input.length === 0)
    add(
      errors,
      "input_required",
      "$.input",
      "At least one input item is required."
    );
  if (!isObject(request.generation))
    add(
      errors,
      "generation_required",
      "$.generation",
      "generation is required."
    );
  else {
    if (!["main_agent", "realtime_reaction"].includes(request.generation.mode))
      add(
        errors,
        "generation_mode_invalid",
        "$.generation.mode",
        "Unsupported generation mode."
      );
    if (request.generation.performance_profile !== PERFORMANCE_PROFILE)
      add(
        errors,
        "performance_profile_invalid",
        "$.generation.performance_profile",
        `performance_profile must be ${PERFORMANCE_PROFILE}.`
      );
    if (
      !Array.isArray(request.generation.channels) ||
      request.generation.channels.length === 0
    )
      add(
        errors,
        "generation_channels_required",
        "$.generation.channels",
        "generation.channels must not be empty."
      );
  }
  scanForbidden(errors, request);
  return result(errors, request);
}

function validateAffect(errors, affect, path) {
  if (!isObject(affect))
    return add(errors, "affect_invalid", path, "affect must be an object.");
  capability(errors, affect.primary, `${path}.primary`);
  if (affect.secondary !== null && affect.secondary !== undefined)
    capability(errors, affect.secondary, `${path}.secondary`);
  unit(errors, affect.intensity, `${path}.intensity`);
  if (
    typeof affect.valence !== "number" ||
    affect.valence < -1 ||
    affect.valence > 1
  )
    add(
      errors,
      "range_invalid",
      `${path}.valence`,
      "valence must be between -1 and 1."
    );
  unit(errors, affect.arousal, `${path}.arousal`);
}

function validateIntent(errors, item, path) {
  if (!isObject(item) || item.type !== "performance_intent")
    return add(
      errors,
      "performance_intent_required",
      path,
      "First output item must be performance_intent."
    );
  requiredString(errors, item.id, `${path}.id`);
  if (item.status !== "completed")
    add(
      errors,
      "item_status_invalid",
      `${path}.status`,
      "Completed response items must be completed."
    );
  validateAffect(errors, item.affect, `${path}.affect`);
  if (!isObject(item.channel_modulation))
    add(
      errors,
      "channel_modulation_invalid",
      `${path}.channel_modulation`,
      "channel_modulation must be an object."
    );
  else
    Object.entries(item.channel_modulation).forEach(([channel, affect]) =>
      validateAffect(errors, affect, `${path}.channel_modulation.${channel}`)
    );
  if (!SOURCES.includes(item.source))
    add(
      errors,
      "performance_source_invalid",
      `${path}.source`,
      "Unsupported performance source."
    );
  if (!isObject(item.transition) || !EASINGS.includes(item.transition.style))
    add(
      errors,
      "transition_invalid",
      `${path}.transition`,
      "Intent transition is invalid."
    );
  if (!Number.isInteger(item.revision) || item.revision < 0)
    add(
      errors,
      "revision_invalid",
      `${path}.revision`,
      "revision must be non-negative."
    );
}

function phaseMap(errors, sequence, path) {
  if (
    !Array.isArray(sequence.phases) ||
    sequence.phases.length !== PHASE_ORDER.length
  ) {
    add(
      errors,
      "phase_order_invalid",
      `${path}.phases`,
      "Sequence must contain four standard phases."
    );
    return new Map();
  }
  const map = new Map();
  let cursor = 0;
  sequence.phases.forEach((phase, index) => {
    const phasePath = `${path}.phases[${index}]`;
    if (phase?.id !== PHASE_ORDER[index])
      add(
        errors,
        "phase_order_invalid",
        `${phasePath}.id`,
        `Expected phase ${PHASE_ORDER[index]}.`
      );
    integer(
      errors,
      phase?.planned_start_ms,
      `${phasePath}.planned_start_ms`,
      0,
      600000
    );
    integer(
      errors,
      phase?.planned_duration_ms,
      `${phasePath}.planned_duration_ms`,
      0,
      600000
    );
    if (phase?.planned_start_ms !== cursor)
      add(
        errors,
        "phase_not_contiguous",
        `${phasePath}.planned_start_ms`,
        `Phase must start at ${cursor}.`
      );
    const end =
      Number(phase?.planned_start_ms || 0) +
      Number(phase?.planned_duration_ms || 0);
    cursor = end;
    map.set(phase?.id, { start: phase?.planned_start_ms, end });
  });
  if (cursor !== sequence.planned_duration_ms)
    add(
      errors,
      "phase_coverage_invalid",
      `${path}.phases`,
      "Phases must cover planned_duration_ms exactly."
    );
  return map;
}

function validateFaceState(errors, state, path, baseline = false) {
  if (!isObject(state))
    return add(
      errors,
      "face_state_invalid",
      path,
      "Face state must be an object."
    );
  if (!FACE_REGIONS.includes(state.region))
    add(
      errors,
      "face_region_invalid",
      `${path}.region`,
      "Unsupported face region."
    );
  if (!SIDES.includes(state.side))
    add(errors, "side_invalid", `${path}.side`, "Unsupported side.");
  if (PAIRED_FACE_REGIONS.has(state.region) && state.side === "center")
    add(
      errors,
      "face_side_invalid",
      `${path}.side`,
      "Paired face region cannot use center."
    );
  if (
    !PAIRED_FACE_REGIONS.has(state.region) &&
    !["center", "both"].includes(state.side)
  )
    add(
      errors,
      "face_side_invalid",
      `${path}.side`,
      "Center face region cannot use left or right."
    );
  capability(errors, state.state, `${path}.state`);
  if (
    FACE_REGIONS.includes(state.region) &&
    capabilityKind(state.state) !== `face_${state.region}`
  )
    add(
      errors,
      "face_capability_region_mismatch",
      `${path}.state`,
      `Face state for ${state.region} must use face_${state.region}.`
    );
  unit(errors, state.intensity, `${path}.intensity`);
  if (baseline && state.intensity > 0.6)
    add(
      errors,
      "baseline_intensity_excessive",
      `${path}.intensity`,
      "Restrained baseline intensity cannot exceed 0.6."
    );
}

function validateCueCommon(errors, cue, path, sequenceDuration) {
  if (!isObject(cue)) return false;
  requiredString(errors, cue.cue_id, `${path}.cue_id`);
  if (!PHASE_ORDER.includes(cue.phase_id))
    add(errors, "cue_phase_invalid", `${path}.phase_id`, "Unknown phase id.");
  integer(errors, cue.planned_start_ms, `${path}.planned_start_ms`, 0, 600000);
  integer(
    errors,
    cue.planned_duration_ms,
    `${path}.planned_duration_ms`,
    40,
    360000
  );
  if (!EASINGS.includes(cue.easing))
    add(errors, "easing_invalid", `${path}.easing`, "Unsupported easing.");
  unit(errors, cue.intensity, `${path}.intensity`);
  if (typeof cue.required !== "boolean")
    add(
      errors,
      "required_flag_invalid",
      `${path}.required`,
      "required must be boolean."
    );
  if (!AMPLITUDES.includes(cue.amplitude))
    add(
      errors,
      "amplitude_invalid",
      `${path}.amplitude`,
      "Unsupported amplitude."
    );
  const end =
    Number(cue.planned_start_ms || 0) + Number(cue.planned_duration_ms || 0);
  if (end > sequenceDuration)
    add(errors, "cue_out_of_bounds", path, "Cue exceeds sequence duration.");
  return true;
}

function cueCapability(cue, trackName) {
  if (trackName === "face") return null;
  if (trackName === "gaze") return cue.gaze;
  if (trackName === "action") return cue.action;
  if (trackName === "speech") return cue.delivery?.style;
  return cue.motion;
}

function validateCuePayload(errors, cue, path, trackName) {
  if (trackName === "face") {
    if (!Array.isArray(cue.changes) || cue.changes.length === 0)
      add(
        errors,
        "face_changes_required",
        `${path}.changes`,
        "Face cue requires region changes."
      );
    else
      cue.changes.forEach((entry, index) =>
        validateFaceState(errors, entry, `${path}.changes[${index}]`)
      );
    return;
  }
  if (trackName === "gaze") {
    requireCapabilityKind(errors, cue.gaze, "gaze", `${path}.gaze`);
    if (!isObject(cue.target))
      add(
        errors,
        "target_invalid",
        `${path}.target`,
        "Gaze target is required."
      );
    return;
  }
  if (trackName === "action") {
    requireCapabilityKind(errors, cue.action, "action", `${path}.action`);
    if (!isObject(cue.arguments))
      add(
        errors,
        "action_arguments_invalid",
        `${path}.arguments`,
        "Action arguments must be an object."
      );
    return;
  }
  if (trackName === "speech") {
    requiredString(errors, cue.text, `${path}.text`);
    if (cue.language !== "zh-CN")
      add(
        errors,
        "speech_language_invalid",
        `${path}.language`,
        "Test profile requires zh-CN."
      );
    if (!isObject(cue.delivery))
      add(
        errors,
        "speech_delivery_invalid",
        `${path}.delivery`,
        "Speech delivery is required."
      );
    else {
      requireCapabilityKind(
        errors,
        cue.delivery.emotion,
        "emotion",
        `${path}.delivery.emotion`
      );
      requireCapabilityKind(
        errors,
        cue.delivery.style,
        "voice_style",
        `${path}.delivery.style`
      );
      unit(errors, cue.delivery.intensity, `${path}.delivery.intensity`);
      unit(errors, cue.delivery.volume, `${path}.delivery.volume`);
      if (
        typeof cue.delivery.rate !== "number" ||
        cue.delivery.rate < 0.5 ||
        cue.delivery.rate > 2
      )
        add(
          errors,
          "speech_rate_invalid",
          `${path}.delivery.rate`,
          "Speech rate must be 0.5 to 2."
        );
    }
    return;
  }
  const expectedMotionKind = {
    head_neck: "head_neck_motion",
    shoulders: "shoulders_motion",
    torso: "torso_motion",
    left_arm: "arm_motion",
    right_arm: "arm_motion",
    left_hand: "hand_motion",
    right_hand: "hand_motion",
    left_leg: "leg_motion",
    right_leg: "leg_motion",
  }[trackName];
  requireCapabilityKind(
    errors,
    cue.motion,
    expectedMotionKind,
    `${path}.motion`
  );
  if (cue.direction !== undefined && typeof cue.direction !== "string")
    add(
      errors,
      "direction_invalid",
      `${path}.direction`,
      "direction must be semantic text."
    );
}

function validateTrack(errors, track, index, sequence, cueIds, path) {
  const expectedName = TRACK_ORDER[index];
  if (!isObject(track) || track.name !== expectedName)
    return add(
      errors,
      "track_order_invalid",
      `${path}.name`,
      `Expected track ${expectedName}.`
    );
  if (typeof track.enabled !== "boolean")
    add(
      errors,
      "track_enabled_invalid",
      `${path}.enabled`,
      "enabled must be boolean."
    );
  if (!Array.isArray(track.cues))
    return add(
      errors,
      "track_cues_invalid",
      `${path}.cues`,
      "cues must be an array."
    );
  if (!track.enabled && track.cues.length)
    add(
      errors,
      "disabled_track_has_cues",
      `${path}.cues`,
      "Disabled track must not contain cues."
    );
  if (track.name === "face") {
    if (!Array.isArray(track.baseline))
      add(
        errors,
        "face_baseline_required",
        `${path}.baseline`,
        "Face track requires a baseline."
      );
    else {
      track.baseline.forEach((entry, baselineIndex) =>
        validateFaceState(
          errors,
          entry,
          `${path}.baseline[${baselineIndex}]`,
          true
        )
      );
      const covered = new Set(track.baseline.map((entry) => entry?.region));
      const baselineKeys = new Set();
      track.baseline.forEach((entry, baselineIndex) => {
        const key = `${entry?.region}:${entry?.side}`;
        if (baselineKeys.has(key))
          add(
            errors,
            "face_baseline_duplicate",
            `${path}.baseline[${baselineIndex}]`,
            `Face baseline repeats ${key}.`
          );
        baselineKeys.add(key);
      });
      FACE_REGIONS.forEach((region) => {
        if (!covered.has(region))
          add(
            errors,
            "face_baseline_incomplete",
            `${path}.baseline`,
            `Face baseline is missing ${region}.`
          );
      });
    }
  } else if (track.baseline !== undefined) {
    add(
      errors,
      "baseline_track_invalid",
      `${path}.baseline`,
      "Only face track may define baseline."
    );
  }
  let previousStart = -1;
  track.cues.forEach((cue, cueIndex) => {
    const cuePath = `${path}.cues[${cueIndex}]`;
    if (!validateCueCommon(errors, cue, cuePath, sequence.planned_duration_ms))
      return;
    validateCuePayload(errors, cue, cuePath, track.name);
    if (cueIds.has(cue.cue_id))
      add(
        errors,
        "cue_id_duplicate",
        `${cuePath}.cue_id`,
        `Cue id ${cue.cue_id} is already used in this sequence.`
      );
    cueIds.add(cue.cue_id);
    if (cue.planned_start_ms < previousStart)
      add(
        errors,
        "cue_order_invalid",
        `${cuePath}.planned_start_ms`,
        "Cues must be sorted by start time."
      );
    previousStart = cue.planned_start_ms;
  });
}

function validateRichness(errors, sequence, intent, path) {
  const byName = new Map(sequence.tracks.map((track) => [track.name, track]));
  const face = byName.get("face");
  const gaze = byName.get("gaze");
  const speech = byName.get("speech");
  const faceRegions = new Set(
    (face?.cues || []).flatMap((cue) =>
      (cue.changes || []).map((change) => change.region)
    )
  );
  const danger = intent.source === "high_priority_event";
  if ((face?.cues || []).length < (danger ? 3 : 2))
    add(
      errors,
      "face_richness_insufficient",
      `${path}.tracks[0].cues`,
      `Face requires at least ${danger ? 3 : 2} cues.`
    );
  if (faceRegions.size < (danger ? 5 : 3))
    add(
      errors,
      "face_region_richness_insufficient",
      `${path}.tracks[0].cues`,
      `Face cues must change at least ${danger ? 5 : 3} regions.`
    );
  if (!(gaze?.cues || []).length)
    add(
      errors,
      "gaze_required",
      `${path}.tracks[1].cues`,
      "At least one gaze cue is required."
    );
  if (!(speech?.cues || []).length)
    add(
      errors,
      "speech_required",
      `${path}.tracks[12].cues`,
      "At least one speech cue is required."
    );
  for (const cue of speech?.cues || []) {
    const allowedSpeechEmotions = new Set(
      [
        intent.affect?.primary,
        intent.affect?.secondary,
        intent.channel_modulation?.voice?.primary,
        intent.channel_modulation?.voice?.secondary,
      ].filter(Boolean)
    );
    if (!allowedSpeechEmotions.has(cue.delivery?.emotion))
      add(
        errors,
        "speech_emotion_conflict",
        `${path}.tracks[12].cues`,
        "Speech emotion must be declared by Performance Intent or voice modulation."
      );
  }
  if (danger) {
    for (const requiredTrack of ["speech"]) {
      const first = byName.get(requiredTrack)?.cues?.[0];
      if (!first || first.planned_start_ms > 300)
        add(
          errors,
          "danger_immediate_track_required",
          `${path}.tracks`,
          `${requiredTrack} must begin within the first 300ms.`
        );
    }
  }
}

function validateResponse(response) {
  const errors = [];
  if (!isObject(response))
    return result([
      {
        code: "object_required",
        path: "$",
        message: "Response must be an object.",
        details: {},
      },
    ]);
  if (response.object !== RESPONSE_OBJECT)
    add(
      errors,
      "response_object_invalid",
      "$.object",
      `object must be ${RESPONSE_OBJECT}.`
    );
  if (response.protocol_version !== PROTOCOL_VERSION)
    add(
      errors,
      "protocol_version_unsupported",
      "$.protocol_version",
      "protocol_version must be 2.0."
    );
  if (!Array.isArray(response.output) || response.output.length !== 2)
    add(
      errors,
      "output_shape_invalid",
      "$.output",
      "Character v2 output must contain exactly two items."
    );
  const intent = response.output?.[0];
  const sequence = response.output?.[1];
  validateIntent(errors, intent, "$.output[0]");
  if (!isObject(sequence) || sequence.type !== "performance_sequence")
    add(
      errors,
      "performance_sequence_required",
      "$.output[1]",
      "Second output item must be performance_sequence."
    );
  else {
    requiredString(errors, sequence.id, "$.output[1].id");
    if (sequence.intent_id !== intent?.id)
      add(
        errors,
        "intent_reference_invalid",
        "$.output[1].intent_id",
        "Sequence must reference the Performance Intent."
      );
    integer(
      errors,
      sequence.planned_duration_ms,
      "$.output[1].planned_duration_ms",
      100,
      600000
    );
    if (
      sequence.interruptibility !== undefined &&
      !INTERRUPTIBILITIES.includes(sequence.interruptibility)
    )
      add(
        errors,
        "interruptibility_invalid",
        "$.output[1].interruptibility",
        "Unsupported interruptibility."
      );
    phaseMap(errors, sequence, "$.output[1]");
    const cueIds = new Set();
    if (
      !Array.isArray(sequence.tracks) ||
      sequence.tracks.length !== TRACK_ORDER.length
    )
      add(
        errors,
        "track_order_invalid",
        "$.output[1].tracks",
        "Sequence must declare all thirteen tracks."
      );
    else
      sequence.tracks.forEach((track, index) =>
        validateTrack(
          errors,
          track,
          index,
          sequence,
          cueIds,
          `$.output[1].tracks[${index}]`
        )
      );
    if (Array.isArray(sequence.tracks))
      validateRichness(errors, sequence, intent || {}, "$.output[1]");
  }
  scanForbidden(errors, response);
  return result(errors, response);
}

module.exports = {
  cueCapability,
  scanForbidden,
  validateCharacterV2Request: validateRequest,
  validateCharacterV2Response: validateResponse,
};
