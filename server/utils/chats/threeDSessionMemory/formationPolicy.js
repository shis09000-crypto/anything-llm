const MEMORY_TYPES = Object.freeze([
  "user_understanding",
  "shared_event",
  "relationship_event",
  "emotional_event",
  "growth_event",
  "habit",
  "promise",
  "conflict",
  "repair",
  "shared_goal",
]);
const MILESTONE_TYPES = Object.freeze([
  "first_deep_trust",
  "first_active_expectation",
  "major_conflict",
  "deep_disappointment",
  "meaningful_repair",
]);
const VALUE_KEYS = Object.freeze([
  "information_value",
  "relationship_value",
  "emotional_value",
  "future_relevance",
  "uniqueness",
  "repetition",
  "character_impact",
]);
const STRONG_TYPES = new Set(["promise", "conflict", "repair", "shared_goal"]);

function unit(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function memoryType(value) {
  const type = String(value || "");
  return (
    MEMORY_TYPES.includes(type) ||
    /^[a-z0-9][a-z0-9_.-]+:[a-z0-9][a-z0-9_.-]*$/.test(type)
  );
}

function evaluateCandidate(candidate) {
  if (!candidate || !memoryType(candidate.type))
    return { accepted: false, reason: "type_invalid" };
  if (!unit(candidate.confidence) || candidate.confidence < 0.75)
    return { accepted: false, reason: "confidence_below_policy" };
  if (
    !candidate.values ||
    !VALUE_KEYS.every((key) => unit(candidate.values[key]))
  )
    return { accepted: false, reason: "values_invalid" };
  const values = candidate.values;
  const qualifyingDimensions = VALUE_KEYS.filter(
    (key) => values[key] >= 0.55
  ).length;
  const keyDimension =
    values.information_value >= 0.75 ||
    values.relationship_value >= 0.65 ||
    values.emotional_value >= 0.7 ||
    values.future_relevance >= 0.7 ||
    values.character_impact >= 0.65;
  const distinctive = values.uniqueness >= 0.45 || values.repetition >= 0.6;
  if (qualifyingDimensions < 2)
    return { accepted: false, reason: "insufficient_value_dimensions" };
  if (!keyDimension && !STRONG_TYPES.has(candidate.type))
    return { accepted: false, reason: "key_value_below_policy" };
  if (!distinctive)
    return { accepted: false, reason: "uniqueness_or_repetition_below_policy" };
  return { accepted: true, reason: null };
}

function highImpact(candidates = []) {
  return candidates.some((candidate) => {
    const values = candidate.values || {};
    return (
      candidate.confidence >= 0.85 &&
      [
        values.information_value,
        values.relationship_value,
        values.emotional_value,
        values.future_relevance,
        values.character_impact,
      ].some((value) => Number(value || 0) >= 0.85)
    );
  });
}

function capFor(kind, candidates) {
  if (kind === "relationship") return highImpact(candidates) ? 0.08 : 0.03;
  return highImpact(candidates) ? 0.05 : 0.02;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value || 0)));
}

function effectiveTransition({ transition, before, keys, kind, accepted }) {
  const cap = accepted.length ? capFor(kind, accepted) : 0;
  const delta = Object.fromEntries(
    keys.map((key) => [
      key,
      Number(clamp(transition.delta[key], -cap, cap).toFixed(6)),
    ])
  );
  const after = Object.fromEntries(
    keys.map((key) => [
      key,
      Number(clamp(Number(before[key]) + delta[key], 0, 1).toFixed(6)),
    ])
  );
  return { before, delta, after, cap, model_delta: transition.delta };
}

module.exports = {
  MEMORY_TYPES,
  MILESTONE_TYPES,
  VALUE_KEYS,
  capFor,
  effectiveTransition,
  evaluateCandidate,
  highImpact,
  memoryType,
  unit,
};
