const crypto = require("crypto");
const { PROTOCOL_VERSION } = require("../v2/constants");

const CONVERSATION_STATUSES = Object.freeze([
  "created",
  "active",
  "awaiting_user",
  "close_ready",
  "soft_closing",
  "soft_closed",
  "suspended",
  "resuming",
  "closing",
  "ended",
  "cancelled",
  "failed",
]);
const HANDOFF_MODES = Object.freeze([
  "question",
  "open",
  "passive",
  "close_ready",
]);
const HORIZON_DEPTHS = Object.freeze(["brief", "normal", "extended"]);
const DEFAULT_WAIT_MS = Object.freeze({
  brief: 8_000,
  normal: 20_000,
  extended: 45_000,
});
const WAIT_MIN_MS = 3_000;
const WAIT_MAX_MS = 120_000;
const END_INTENT_KINDS = Object.freeze([
  "none",
  "explicit_departure",
  "explicit_stop",
  "user_action",
]);
const PERFORMANCE_STATES = Object.freeze([
  "listening",
  "thinking",
  "speaking",
  "conversation_idle",
  "close_ready",
  "soft_closed",
  "ambient",
  "closing",
  "resuming",
]);

function conversationError(code, httpStatus = 400, details = null) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  if (details) error.details = details;
  return error;
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unit(value) {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function responseSpeechText(response) {
  const speechTrack = response?.output
    ?.find((item) => item?.type === "performance_sequence")
    ?.tracks?.find((track) => track?.name === "speech");
  return (speechTrack?.cues || [])
    .map((cue) => String(cue?.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function endsWithExplicitQuestion(response) {
  return /[?？][”’"']?\s*$/u.test(responseSpeechText(response));
}

function initialCharacterState(previousActivity = "ambient_idle") {
  return {
    revision: 0,
    affect: {
      primary: "athena.core:emotion/neutral",
      secondary: null,
      intensity: 0.15,
      valence: 0,
      arousal: 0.15,
    },
    attention: { target: "player", intensity: 0.45 },
    gaze: { target: "player", style: "neutral" },
    posture: "conversation_ready",
    activity: { current: "conversation", previous: previousActivity },
    performance_state: "listening",
    decay: { mode: "hold", target: "soft_neutral", duration_ms: 0 },
    source_turn_id: null,
    updated_at: Date.now(),
  };
}

function validateCreateConversationRequest(body = {}) {
  if (body.protocol_version !== PROTOCOL_VERSION)
    throw conversationError("character_conversation_protocol_invalid");
  if (!isObject(body.character))
    throw conversationError("character_conversation_character_required");
  if (!isObject(body.generation))
    throw conversationError("character_conversation_generation_required");
  const previousActivity = String(body.previous_activity || "ambient_idle");
  if (!previousActivity || previousActivity.length > 160)
    throw conversationError("character_conversation_activity_invalid");
  return {
    protocol_version: PROTOCOL_VERSION,
    character: body.character,
    generation: body.generation,
    previous_activity: previousActivity,
    metadata: isObject(body.metadata) ? body.metadata : {},
    memory:
      isObject(body.memory) && body.memory.mode === "persistent"
        ? { mode: "persistent", recall: "profile_state_relevant" }
        : { mode: "ephemeral", recall: "none" },
    athena: isObject(body.athena) ? body.athena : {},
  };
}

function validateTurnInput(body = {}) {
  if (!Array.isArray(body.input) || body.input.length === 0)
    throw conversationError("character_turn_input_required");
  const idempotencyKey = String(
    body.idempotency_key || body.athena?.idempotencyKey || ""
  ).trim();
  if (!idempotencyKey)
    throw conversationError("character_turn_idempotency_key_required");
  return {
    input: body.input,
    idempotencyKey,
    contextRefPresent: Object.prototype.hasOwnProperty.call(body, "context_ref"),
    contextRef: body.context_ref ?? null,
    athena: isObject(body.athena) ? body.athena : {},
  };
}

function validateStateTransition(value, currentRevision) {
  if (!isObject(value))
    throw conversationError("character_state_transition_required", 502);
  if (value.from_revision !== currentRevision)
    throw conversationError("character_state_revision_conflict", 409, {
      expected: currentRevision,
      received: value.from_revision,
    });
  if (
    !isObject(value.affect) ||
    !unit(value.affect.intensity) ||
    !unit(value.affect.arousal) ||
    typeof value.affect.valence !== "number" ||
    value.affect.valence < -1 ||
    value.affect.valence > 1
  )
    throw conversationError("character_state_affect_invalid", 502);
  if (!isObject(value.attention) || !unit(value.attention.intensity))
    throw conversationError("character_state_attention_invalid", 502);
  if (!isObject(value.gaze) || !String(value.gaze.target || "").trim())
    throw conversationError("character_state_gaze_invalid", 502);
  if (!isObject(value.activity) || !String(value.activity.current || "").trim())
    throw conversationError("character_state_activity_invalid", 502);
  if (!isObject(value.decay) || !Number.isInteger(value.decay.duration_ms))
    throw conversationError("character_state_decay_invalid", 502);
  if (!PERFORMANCE_STATES.includes(value.performance_state))
    throw conversationError("character_state_performance_state_invalid", 502);
  return value;
}

function normalizeConversationControl(
  payload,
  { currentState, response, forceEnd = false } = {}
) {
  const horizon = payload?.conversation_horizon;
  const handoff = payload?.handoff;
  const endIntent = payload?.end_intent;
  if (!isObject(horizon) || !HORIZON_DEPTHS.includes(horizon.depth))
    throw conversationError("conversation_horizon_invalid", 502);
  if (
    !unit(horizon.continuation_probability) ||
    !unit(horizon.closure_readiness)
  )
    throw conversationError("conversation_horizon_probability_invalid", 502);
  if (
    !isObject(handoff) ||
    handoff.target !== "user" ||
    !HANDOFF_MODES.includes(handoff.mode)
  )
    throw conversationError("character_handoff_invalid", 502);
  if (
    !isObject(endIntent) ||
    typeof endIntent.detected !== "boolean" ||
    !unit(endIntent.confidence) ||
    !END_INTENT_KINDS.includes(endIntent.kind)
  )
    throw conversationError("character_end_intent_invalid", 502);
  const transition = validateStateTransition(
    payload.character_state_transition,
    Number(currentState.revision || 0)
  );
  const modelWait = horizon.soft_close_wait_ms;
  const modelWaitValid =
    Number.isInteger(modelWait) &&
    modelWait >= WAIT_MIN_MS &&
    modelWait <= WAIT_MAX_MS;
  const softCloseTiming = {
    model_wait_ms: modelWait ?? null,
    effective_wait_ms: modelWaitValid
      ? modelWait
      : DEFAULT_WAIT_MS[horizon.depth],
    source: modelWaitValid ? "model" : "depth_default",
    depth: horizon.depth,
  };
  const warnings = [];
  if (!modelWaitValid && handoff.mode === "close_ready")
    warnings.push({
      code: "soft_close_wait_defaulted",
      message: `Invalid model wait; used ${horizon.depth} depth default.`,
      model_wait_ms: modelWait ?? null,
      effective_wait_ms: softCloseTiming.effective_wait_ms,
    });

  const explicitEnd =
    forceEnd || (endIntent.detected === true && endIntent.confidence >= 0.85);
  let effectiveHandoff = { ...handoff };
  let outcome = "awaiting_user";
  if (explicitEnd) {
    effectiveHandoff = null;
    outcome = "ended";
  } else if (
    endsWithExplicitQuestion(response) &&
    handoff.mode !== "question"
  ) {
    effectiveHandoff = { target: "user", mode: "question" };
    warnings.push({
      code: "handoff_question_normalized",
      message:
        "Runtime kept the conversation awaiting the user because the generated speech ends with an explicit question.",
      model_handoff: handoff,
    });
  } else if (handoff.mode === "close_ready") {
    const gatePassed =
      horizon.closure_readiness >= 0.8 &&
      horizon.continuation_probability <= 0.35 &&
      response?.safety_assessment === "normal";
    if (gatePassed) outcome = "close_ready";
    else {
      effectiveHandoff = { target: "user", mode: "passive" };
      warnings.push({
        code: "close_ready_gate_rejected",
        message:
          "Runtime kept the conversation open because the soft-close gate was not satisfied.",
      });
    }
  }
  return {
    conversation_horizon: horizon,
    model_handoff: handoff,
    effective_handoff: effectiveHandoff,
    end_intent: endIntent,
    state_transition: transition,
    soft_close_timing: softCloseTiming,
    outcome,
    warnings,
  };
}

function materializeNextState(transition, currentState, turnId) {
  return {
    revision: Number(currentState.revision || 0) + 1,
    affect: transition.affect,
    attention: transition.attention,
    gaze: transition.gaze,
    posture: transition.posture,
    activity: transition.activity,
    performance_state: transition.performance_state,
    decay: transition.decay,
    source_turn_id: turnId,
    updated_at: Date.now(),
  };
}

module.exports = {
  CONVERSATION_STATUSES,
  DEFAULT_WAIT_MS,
  END_INTENT_KINDS,
  HANDOFF_MODES,
  HORIZON_DEPTHS,
  PERFORMANCE_STATES,
  WAIT_MAX_MS,
  WAIT_MIN_MS,
  conversationError,
  id,
  initialCharacterState,
  materializeNextState,
  normalizeConversationControl,
  responseSpeechText,
  validateCreateConversationRequest,
  validateTurnInput,
};
