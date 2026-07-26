const { DataAccessCenter } = require("../../dataAccess");
const {
  startSyncV2OutboxDispatcher,
  stopSyncV2OutboxDispatcher,
  syncV2OutboxSnapshot,
} = require("../../syncV2/outboxDispatcher");
const {
  DocumentVectorConsistencyService,
} = require("../../../services/documentVectorConsistencyService");
const { ACTION_IDS, actionError } = require("./catalog");

function chunk(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size)
    groups.push(values.slice(index, index + size));
  return groups;
}

function failedResult(code, details = {}) {
  const error = actionError(code);
  error.details = details;
  return error;
}

function safeDeadLetterSnapshot(row) {
  return {
    seq: Number(row.seq),
    attemptCount: Number(row.attemptCount || 0),
    lastErrorCode: row.lastErrorCode || null,
    deadLetteredAt: row.deadLetteredAt || null,
  };
}

function requeueAdapter({ data = DataAccessCenter } = {}) {
  return {
    async preflight({ parameters }) {
      const rows = await data.syncV2.deadLetterOutbox({
        seqs: parameters.seqs,
        limit: parameters.seqs.length,
      });
      if (rows.length !== parameters.seqs.length)
        throw failedResult("operations_dead_letter_target_changed", {
          requested: parameters.seqs.length,
          found: rows.length,
        });
      return { targets: rows.map(safeDeadLetterSnapshot) };
    },
    async canary({ dryRun }) {
      const target = dryRun.targets[0];
      const result = await data.syncV2.requeueDeadLetters([target.seq]);
      if (Number(result.count) !== 1)
        throw failedResult("operations_requeue_canary_not_applied");
      return { seqs: [target.seq], count: 1 };
    },
    async validateCanary({ canary }) {
      const rows = await data.syncV2.outboxRows(canary.seqs);
      return {
        valid:
          rows.length === canary.seqs.length &&
          rows.every((row) => row.status !== "dead_letter"),
        observedStatuses: rows.map((row) => ({
          seq: Number(row.seq),
          status: row.status,
        })),
      };
    },
    async execute({ dryRun, canary }) {
      const completed = new Set(canary.seqs.map(Number));
      const seqs = dryRun.targets
        .map((row) => Number(row.seq))
        .filter((seq) => !completed.has(seq));
      const result = await data.syncV2.requeueDeadLetters(seqs);
      if (Number(result.count) !== seqs.length)
        throw failedResult("operations_requeue_partial", {
          requested: seqs.length,
          changed: Number(result.count || 0),
        });
      return { seqs: [...canary.seqs, ...seqs], count: seqs.length };
    },
    async validate({ result }) {
      const rows = await data.syncV2.outboxRows(result.seqs);
      return {
        valid: rows.every((row) => row.status !== "dead_letter"),
        checked: rows.length,
      };
    },
    async rollback({ dryRun }) {
      return await data.syncV2.restoreDeadLetters(dryRun.targets);
    },
  };
}

function securityCacheAdapter({ data = DataAccessCenter } = {}) {
  const authSession = data.adminSystem.authSession;
  return {
    async preflight({ parameters }) {
      return {
        scope: parameters.sessionIds.length ? "selected" : "all",
        sessionIds: parameters.sessionIds,
        cache: authSession.cacheSnapshot(),
      };
    },
    async canary({ dryRun }) {
      if (!dryRun.sessionIds.length)
        return {
          mode: "authoritative-probe",
          cache: authSession.cacheSnapshot(),
        };
      return authSession.refreshCache({ sessionIds: [dryRun.sessionIds[0]] });
    },
    async validateCanary() {
      return { valid: true, authority: "auth-database" };
    },
    async execute({ dryRun }) {
      if (!dryRun.sessionIds.length) return authSession.refreshCache();
      if (dryRun.sessionIds.length === 1)
        return { scope: "selected", selected: 0, canaryWasFullExecution: true };
      return authSession.refreshCache({
        sessionIds: dryRun.sessionIds.slice(1),
      });
    },
    async validate() {
      return { valid: true, authority: "auth-database" };
    },
    async rollback() {
      return {
        restored: true,
        strategy: "authoritative-repopulation-on-next-read",
      };
    },
  };
}

function workerRegistry(data = DataAccessCenter) {
  return {
    "sync-v2-outbox": {
      snapshot: syncV2OutboxSnapshot,
      stop: () => stopSyncV2OutboxDispatcher({ drain: true }),
      start: () => startSyncV2OutboxDispatcher(),
    },
    "workspace-cognition": {
      snapshot: () => data.workspaceCognition.workerSnapshot(),
      stop: () => data.workspaceCognition.stopWorker({ timeoutMs: 30_000 }),
      start: () => data.workspaceCognition.startWorker(),
    },
  };
}

function workerAdapter({
  data = DataAccessCenter,
  workers = workerRegistry(data),
} = {}) {
  const target = (parameters) => workers[parameters.workerId];
  return {
    async preflight({ parameters }) {
      const worker = target(parameters);
      if (!worker) throw actionError("operations_worker_not_allowlisted");
      const snapshot = worker.snapshot();
      if (!snapshot.running) throw actionError("operations_worker_not_running");
      return { workerId: parameters.workerId, before: snapshot };
    },
    async canary({ parameters }) {
      const worker = target(parameters);
      await worker.stop();
      await worker.start();
      return { workerId: parameters.workerId, after: worker.snapshot() };
    },
    async validateCanary({ parameters }) {
      const snapshot = target(parameters).snapshot();
      return {
        valid: snapshot.running && snapshot.healthy !== false,
        snapshot,
      };
    },
    async execute({ parameters }) {
      return { workerId: parameters.workerId, canaryWasFullExecution: true };
    },
    async validate({ parameters }) {
      const snapshot = target(parameters).snapshot();
      return {
        valid: snapshot.running && snapshot.healthy !== false,
        snapshot,
      };
    },
    async rollback({ parameters }) {
      const worker = target(parameters);
      if (!worker.snapshot().running) await worker.start();
      return { ensuredRunning: Boolean(worker.snapshot().running) };
    },
  };
}

