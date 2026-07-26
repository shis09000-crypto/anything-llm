const ACTIVE_STATUSES = new Set([
  "awaiting_approval",
  "approved",
  "canary_running",
  "canary_validating",
  "executing",
  "validating",
  "rollback_running",
  "reconciliation_required",
]);

function actionsEnabled(env = process.env) {
  return (
    String(env.ATHENA_OPERATIONS_ACTIONS_ENABLED || "false").toLowerCase() ===
    "true"
  );
}

function evaluateProposal({ definition, requestedByType = "human", env }) {
  const reasons = [];
  if (!actionsEnabled(env)) reasons.push("operations_actions_disabled");
  if (!definition) reasons.push("action_not_cataloged");
  if (!["human", "agent"].includes(String(requestedByType)))
    reasons.push("invalid_requester_type");
  return {
    decision: reasons.length ? "deny" : "allow",
    reasons,
    mode: "default-deny",
    requiredPermission: definition?.requiredPermission || null,
    requiredApprovals: Number(definition?.requiredApprovals || 0),
    dryRunRequired: definition?.dryRun === "required",
    canaryRequired: Boolean(definition?.canary),
    agentMayPropose: true,
    agentMayApprove: false,
    agentMayExecute: false,
  };
}

function assertHumanControl(actorType) {
  if (String(actorType) !== "human") {
    const error = new Error("operations_human_control_required");
    error.code = "operations_human_control_required";
    throw error;
  }
}

function assertActorPermission(actor = {}, requiredPermission = "admin") {
  if (actor.type === "agent") return;
  if (
    requiredPermission === "admin" &&
    !["admin", "owner"].includes(String(actor.role || ""))
  ) {
    const error = new Error("operations_admin_permission_required");
    error.code = "operations_admin_permission_required";
    throw error;
  }
}

function approvalDecision({ policy, approvals = [] }) {
  if (approvals.some((entry) => entry.decision === "rejected"))
    return { ready: false, rejected: true, approvals: 0 };
  const approvedBy = new Set(
    approvals
      .filter((entry) => entry.decision === "approved")
      .map((entry) => Number(entry.approverUserId))
  );
  return {
    ready: approvedBy.size >= Number(policy?.requiredApprovals || 1),
    rejected: false,
    approvals: approvedBy.size,
  };
}

function sameScope(left = {}, right = {}) {
  return (
    left.type === right.type &&
    JSON.stringify([...(left.ids || [])].sort()) ===
      JSON.stringify([...(right.ids || [])].sort())
  );
}

function conflictingRun(existingRuns = [], scope = {}) {
  return (
    existingRuns.find(
      (run) => ACTIVE_STATUSES.has(run.status) && sameScope(run.scope, scope)
    ) || null
  );
}

module.exports = {
  ACTIVE_STATUSES,
  actionsEnabled,
  approvalDecision,
  assertActorPermission,
  assertHumanControl,
  conflictingRun,
  evaluateProposal,
  sameScope,
};
