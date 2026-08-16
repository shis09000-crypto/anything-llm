const PROTOCOL_VERSION = "1.0";
const RESPONSE_OBJECT = "character.response";
const MANIFEST_OBJECT = "athena.character.capability_manifest";

const CAPABILITY_ID_PATTERN =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*:[a-z][a-z0-9_-]*\/[a-z][a-z0-9_.-]*$/;
const NAMESPACE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const RESPONSE_STATUSES = Object.freeze([
  "queued",
  "in_progress",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
]);
const ITEM_STATUSES = Object.freeze([
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);
const TERMINAL_RESPONSE_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
]);
const TERMINAL_ITEM_STATUSES = new Set(["completed", "failed", "cancelled"]);
const OUTPUT_ITEM_TYPES = Object.freeze([
  "performance_intent",
  "expression",
  "gaze",
  "gesture",
  "posture",
  "action",
  "speech",
  "extension",
]);
const INPUT_ITEM_TYPES = Object.freeze([
  "user_message",
  "world_event",
  "interaction_prediction",
]);
const RESPONSE_EVENT_TYPES = Object.freeze([
  "character.response.created",
  "character.response.in_progress",
  "character.response.output_item.added",
  "character.response.output_item.delta",
  "character.response.output_item.updated",
  "character.response.output_item.done",
  "character.response.output_item.failed",
  "character.response.output_item.cancelled",
  "character.response.completed",
  "character.response.incomplete",
  "character.response.failed",
  "character.response.cancelled",
  "character.error",
  "character.stream.ping",
]);

const ITEM_CAPABILITY_FIELDS = Object.freeze({
  expression: "expression",
  gesture: "gesture",
  posture: "posture",
  action: "action",
});

const FORBIDDEN_SEMANTIC_KEYS = new Set([
  "provider",
  "api_key",
  "tts_provider",
  "animation_montage",
  "montage",
  "skeleton",
  "bone",
  "bones",
  "morph_target",
  "morph_targets",
  "control_rig",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validationError(code, path, message, details = {}) {
  return { code, path, message, details };
}

function validationResult(errors, value = null) {
  return {
    ok: errors.length === 0,
    errors,
    ...(errors.length === 0 && value !== null ? { value } : {}),
  };
}

module.exports = {
  CAPABILITY_ID_PATTERN,
  FORBIDDEN_SEMANTIC_KEYS,
  INPUT_ITEM_TYPES,
  ITEM_CAPABILITY_FIELDS,
  ITEM_STATUSES,
  MANIFEST_OBJECT,
  NAMESPACE_PATTERN,
  OUTPUT_ITEM_TYPES,
  PROTOCOL_VERSION,
  RESPONSE_EVENT_TYPES,
  RESPONSE_OBJECT,
  RESPONSE_STATUSES,
  SEMVER_PATTERN,
  SHA256_PATTERN,
  TERMINAL_ITEM_STATUSES,
  TERMINAL_RESPONSE_STATUSES,
  isPlainObject,
  validationError,
  validationResult,
};
