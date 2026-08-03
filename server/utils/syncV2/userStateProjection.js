const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const { nodeKeys } = require("./nodeRegistry");

const SyncV2 = lazyDataAccessFacade("syncV2");

function bounded(value, max = 256) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function normalizeState(state = {}) {
  const namespace = bounded(state.namespace, 128);
  if (!namespace) throw new Error("sync_user_state_namespace_required");
  return {
    namespace,
    scope: bounded(state.scope, 256) || "global",
    value: state.value ?? null,
    version: bounded(state.version, 64) || "1",
    baseVersion:
      state.baseVersion === null || state.baseVersion === undefined
        ? null
        : Number(state.baseVersion),
    changedPaths: Array.isArray(state.changedPaths)
      ? state.changedPaths.slice(0, 64).map((path) => bounded(path, 256))
      : ["value"],
    mutationId: bounded(state.mutationId, 256) || null,
  };
}

async function reconcileUserStateProjection({
  userId,
  operation = "upsert",
  states = [],
  namespace = null,
  scope = "global",
  syncContext = {},
} = {}) {
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0)
    throw new Error("sync_user_state_user_invalid");
  if (!(await SyncV2.enabled("preferences")))
    return { status: "skipped", reasonCode: "preferences_domain_disabled" };
  if (!(await SyncV2.schemaReady()))
    return { status: "deferred", reasonCode: "sync_schema_unavailable" };

  const entries =
    operation === "delete"
      ? [normalizeState({ namespace, scope, value: null })]
      : states.slice(0, 64).map(normalizeState);
  const results = [];
  for (const state of entries) {
    const nodeKey = nodeKeys.userPreferences(
      normalizedUserId,
      state.namespace,
      state.scope
    );
    const baseVersion = state.baseVersion ?? syncContext.baseVersion;
    if (baseVersion !== null && baseVersion !== undefined) {
      await SyncV2.assertNodeMutationVersion({
        nodeKey,
        baseVersion,
        changedPaths: state.changedPaths,
      });
    }
    const result = await SyncV2.reconcileNode({
      nodeKey,
      content:
        operation === "delete"
          ? { deleted: true }
          : {
              namespace: state.namespace,
              scope: state.scope,
              schemaVersion: state.version,
              value: state.value,
            },
      deletedAt: operation === "delete" ? new Date() : null,
      emitOnCreate: true,
      eventType:
        operation === "delete" ? "preference.deleted" : "preference.updated",
      changedPaths: state.changedPaths,
      payloadHint: { namespace: state.namespace, scope: state.scope },
      originClientId: bounded(syncContext.originClientId, 256) || null,
      mutationId:
        state.mutationId || bounded(syncContext.mutationId, 256) || null,
      audience: [normalizedUserId],
    });
    results.push({
      namespace: state.namespace,
      scope: state.scope,
      stateVersion: result?.node?.stateVersion ?? null,
      hash: result?.node?.hash || null,
    });
  }
  return { status: "reconciled", states: results };
}

module.exports = {
  normalizeState,
  reconcileUserStateProjection,
};
