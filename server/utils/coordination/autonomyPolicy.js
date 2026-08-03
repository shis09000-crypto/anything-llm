const AUTONOMY_LEVELS = Object.freeze({
  OBSERVE: 0,
  SELF_HEAL: 1,
  COORDINATED_ISOLATION: 2,
  APPROVED_RECOVERY: 3,
  DUAL_APPROVAL_CONTROL: 4,
});

function policyError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = 409;
  error.details = details;
  return error;
}

function levelEvidence(evidence = [], level) {
  return evidence.filter((entry) => Number(entry?.level) === Number(level));
}

function exhausted(evidence = [], level) {
  const attempts = levelEvidence(evidence, level);
  return (
    attempts.length > 0 &&
    attempts.some(
      (entry) =>
        entry.status === "exhausted" &&
        entry.validation === "failed" &&
        String(entry.evidenceRef || "")
    )
  );
}

function successful(evidence = [], level) {
  return levelEvidence(evidence, level).some(
    (entry) => entry.status === "succeeded" || entry.validation === "passed"
  );
}

function evaluateEscalation({
  currentLevel = 0,
  targetLevel,
  evidence = [],
  phase = "propose",
  approvalCount = 0,
  moduleFailureMode = "isolated-degraded",
} = {}) {
  const target = Number(targetLevel);
  const current = Number(currentLevel);
  const reasons = [];
  if (!Number.isInteger(target) || target < 0 || target > 4)
    reasons.push("autonomy_level_invalid");
  if (target > current + 1) reasons.push("autonomy_level_skip_denied");
  if (target >= 2 && !exhausted(evidence, 1))
    reasons.push("self_heal_not_exhausted");
  if (target >= 3 && !exhausted(evidence, 2))
    reasons.push("coordinated_isolation_not_exhausted");
  if (target >= 2 && (successful(evidence, 1) || successful(evidence, 2)))
    reasons.push("lower_level_recovery_succeeded");
  if (
    target === AUTONOMY_LEVELS.COORDINATED_ISOLATION &&
    moduleFailureMode !== "isolated-degraded"
  )
    reasons.push("module_not_isolatable");
  if (phase === "execute" && target === 3 && approvalCount < 1)
    reasons.push("operations_approval_required");
  if (phase === "execute" && target === 4 && approvalCount < 2)
    reasons.push("dual_approval_required");
  return {
    allowed: reasons.length === 0,
    currentLevel: current,
    targetLevel: target,
    phase,
    approvalRequired: target >= 3,
    requiredApprovals: target >= 4 ? 2 : target >= 3 ? 1 : 0,
    reasons,
  };
}

function assertEscalation(input = {}) {
  const decision = evaluateEscalation(input);
  if (!decision.allowed) throw policyError(decision.reasons[0], { decision });
  return decision;
}

module.exports = {
  AUTONOMY_LEVELS,
  assertEscalation,
  evaluateEscalation,
  exhausted,
  successful,
};
