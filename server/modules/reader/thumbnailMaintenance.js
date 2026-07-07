const fs = require("fs");
const { storagePath } = require("../../utils/environment");
const documentCatalog = require("./documentCatalog");
const documentsCore = require("./documentsCore");

const READER_THUMBNAIL_MAINTENANCE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.READER_THUMBNAIL_MAINTENANCE_INTERVAL_MS) ||
    30 * 60 * 1_000
);
const READER_THUMBNAIL_MAINTENANCE_BATCH_SIZE = Math.max(
  1,
  Number(process.env.READER_THUMBNAIL_MAINTENANCE_BATCH_SIZE) || 24
);
const readerDocumentsPath = storagePath("reader-documents");
let readerThumbnailMaintenanceStarted = false;

function workspaceFromReaderStorageSegment(segment = "") {
  if (segment === documentsCore.STANDALONE_READER_SCOPE.readerStorageSegment)
    return documentsCore.STANDALONE_READER_SCOPE;
  return {
    slug: segment,
    readerStorageSegment: segment,
  };
}

function runReaderThumbnailMaintenancePass(reason = "interval") {
  if (!fs.existsSync(readerDocumentsPath)) return;
  let queued = 0;
  for (const workspaceEntry of fs.readdirSync(readerDocumentsPath, {
    withFileTypes: true,
  })) {
    if (!workspaceEntry.isDirectory()) continue;
    const workspace = workspaceFromReaderStorageSegment(workspaceEntry.name);
    const workspaceRoot = documentsCore.readerWorkspaceRoot(workspace);
    for (const documentEntry of fs.readdirSync(workspaceRoot, {
      withFileTypes: true,
    })) {
      if (!documentEntry.isDirectory()) continue;
      let readerDocumentId = null;
      try {
        readerDocumentId = documentsCore.assertReaderDocumentId(
          documentEntry.name
        );
      } catch {
        continue;
      }
      const documentRoot = documentsCore.readerDocumentRoot(
        workspace,
        readerDocumentId
      );
      let metadata = null;
      try {
        metadata = documentsCore.readReaderMetadata(documentRoot, {
          readerDocumentId,
          endpoint: "thumbnail-maintenance",
        });
      } catch {
        continue;
      }
      if (documentsCore.readerDocumentIsDeleted(documentRoot, metadata))
        continue;
      if (
        !documentCatalog.shouldQueueThumbnailMaintenance({
          workspace,
          readerDocumentId,
        })
      )
        continue;
      documentCatalog.queueThumbnailMaintenance({
        workspace,
        readerDocumentId,
        reason,
      });
      queued += 1;
      if (queued >= READER_THUMBNAIL_MAINTENANCE_BATCH_SIZE) return;
    }
  }
}

function startReaderThumbnailMaintenancePatrol() {
  if (readerThumbnailMaintenanceStarted) return;
  readerThumbnailMaintenanceStarted = true;
  const startupTimer = setTimeout(
    () => runReaderThumbnailMaintenancePass("startup"),
    Math.min(30_000, READER_THUMBNAIL_MAINTENANCE_INTERVAL_MS)
  );
  startupTimer.unref?.();
  const intervalTimer = setInterval(
    () => runReaderThumbnailMaintenancePass("interval"),
    READER_THUMBNAIL_MAINTENANCE_INTERVAL_MS
  );
  intervalTimer.unref?.();
}

module.exports = {
  runReaderThumbnailMaintenancePass,
  startReaderThumbnailMaintenancePatrol,
};
