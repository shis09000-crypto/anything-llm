const crypto = require("crypto");
const { FACE_REGIONS } = require("../v2/constants");

const BODY_STATE_KEYS = Object.freeze([
  "head_neck",
  "shoulders",
  "torso",
  "left_arm",
  "right_arm",
  "left_hand",
  "right_hand",
  "left_leg",
  "right_leg",
]);
const STATE_SECTION_KEYS = Object.freeze([
  "performance_intent",
  "attention",
  "face",
  "gaze",
  ...BODY_STATE_KEYS,
  "posture",
  "locomotion",
  "action",
  "voice_delivery",
  "activity",
  "performance_state",
  "decay",
]);

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(",")}}`;
}

function inactiveBodyState() {
  return {
    enabled: false,
    capability: null,
    direction: null,
    intensity: 0,
    amplitude: "micro",
    tension: 0,
    contact: null,
    persistence: "until_replaced",
  };
}

function initialPersistentState(characterState = {}) {
  const affect = characterState.affect || {
    primary: "athena.core:emotion/neutral",
    secondary: null,
    intensity: 0.15,
    valence: 0,
    arousal: 0.15,
  };
  const neutralFace = {
    brow: "athena.core:face_brow/neutral",
    eyelid: "athena.core:face_eyelid/neutral",
    eye_shape: "athena.core:face_eye_shape/neutral",
    pupil: "athena.core:face_pupil/neutral",
    cheek: "athena.core:face_cheek/neutral",
    nose: "athena.core:face_nose/neutral",
    lip: "athena.core:face_lip/neutral",
    jaw: "athena.core:face_jaw/neutral",
  };
  return {
    revision: Number(characterState.revision || 0),
    performance_intent: {
      affect,
      source: "runtime_default",
      channel_modulation: {},
      persistence: "until_replaced",
      interruptibility: "blend_out",
    },
    attention: characterState.attention || { target: "player", intensity: 0.45 },
    face: FACE_REGIONS.map((region) => ({
      region,
      side: ["nose", "jaw"].includes(region) ? "center" : "both",
      state: neutralFace[region],
      intensity: 0.15,
      persistence: "until_replaced",
    })),
    gaze: {
      enabled: true,
      capability: "athena.core:gaze/direct",
      target: characterState.gaze?.target || "player",
      style: characterState.gaze?.style || "neutral",
      direction: null,
      intensity: characterState.attention?.intensity || 0.45,
      persistence: "until_replaced",
    },
    ...Object.fromEntries(BODY_STATE_KEYS.map((key) => [key, inactiveBodyState()])),
    posture: {
      capability: characterState.posture || "conversation_ready",
      intensity: 0.25,
      persistence: "until_replaced",
    },
    locomotion: {
      enabled: false,
      capability: null,
      target: null,
      intensity: 0,
      persistence: "until_replaced",
    },
    action: {
      enabled: false,
      capability: null,
      target: null,
      arguments: {},
      progress: "idle",
      persistence: "until_action_complete",
    },
    voice_delivery: {
      enabled: true,
      emotion: affect.primary,
      intensity: affect.intensity,
      rate: 1,
      volume: 0.65,
      style: "athena.core:voice_style/restrained",
      persistence: "until_replaced",
    },
    activity: characterState.activity || {
      current: "conversation",
      previous: "ambient_idle",
    },
    performance_state: characterState.performance_state || "listening",
    decay: characterState.decay || {
      mode: "hold",
      target: "soft_neutral",
      duration_ms: 0,
    },
    source_turn_id: characterState.source_turn_id || null,
    source_response_id: null,
    source_sequence_id: null,
    updated_at: Number(characterState.updated_at || Date.now()),
  };
}

function persistentStateError(code, details = null) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = 502;
  if (details) error.details = details;
  return error;
}

function validatePersistentState(state) {
  if (!state || Array.isArray(state) || typeof state !== "object")
    throw persistentStateError("character_persistent_state_required");
  const missing = STATE_SECTION_KEYS.filter(
    (key) => state[key] === undefined || state[key] === null
  );
  if (missing.length)
    throw persistentStateError("character_persistent_state_incomplete", {
      missing,
    });
  if (!Array.isArray(state.face))
    throw persistentStateError("character_persistent_face_invalid");
  const regions = new Set(state.face.map((entry) => entry?.region));
  const missingRegions = FACE_REGIONS.filter((region) => !regions.has(region));
  if (missingRegions.length)
    throw persistentStateError("character_persistent_face_incomplete", {
      missingRegions,
    });
  for (const key of BODY_STATE_KEYS)
    if (typeof state[key]?.enabled !== "boolean")
      throw persistentStateError("character_persistent_body_state_invalid", {
        section: key,
      });
  return state;
}

function materializePersistentStateWindow({
  previousState,
  transition,
  turnId,
  responseId,
  sequenceId,
  now = Date.now(),
}) {
  const previous = validatePersistentState(previousState);
  if (
    !transition ||
    Number(transition.from_revision) !== Number(previous.revision)
  )
    throw persistentStateError("character_persistent_state_revision_conflict");
  const modelNext = validatePersistentState(transition.next_state);
  const current = {
    ...modelNext,
    revision: Number(previous.revision) + 1,
    source_turn_id: turnId,
    source_response_id: responseId,
    source_sequence_id: sequenceId,
    updated_at: now,
  };
  const changes = Object.fromEntries(
    STATE_SECTION_KEYS.map((section) => {
      const from = previous[section];
      const to = current[section];
      return [
        section,
        {
          changed: stable(from) !== stable(to),
          from,
          to,
        },
      ];
    })
  );
  return {
    previous_state: previous,
    transition: {
      id: `state_transition_${crypto.randomUUID().replace(/-/g, "")}`,
      from_revision: Number(previous.revision),
      to_revision: current.revision,
      style: transition.style,
      duration_ms: transition.duration_ms,
      changes,
      source_turn_id: turnId,
      source_response_id: responseId,
      source_sequence_id: sequenceId,
      created_at: now,
    },
    current_state: current,
  };
}

module.exports = {
  BODY_STATE_KEYS,
  STATE_SECTION_KEYS,
  initialPersistentState,
  materializePersistentStateWindow,
  validatePersistentState,
};
