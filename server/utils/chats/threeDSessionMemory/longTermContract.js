const RELATIONSHIP_KEYS = Object.freeze([
  "affection",
  "trust",
  "closeness",
  "comfort",
  "guardedness",
]);
const EMOTION_PERSISTENCE = Object.freeze(["transient", "short", "durable"]);
const RELATIONSHIP_V2_KEYS = Object.freeze([
  "familiarity",
  "trust",
  "comfort",
  "attachment",
  "openness",
  "physical_closeness",
]);
const ADAPTIVE_SELF_KEYS = Object.freeze([
  "openness_to_user",
  "playfulness_with_user",
  "comfort_with_user",
  "willingness_to_share",
]);
const {
  MILESTONE_TYPES,
  VALUE_KEYS,
  memoryType,
  unit,
} = require("./formationPolicy");

function initialRelationship() {
  return Object.fromEntries(RELATIONSHIP_KEYS.map((key) => [key, 0]));
}

function initialEmotion() {
  return {
    primary: "athena.core:emotion/neutral",
    secondary: null,
    intensity: 0,
    valence: 0,
    arousal: 0,
    attitude_toward_user: "neutral",
    unresolved_feelings: [],
    persistence: "transient",
    observed_at: null,
  };
}

function initialRelationshipV2() {
  return Object.fromEntries(RELATIONSHIP_V2_KEYS.map((key) => [key, 0]));
}

function initialAdaptiveSelf() {
  return Object.fromEntries(ADAPTIVE_SELF_KEYS.map((key) => [key, 0]));
}

function legacyRelationshipProjection(value = {}) {
  return {
    affection: Number(value.attachment || 0),
    trust: Number(value.trust || 0),
    closeness: Number(value.familiarity || 0),
    comfort: Number(value.comfort || 0),
    guardedness: Number((1 - Number(value.openness || 0)).toFixed(6)),
  };
}

function migrateLegacyRelationship(value = {}) {
  return {
    familiarity: Number(value.closeness || 0),
    trust: Number(value.trust || 0),
    comfort: Number(value.comfort || 0),
    attachment: Number(value.affection || 0),
    openness: Number((1 - Number(value.guardedness ?? 1)).toFixed(6)),
    physical_closeness: 0,
  };
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateRelationship(value, { delta = false } = {}) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  return RELATIONSHIP_KEYS.every((key) => {
    if (!finite(value[key])) return false;
    return delta
      ? value[key] >= -1 && value[key] <= 1
      : value[key] >= 0 && value[key] <= 1;
  });
}

function sameNumber(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 0.0001;
}

function validateVector(value, keys, { delta = false } = {}) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  if (Object.keys(value).some((key) => !keys.includes(key))) return false;
  return keys.every((key) => {
    if (!finite(value[key])) return false;
    return delta ? value[key] >= -1 && value[key] <= 1 : unit(value[key]);
  });
}

function validateTransition(transition, before, keys) {
  if (
    !transition ||
    !validateVector(transition.before, keys) ||
    !validateVector(transition.delta, keys, { delta: true }) ||
    !validateVector(transition.after, keys) ||
    (transition.narrative !== undefined &&
      typeof transition.narrative !== "string") ||
    (transition.confidence !== undefined && !unit(transition.confidence))
  )
    return false;
  return keys.every(
    (key) =>
      sameNumber(transition.before[key], before[key]) &&
      sameNumber(
        transition.after[key],
        transition.before[key] + transition.delta[key]
      )
  );
}

function validateTurnRefs(refs, allowed) {
  return (
    Array.isArray(refs) &&
    refs.length > 0 &&
    refs.every((ordinal) => Number.isInteger(ordinal) && allowed.has(ordinal))
  );
}

function validateSourceEvidence(entries, allowedEvidence) {
  return (
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.every(
      (entry) =>
        entry &&
        Number.isInteger(entry.turn_ordinal) &&
        typeof entry.evidence_hash === "string" &&
        allowedEvidence.get(entry.turn_ordinal) === entry.evidence_hash
    )
  );
}

