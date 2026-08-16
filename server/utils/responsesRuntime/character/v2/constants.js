const PROTOCOL_VERSION = "2.0";
const RESPONSE_OBJECT = "character.response";
const MANIFEST_OBJECT = "athena.character.capability_manifest";
const PERFORMANCE_PROFILE = "athena.cold_tsundere.expressive.v2";
const FLASH_MODEL = "deepseek-v4-flash";

const PHASE_ORDER = Object.freeze([
  "reaction",
  "orientation",
  "delivery",
  "recovery",
]);

const TRACK_ORDER = Object.freeze([
  "face",
  "gaze",
  "head_neck",
  "shoulders",
  "torso",
  "left_arm",
  "right_arm",
  "left_hand",
  "right_hand",
  "left_leg",
  "right_leg",
  "action",
  "speech",
]);

const FACE_REGIONS = Object.freeze([
  "brow",
  "eyelid",
  "eye_shape",
  "pupil",
  "cheek",
  "nose",
  "lip",
  "jaw",
]);

const PAIRED_FACE_REGIONS = new Set([
  "brow",
  "eyelid",
  "eye_shape",
  "pupil",
  "cheek",
]);

const EASINGS = Object.freeze([
  "cut",
  "linear",
  "ease_in",
  "ease_out",
  "ease_in_out",
  "blend",
]);
const SIDES = Object.freeze(["left", "right", "both", "center"]);
const AMPLITUDES = Object.freeze(["micro", "small", "medium", "large"]);
const INTERRUPTIBILITIES = Object.freeze([
  "immediate",
  "blend_out",
  "at_boundary",
  "finish",
]);
const SOURCES = Object.freeze([
  "runtime_default",
  "local_reaction",
  "main_agent",
  "high_priority_event",
]);

const CAPABILITY_ID_PATTERN =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*:[a-z][a-z0-9_-]*\/[a-z][a-z0-9_.-]*$/;
const FORBIDDEN_KEYS = new Set([
  "provider",
  "api_key",
  "animation_montage",
  "montage",
  "skeleton",
  "bone",
  "bones",
  "morph_target",
  "morph_targets",
  "control_rig",
  "joint_angle",
  "rotation_quaternion",
  "ue5",
]);

module.exports = {
  AMPLITUDES,
  CAPABILITY_ID_PATTERN,
  EASINGS,
  FACE_REGIONS,
  FLASH_MODEL,
  FORBIDDEN_KEYS,
  INTERRUPTIBILITIES,
  MANIFEST_OBJECT,
  PAIRED_FACE_REGIONS,
  PERFORMANCE_PROFILE,
  PHASE_ORDER,
  PROTOCOL_VERSION,
  RESPONSE_OBJECT,
  SIDES,
  SOURCES,
  TRACK_ORDER,
};
