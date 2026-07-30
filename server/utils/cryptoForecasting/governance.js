const GOVERNANCE_STATES = Object.freeze([
  "candidate",
  "offline_validated",
  "shadow",
  "paper_eligible",
  "active",
  "degraded",
  "suspended",
  "retired",
]);

function evaluateGovernanceState({
  currentState = "candidate",
  offlineValidated = false,
  shadowDays = 0,
  requiredShadowDays = 30,
  paperEligible = false,
  activationApproved = false,
  contracts = {},
  drift = {},
  online = {},
  supportingCoverage = {},
} = {}) {
  if (!GOVERNANCE_STATES.includes(currentState))
    throw new Error("invalid_governance_state");
  if (currentState === "retired")
    return { state: "retired", blockers: ["model_retired"] };
  const blockers = [];
  for (const [name, valid] of Object.entries({
    marketTime: contracts.marketTime !== false,
    registry: contracts.registry !== false,
    featureOrder: contracts.featureOrder !== false,
    pythonNodeParity: contracts.pythonNodeParity !== false,
    datasetSignature: contracts.datasetSignature !== false,
    modelSignature: contracts.modelSignature !== false,
    calibrationSignature: contracts.calibrationSignature !== false,
  }))
    if (!valid) blockers.push(`${name}_contract_failed`);
  if (
    supportingCoverage.required === true &&
    supportingCoverage.passed !== true
  )
    blockers.push("required_supporting_evidence_coverage_failed");
  const settled = Number(online.settledSamples || 0);
  if (settled >= 200) {
    if (Number(online.ece) > 0.08) blockers.push("online_ece_exceeded");
    if (Number(online.brierSkill) <= 0)
      blockers.push("online_brier_skill_non_positive");
    if (Number(online.meanNetReturn) < 0)
      blockers.push("online_cost_adjusted_expectation_negative");
  }
  const psi = Number(drift.psi || 0);
  if (psi >= 0.3) blockers.push("psi_critical");
  if (blockers.length) return { state: "suspended", blockers };
  if (psi >= 0.2) return { state: "degraded", blockers: ["psi_warning"] };
  if (!offlineValidated)
    return { state: "candidate", blockers: ["offline_validation_pending"] };
  if (Number(shadowDays) < Number(requiredShadowDays))
    return { state: "shadow", blockers: ["shadow_duration_insufficient"] };
  if (!paperEligible)
    return { state: "shadow", blockers: ["paper_eligibility_failed"] };
  if (!activationApproved)
    return {
      state: "paper_eligible",
      blockers: ["human_activation_required"],
    };
  return { state: "active", blockers: [] };
}

module.exports = {
  GOVERNANCE_STATES,
  evaluateGovernanceState,
};