function validateReflectionV2(
  payload,
  {
    relationshipBefore,
    adaptiveBefore,
    turnOrdinals = [],
    turnEvidence = [],
  } = {}
) {
  if (
    !payload ||
    Array.isArray(payload) ||
    payload.object !== "athena.3d_center.character_reflection" ||
    payload.protocol_version !== "2.0"
  )
    return { ok: false, code: "athena_3d_character_reflection_object_invalid" };
  const allowed = new Set(turnOrdinals);
  const allowedEvidence = new Map(
    turnEvidence.map((entry) => [entry.ordinal, entry.evidence_hash])
  );
  const reflection = payload.session_reflection;
  if (
    !reflection ||
    typeof reflection.summary !== "string" ||
    typeof reflection.first_person_summary !== "string" ||
    !Array.isArray(reflection.topics) ||
    !Array.isArray(reflection.important_turn_refs) ||
    reflection.important_turn_refs.some((ordinal) => !allowed.has(ordinal))
  )
    return {
      ok: false,
      code: "athena_3d_character_reflection_summary_invalid",
    };
  if (!Array.isArray(payload.memory_candidates))
    return { ok: false, code: "athena_3d_character_memory_candidates_invalid" };
  const keys = new Set();
  for (const candidate of payload.memory_candidates) {
    if (
      !candidate ||
      !/^[a-z0-9][a-z0-9_.-]{0,95}$/.test(candidate.candidate_key || "") ||
      keys.has(candidate.candidate_key) ||
      !memoryType(candidate.type) ||
      typeof candidate.first_person_memory !== "string" ||
      !candidate.first_person_memory.trim() ||
      typeof candidate.event_summary !== "string" ||
      !candidate.event_summary.trim() ||
      !validateTurnRefs(candidate.source_turn_refs, allowed) ||
      !validateSourceEvidence(candidate.source_evidence, allowedEvidence) ||
      candidate.source_evidence.some(
        (entry) => !candidate.source_turn_refs.includes(entry.turn_ordinal)
      ) ||
      !candidate.values ||
      !VALUE_KEYS.every((key) => unit(candidate.values[key])) ||
      !unit(candidate.confidence) ||
      !Array.isArray(candidate.tags) ||
      !["transient", "short", "durable"].includes(
        candidate.proposed_persistence
      )
    )
      return {
        ok: false,
        code: "athena_3d_character_memory_candidate_invalid",
      };
    keys.add(candidate.candidate_key);
  }
  if (!Array.isArray(payload.user_model_updates))
    return {
      ok: false,
      code: "athena_3d_character_user_model_updates_invalid",
    };
  for (const update of payload.user_model_updates)
    if (
      !update ||
      !keys.has(update.candidate_key) ||
      typeof update.observation !== "string" ||
      typeof update.first_person_interpretation !== "string" ||
      !validateTurnRefs(update.source_turn_refs, allowed) ||
      !validateSourceEvidence(update.source_evidence, allowedEvidence) ||
      update.source_evidence.some(
        (entry) => !update.source_turn_refs.includes(entry.turn_ordinal)
      ) ||
      !unit(update.confidence) ||
      !["observe", "reinforce", "contradict"].includes(update.mode)
    )
      return {
        ok: false,
        code: "athena_3d_character_user_model_update_invalid",
      };
  if (
    !validateTransition(
      payload.relationship_transition,
      relationshipBefore,
      RELATIONSHIP_V2_KEYS
    )
  )
    return { ok: false, code: "athena_3d_character_relationship_v2_invalid" };
  if (
    !validateTransition(
      payload.adaptive_self_transition,
      adaptiveBefore,
      ADAPTIVE_SELF_KEYS
    )
  )
    return { ok: false, code: "athena_3d_character_adaptive_self_invalid" };
  if (!Array.isArray(payload.growth_candidates))
    return { ok: false, code: "athena_3d_character_growth_candidates_invalid" };
  for (const growth of payload.growth_candidates)
    if (
      !growth ||
      typeof growth.type !== "string" ||
      typeof growth.first_person_summary !== "string" ||
      !Array.isArray(growth.source_memory_candidate_keys) ||
      growth.source_memory_candidate_keys.length === 0 ||
      growth.source_memory_candidate_keys.some((key) => !keys.has(key)) ||
      !unit(growth.confidence)
    )
      return {
        ok: false,
        code: "athena_3d_character_growth_candidate_invalid",
      };
  if (!Array.isArray(payload.emotional_milestone_candidates))
    return { ok: false, code: "athena_3d_character_milestones_invalid" };
  for (const milestone of payload.emotional_milestone_candidates)
    if (
      !milestone ||
      !MILESTONE_TYPES.includes(milestone.type) ||
      typeof milestone.first_person_memory !== "string" ||
      !Array.isArray(milestone.source_memory_candidate_keys) ||
      milestone.source_memory_candidate_keys.length === 0 ||
      milestone.source_memory_candidate_keys.some((key) => !keys.has(key)) ||
      !unit(milestone.emotional_value) ||
      !unit(milestone.relationship_value) ||
      !unit(milestone.character_impact) ||
      !unit(milestone.confidence)
    )
      return { ok: false, code: "athena_3d_character_milestone_invalid" };
  const legacyShape = {
    object: "athena.3d_center.character_memory",
    protocol_version: "1.0",
    conversation_memory: {
      summary: reflection.summary,
      topics: reflection.topics,
      facts: [],
      preferences: [],
      promises: [],
      open_threads: [],
      important_turn_refs: reflection.important_turn_refs,
    },
    relationship_transition: {
      before: initialRelationship(),
      delta: initialRelationship(),
      after: initialRelationship(),
      narrative: "v2 reflection",
      confidence: 1,
    },
    final_emotion: payload.final_emotion,
    state_interpretation: payload.state_interpretation,
  };
  const tail = validateConsolidation(
    legacyShape,
    initialRelationship(),
    turnOrdinals
  );
  if (!tail.ok)
    return {
      ok: false,
      code: tail.code.replace("long_term", "character_reflection"),
    };
  return { ok: true, value: payload };
}

