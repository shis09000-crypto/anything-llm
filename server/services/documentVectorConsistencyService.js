const path = require("path");
const fs = require("fs");
const { DataAccessCenter } = require("../utils/dataAccess");
const { normalizePath, isWithin } = require("../utils/files");
const { safeReadJsonFile } = require("../utils/safety");
const { storagePath, vectorNamespace } = require("../utils/environment");

const documentsPath = storagePath("documents");
const vectorCachePath = storagePath("vector-cache");

function localDocumentPath(docpath = "") {
  try {
    return path.resolve(documentsPath, normalizePath(docpath));
  } catch {
    return null;
  }
}

function localDocumentHealth(docpath = "") {
  const fullPath = localDocumentPath(docpath);
  if (!fullPath || !isWithin(documentsPath, fullPath))
    return { exists: false, readableJson: false, error: "invalid_path" };
  if (!fs.existsSync(fullPath))
    return { exists: false, readableJson: false, error: "missing_file" };

  const result = safeReadJsonFile(fullPath, null, {
    quarantine: false,
    context: { docpath },
  });
  return {
    exists: true,
    readableJson: result.ok,
    error: result.error?.code || null,
  };
}

async function workspaceRobustnessDiagnostics(workspace) {
  const workspaceDocuments = await DataAccessCenter.document.forWorkspace(
    workspace.id
  );
  const docIds = [...new Set(workspaceDocuments.map((doc) => doc.docId))];
  const vectorRows = docIds.length
    ? await DataAccessCenter.documentVector.where({ docId: { in: docIds } })
    : [];
  const vectorDocIds = new Set(vectorRows.map((row) => row.docId));
  const indexStatuses = await DataAccessCenter.documentIndexStatus.forWorkspace(
    workspace.id
  );
  const documentPaths = new Set(workspaceDocuments.map((doc) => doc.docpath));
  const statusPaths = new Set(indexStatuses.map((status) => status.filePath));
  const allPaths = [...new Set([...documentPaths, ...statusPaths])];
  const fileHealth = allPaths.map((docpath) => ({
    docpath,
    ...localDocumentHealth(docpath),
    hasWorkspaceDocument: documentPaths.has(docpath),
    hasIndexStatus: statusPaths.has(docpath),
  }));
  const dbWithoutFile = fileHealth.filter(
    (item) => item.hasWorkspaceDocument && !item.exists
  );
  const statusWithoutDb = fileHealth.filter(
    (item) => item.hasIndexStatus && !item.hasWorkspaceDocument
  );
  const dbWithoutVector = workspaceDocuments.filter(
    (doc) => !vectorDocIds.has(doc.docId)
  );
  const corruptFiles = fileHealth.filter(
    (item) => item.exists && !item.readableJson
  );
  const stuckIndexStatuses = indexStatuses.filter((status) =>
    ["pending", "indexing"].includes(status.indexStatus)
  );

  return {
    success: true,
    workspace: { id: workspace.id, slug: workspace.slug },
    summary: {
      workspaceDocuments: workspaceDocuments.length,
      vectorRows: vectorRows.length,
      indexStatuses: indexStatuses.length,
      checkedFiles: fileHealth.length,
      vectorCacheAvailable: fs.existsSync(vectorCachePath),
      dbWithoutFile: dbWithoutFile.length,
      statusWithoutDb: statusWithoutDb.length,
      dbWithoutVector: dbWithoutVector.length,
      corruptFiles: corruptFiles.length,
      stuckIndexStatuses: stuckIndexStatuses.length,
    },
    issues: {
      dbWithoutFile: dbWithoutFile.map((item) => item.docpath),
      statusWithoutDb: statusWithoutDb.map((item) => item.docpath),
      dbWithoutVector: dbWithoutVector.map((doc) => ({
        docId: doc.docId,
        docpath: doc.docpath,
        filename: doc.filename,
      })),
      corruptFiles: corruptFiles.map((item) => ({
        docpath: item.docpath,
        error: item.error,
      })),
      stuckIndexStatuses: stuckIndexStatuses.map((status) => ({
        filePath: status.filePath,
        docId: status.docId,
        indexStatus: status.indexStatus,
        updatedAt: status.updatedAt,
      })),
    },
    fileHealth,
  };
}

function buildRepairPlan(diagnostics = {}) {
  const workspace = diagnostics.workspace || {};
  const issues = diagnostics.issues || {};
  const actions = [];

  for (const docpath of issues.dbWithoutFile || []) {
    actions.push({
      type: "mark_document_missing",
      severity: "high",
      owner: "document-repository",
      workspaceId: workspace.id || null,
      workspaceSlug: workspace.slug || null,
      docpath,
      destructive: false,
      automatic: false,
      reason:
        "workspace_documents points at a missing document JSON file; keep DB row but surface missing status.",
    });
  }

  for (const docpath of issues.statusWithoutDb || []) {
    actions.push({
      type: "mark_index_status_deleted",
      severity: "medium",
      owner: "document-index-status-repository",
      workspaceId: workspace.id || null,
      workspaceSlug: workspace.slug || null,
      docpath,
      destructive: false,
      automatic: false,
      reason:
        "index status exists without a workspace document row; safe repair should mark status deleted only after explicit operator confirmation.",
    });
  }

  for (const doc of issues.dbWithoutVector || []) {
    actions.push({
      type: "enqueue_reembed",
      severity: "medium",
      owner: "task-scheduler",
      workspaceId: workspace.id || null,
      workspaceSlug: workspace.slug || null,
      docId: doc.docId,
      docpath: doc.docpath,
      destructive: false,
      automatic: false,
      reason:
        "workspace document has no document_vectors rows; re-embedding must go through TaskScheduler and the active vector provider.",
    });
  }

  for (const item of issues.corruptFiles || []) {
    actions.push({
      type: "quarantine_or_restore_document_json",
      severity: "high",
      owner: "document-storage-provider",
      workspaceId: workspace.id || null,
      workspaceSlug: workspace.slug || null,
      docpath: item.docpath,
      error: item.error || null,
      destructive: false,
      automatic: false,
      reason:
        "document JSON is unreadable; repair requires a backup/source document decision.",
    });
  }

  for (const status of issues.stuckIndexStatuses || []) {
    actions.push({
      type: "reset_stuck_index_status",
      severity: "low",
      owner: "document-index-status-repository",
      workspaceId: workspace.id || null,
      workspaceSlug: workspace.slug || null,
      docId: status.docId || null,
      docpath: status.filePath,
      destructive: false,
      automatic: false,
      reason:
        "index status is pending/indexing; reset or retry should be scheduled as a foreground/background task based on user intent.",
    });
  }

  return {
    success: true,
    workspace,
    vector: {
      provider: process.env.VECTOR_DB || "lancedb",
      namespace: workspace.slug ? vectorNamespace(workspace.slug) : null,
      vectorCachePath,
    },
    counts: {
      actions: actions.length,
      high: actions.filter((action) => action.severity === "high").length,
      medium: actions.filter((action) => action.severity === "medium").length,
      low: actions.filter((action) => action.severity === "low").length,
    },
    actions,
  };
}

async function workspaceRepairPlan(workspace) {
  const diagnostics = await workspaceRobustnessDiagnostics(workspace);
  return {
    diagnostics,
    repairPlan: buildRepairPlan(diagnostics),
  };
}

module.exports = {
  DocumentVectorConsistencyService: {
    buildRepairPlan,
    localDocumentHealth,
    workspaceRepairPlan,
    workspaceRobustnessDiagnostics,
  },
};