function knowledgeIndexAdapter({
  data = DataAccessCenter,
  consistency = DocumentVectorConsistencyService,
} = {}) {
  async function workspaceFor(parameters) {
    const workspace = await data.workspace.get({ id: parameters.workspaceId });
    if (!workspace) throw actionError("operations_workspace_not_found");
    return workspace;
  }

  async function reindex(workspace, docIds, userId) {
    const aggregate = { rebuilt: [], failed: [] };
    for (const batch of chunk(docIds, 20)) {
      const result = await data.document.reindexDocuments(
        workspace,
        batch,
        userId
      );
      aggregate.rebuilt.push(...result.rebuilt);
      aggregate.failed.push(...result.failed);
      if (result.failed.length) break;
    }
    if (aggregate.failed.length)
      throw failedResult("operations_workspace_index_rebuild_failed", {
        rebuilt: aggregate.rebuilt,
        failed: aggregate.failed.map((entry) => entry.docId),
      });
    return aggregate;
  }

  async function validateIds(workspace, docIds) {
    const rows = await data.documentVector.where({ docId: { in: docIds } });
    const present = new Set(rows.map((row) => String(row.docId)));
    return {
      valid: docIds.every((docId) => present.has(String(docId))),
      expectedDocuments: docIds.length,
      indexedDocuments: present.size,
    };
  }

  return {
    async preflight({ parameters }) {
      const workspace = await workspaceFor(parameters);
      const documents = await data.document.forWorkspace(workspace.id);
      if (!documents.length)
        throw actionError("operations_workspace_has_no_documents");
      if (documents.length > 2_000)
        throw actionError("operations_workspace_index_scope_too_large");
      const diagnostics =
        await consistency.workspaceRobustnessDiagnostics(workspace);
      const unhealthySources = new Set(
        diagnostics.fileHealth
          .filter((entry) => !entry.exists || !entry.readableJson)
          .map((entry) => entry.docpath)
      );
      if (unhealthySources.size)
        throw actionError("operations_workspace_source_unhealthy");
      return {
        workspaceId: Number(workspace.id),
        documentIds: documents.map((document) => document.docId),
        documentCount: documents.length,
        before: diagnostics.summary,
      };
    },
    async canary({ parameters, dryRun, actor }) {
      const workspace = await workspaceFor(parameters);
      const documentIds = dryRun.documentIds.slice(0, 1);
      const result = await reindex(workspace, documentIds, actor.userId);
      return { documentIds, rebuilt: result.rebuilt };
    },
    async validateCanary({ parameters, canary }) {
      return validateIds(await workspaceFor(parameters), canary.documentIds);
    },
    async execute({ parameters, dryRun, canary, actor }) {
      const completed = new Set(canary.documentIds);
      const documentIds = dryRun.documentIds.filter(
        (documentId) => !completed.has(documentId)
      );
      const result = await reindex(
        await workspaceFor(parameters),
        documentIds,
        actor.userId
      );
      return {
        documentIds: [...canary.documentIds, ...documentIds],
        rebuilt: [...canary.rebuilt, ...result.rebuilt],
      };
    },
    async validate({ parameters, result }) {
      const workspace = await workspaceFor(parameters);
      const vectors = await validateIds(workspace, result.documentIds);
      const diagnostics =
        await consistency.workspaceRobustnessDiagnostics(workspace);
      return {
        ...vectors,
        valid: vectors.valid && diagnostics.issues.dbWithoutVector.length === 0,
        diagnostics: diagnostics.summary,
      };
    },
    async rollback({
      parameters,
      dryRun,
      canary,
      result,
      actor,
      recovery = false,
    }) {
      const affected = recovery
        ? [...new Set(dryRun?.documentIds || [])]
        : [
            ...new Set([
              ...(canary?.documentIds || []),
              ...(result?.documentIds || []),
            ]),
          ];
      if (!affected.length) return { restored: true, rebuilt: [] };
      const rebuilt = await reindex(
        await workspaceFor(parameters),
        affected,
        actor.userId
      );
      return {
        restored: rebuilt.failed.length === 0,
        rebuilt: rebuilt.rebuilt,
        originalDocumentCount: dryRun.documentCount,
      };
    },
  };
}

function actionAdapters(options = {}) {
  return {
    [ACTION_IDS.REQUEUE_FAILED_TASKS]: requeueAdapter(options),
    [ACTION_IDS.REFRESH_SECURITY_CACHE]: securityCacheAdapter(options),
    [ACTION_IDS.RESTART_STATELESS_WORKER]: workerAdapter(options),
    [ACTION_IDS.REBUILD_WORKSPACE_INDEX]: knowledgeIndexAdapter(options),
  };
}

module.exports = {
  actionAdapters,
  knowledgeIndexAdapter,
  requeueAdapter,
  securityCacheAdapter,
  workerAdapter,
  workerRegistry,
};