function validEvidenceEntries(entries, allowedOrdinals) {
  return entries.every(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.text === "string" &&
      entry.text.trim() &&
      Array.isArray(entry.turn_refs) &&
      entry.turn_refs.length > 0 &&
      entry.turn_refs.every(
        (ordinal) => Number.isInteger(ordinal) && allowedOrdinals.has(ordinal)
      )
  );
}

function validateConsolidation(payload, expectedBefore, turnOrdinals = []) {
  if (
    !payload ||
    Array.isArray(payload) ||
    payload.object !== "athena.3d_center.character_memory" ||
    payload.protocol_version !== "1.0"
  )
    return { ok: false, code: "athena_3d_long_term_memory_object_invalid" };
  const memory = payload.conversation_memory;
  if (
    !memory ||
    typeof memory.summary !== "string" ||
    ![
      "topics",
      "facts",
      "preferences",
      "promises",
      "open_threads",
      "important_turn_refs",
    ].every((key) => Array.isArray(memory[key]))
  )
    return { ok: false, code: "athena_3d_long_term_memory_summary_invalid" };
  const allowedOrdinals = new Set(turnOrdinals);
  if (
    !memory.topics.every((entry) => typeof entry === "string") ||
    !["facts", "preferences", "promises", "open_threads"].every((key) =>
      validEvidenceEntries(memory[key], allowedOrdinals)
    ) ||
    !memory.important_turn_refs.every(
      (ordinal) => Number.isInteger(ordinal) && allowedOrdinals.has(ordinal)
    )
  )
    return { ok: false, code: "athena_3d_long_term_memory_evidence_invalid" };
  const transition = payload.relationship_transition;
  if (
    !transition ||
    !validateRelationship(transition.before) ||
    !validateRelationship(transition.delta, { delta: true }) ||
    !validateRelationship(transition.after) ||
    typeof transition.narrative !== "string" ||
    !unit(transition.confidence)
  )
    return { ok: false, code: "athena_3d_long_term_relationship_invalid" };
  for (const key of RELATIONSHIP_KEYS) {
    if (!sameNumber(transition.before[key], expectedBefore[key]))
      return {
        ok: false,
        code: "athena_3d_long_term_relationship_before_conflict",
      };
    if (
      !sameNumber(
        transition.after[key],
        transition.before[key] + transition.delta[key]
      )
    )
      return {
        ok: false,
        code: "athena_3d_long_term_relationship_math_invalid",
      };
  }
  const emotion = payload.final_emotion;
  if (
    !emotion ||
    typeof emotion.primary !== "string" ||
    !(emotion.secondary === null || typeof emotion.secondary === "string") ||
    !unit(emotion.intensity) ||
    !finite(emotion.valence) ||
    emotion.valence < -1 ||
    emotion.valence > 1 ||
    !unit(emotion.arousal) ||
    typeof emotion.attitude_toward_user !== "string" ||
    !Array.isArray(emotion.unresolved_feelings) ||
    !EMOTION_PERSISTENCE.includes(emotion.persistence)
  )
    return { ok: false, code: "athena_3d_long_term_emotion_invalid" };
  const interpretation = payload.state_interpretation;
  if (
    !interpretation ||
    ![
      "facial_signal",
      "gaze_signal",
      "body_signal",
      "action_signal",
      "social_meaning",
    ].every((key) => typeof interpretation[key] === "string") ||
    !Array.isArray(interpretation.evidence_paths)
  )
    return {
      ok: false,
      code: "athena_3d_long_term_state_interpretation_invalid",
    };
  return { ok: true, value: payload };
}

function decayedEmotion(emotion, now = Date.now()) {
  if (!emotion || !emotion.observed_at) return emotion || initialEmotion();
  const halfLives = {
    transient: 30 * 60 * 1000,
    short: 6 * 60 * 60 * 1000,
    durable: 7 * 24 * 60 * 60 * 1000,
  };
  const elapsed = Math.max(0, now - Number(emotion.observed_at));
  const factor = Math.pow(0.5, elapsed / halfLives[emotion.persistence]);
  return {
    ...emotion,
    intensity: Number((Number(emotion.intensity || 0) * factor).toFixed(4)),
    valence: Number((Number(emotion.valence || 0) * factor).toFixed(4)),
    arousal: Number((Number(emotion.arousal || 0) * factor).toFixed(4)),
    decay_factor: Number(factor.toFixed(4)),
  };
}

module.exports = {
  ADAPTIVE_SELF_KEYS,
  EMOTION_PERSISTENCE,
  RELATIONSHIP_KEYS,
  RELATIONSHIP_V2_KEYS,
  decayedEmotion,
  initialAdaptiveSelf,
  initialEmotion,
  initialRelationship,
  initialRelationshipV2,
  legacyRelationshipProjection,
  migrateLegacyRelationship,
  validateConsolidation,
  validateReflectionV2,
  validateRelationship,
  validateVector,
};
