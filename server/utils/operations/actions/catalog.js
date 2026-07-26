const ACTION_IDS = Object.freeze({
  REQUEUE_FAILED_TASKS: "sync.failed_tasks.requeue",
  REFRESH_SECURITY_CACHE: "security.auth_cache.refresh",
  RESTART_STATELESS_WORKER: "runtime.stateless_worker.restart",
  REBUILD_WORKSPACE_INDEX: "knowledge.workspace_index.rebuild",
});

function actionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function boundedIntegerList(values, { minimum = 1, maximum = 100 } = {}) {
  const result = [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= minimum)
    ),
  ];
  if (!result.length || result.length > maximum)
    throw actionError("operations_action_invalid_integer_list");
  return result;
}

function boundedIdList(values, maximum = 100) {
  const result = [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter((value) => /^[A-Za-z0-9_.:-]{1,160}$/.test(value))
    ),
  ];
  if (result.length > maximum)
    throw actionError("operations_action_too_many_targets");
  return result;
}

const definitions = Object.freeze({
  [ACTION_IDS.REQUEUE_FAILED_TASKS]: Object.freeze({
    id: ACTION_IDS.REQUEUE_FAILED_TASKS,
    version: "1.0",
    title: "Requeue failed synchronization tasks",
    riskLevel: "low",
    requiredPermission: "admin",
    requiredApprovals: 1,
    dryRun: "required",
    canary: "single-task",
    rollback: "restore-undispatched-dead-letter",
    sanitize(parameters = {}) {
      return { seqs: boundedIntegerList(parameters.seqs) };
    },
    scope(parameters) {
      return { type: "sync-outbox", ids: parameters.seqs.map(String) };
    },
  }),
  [ACTION_IDS.REFRESH_SECURITY_CACHE]: Object.freeze({
    id: ACTION_IDS.REFRESH_SECURITY_CACHE,
    version: "1.0",
    title: "Refresh authoritative authentication cache",
    riskLevel: "low",
    requiredPermission: "admin",
    requiredApprovals: 1,
    dryRun: "required",
    canary: "single-session-or-authority-probe",
    rollback: "authoritative-repopulation",
    sanitize(parameters = {}) {
      return { sessionIds: boundedIdList(parameters.sessionIds) };
    },
    scope(parameters) {
      return {
        type: "auth-session-cache",
        ids: parameters.sessionIds.length ? parameters.sessionIds : ["all"],
      };
    },
  }),
  [ACTION_IDS.RESTART_STATELESS_WORKER]: Object.freeze({
    id: ACTION_IDS.RESTART_STATELESS_WORKER,
    version: "1.0",
    title: "Restart an allowlisted stateless worker",
    riskLevel: "low",
    requiredPermission: "admin",
    requiredApprovals: 1,
    dryRun: "required",
    canary: "single-worker",
    rollback: "ensure-worker-running",
    sanitize(parameters = {}) {
      const workerId = String(parameters.workerId || "").trim();
      if (!["sync-v2-outbox", "workspace-cognition"].includes(workerId))
        throw actionError("operations_worker_not_allowlisted");
      return { workerId };
    },
    scope(parameters) {
      return { type: "stateless-worker", ids: [parameters.workerId] };
    },
  }),
  [ACTION_IDS.REBUILD_WORKSPACE_INDEX]: Object.freeze({
    id: ACTION_IDS.REBUILD_WORKSPACE_INDEX,
    version: "1.0",
    title: "Rebuild one workspace knowledge index",
    riskLevel: "medium",
    requiredPermission: "admin",
    requiredApprovals: 1,
    dryRun: "required",
    canary: "single-document",
    rollback: "reindex-affected-documents",
    sanitize(parameters = {}) {
      const workspaceId = Number(parameters.workspaceId);
      if (!Number.isInteger(workspaceId) || workspaceId < 1)
        throw actionError("operations_workspace_id_required");
      return { workspaceId };
    },
    scope(parameters) {
      return { type: "workspace-index", ids: [String(parameters.workspaceId)] };
    },
  }),
});

function actionDefinition(actionId) {
  return definitions[String(actionId)] || null;
}

function actionCatalog() {
  return Object.values(definitions).map(
    ({ sanitize: _sanitize, scope: _scope, ...definition }) => definition
  );
}

module.exports = {
  ACTION_IDS,
  actionCatalog,
  actionDefinition,
  actionError,
  boundedIdList,
  boundedIntegerList,
};
