const fs = require("fs");
const { isWithin } = require("../../utils/files/pathSafety");
const { recordClientTrustCheckpoint } = require("../../utils/clientIdentity");
const accessGate = require("./accessGate");
const documentCatalog = require("./documentCatalog");
const documentsCore = require("./documentsCore");
const ingestCore = require("./ingestCore");
const pdfMedia = require("./pdfMedia");
const postprocessPipeline = require("./postprocessPipeline");
const readerLinks = require("./readerLinks");

const readerDeleteJobs = new Map();

function includeReaderDocumentContent(request) {
  const detail = String(request.query?.detail || "metadata").toLowerCase();
  return detail === "content" || detail === "full";
}

function readerDocumentNotFoundError() {
  const error = new Error("Reader document not found.");
  error.status = 404;
  return error;
}

function assertReaderDocumentVisible(documentRoot, metadata = null) {
  if (!documentsCore.readerDocumentIsDeleted(documentRoot, metadata)) return;
  throw readerDocumentNotFoundError();
}

function readerPostprocessKey(workspace, readerDocumentId) {
  return postprocessPipeline.readerPostprocessKey(workspace, readerDocumentId);
}

function enqueueReaderDocumentDelete({ workspace, readerDocumentId }) {
  const key = readerPostprocessKey(workspace, readerDocumentId);
  if (readerDeleteJobs.has(key)) return;
  const job = Promise.resolve()
    .then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const documentRoot = documentsCore.readerDocumentRoot(
        workspace,
        readerDocumentId
      );
      if (!fs.existsSync(documentRoot)) return;
      fs.rmSync(documentRoot, { recursive: true, force: true });
    })
    .catch((error) => {
      console.warn("[ReaderDocumentDelete] async delete failed", {
        readerDocumentId,
        workspace: workspace?.slug || workspace?.readerStorageSegment || null,
        error: error.message,
      });
    })
    .finally(() => readerDeleteJobs.delete(key));
  readerDeleteJobs.set(key, job);
}

async function metadataGet(request, response) {
  try {
    const workspace = response.locals.workspace;
    const readerDocumentId = documentsCore.assertReaderDocumentId(
      request.params.readerDocumentId
    );
    const documentRoot = documentsCore.readerDocumentRoot(
      workspace,
      readerDocumentId
    );
    const includeContent = includeReaderDocumentContent(request);
    const metadata = documentsCore.readReaderMetadata(documentRoot, {
      readerDocumentId,
      endpoint: "get",
    });
    if (workspace.readerStandalone) {
      await documentCatalog.assertAuthorizedStandaloneReaderDocument({
        request,
        response,
        readerDocumentId,
        metadata,
      });
    } else {
      assertReaderDocumentVisible(documentRoot, metadata);
    }
    let content = includeContent
      ? documentsCore.readReaderJsonFile(documentRoot, "content.json", null, {
          readerDocumentId,
          endpoint: "get",
        })
      : null;
    if (
      includeContent &&
      ingestCore.documentTypeFromMetadata(metadata) === "xlsx" &&
      !content?.projection?.source
    ) {
      const originalPath = await documentsCore.originalPathForReaderDocument({
        documentRoot,
        metadata,
      });
      content = await ingestCore.xlsxContentProjection({
        readerDocumentId,
        originalPath,
      });
      documentsCore.writeReaderJsonFile(documentRoot, "content.json", content);
    }
    const pdfManifest = pdfMedia.readOptionalReaderPdfManifest(
      documentRoot,
      readerDocumentId
    );
    const responseMetadata = pdfManifest
      ? { ...metadata, pdfManifest }
      : metadata;

    return response.status(200).json({
      success: true,
      warning: metadata.previewWarning || null,
      sensitiveSession: accessGate.readerSensitiveSessionForResponse(
        request,
        response,
        workspace,
        readerDocumentId,
        "reader-document-open"
      ),
      ...(includeContent ? { content } : {}),
      contentSummary: documentsCore.readerContentSummary({
        content,
        metadata: responseMetadata,
      }),
      metadata: readerLinks.metadataWithOriginalUrl(
        workspace,
        readerDocumentId,
        responseMetadata
      ),
      postprocess: postprocessPipeline.readerPostprocessResponse(
        workspace,
        readerDocumentId
      ).postprocess,
    });
  } catch (error) {
    return response.status(404).json({ success: false, error: error.message });
  }
}

async function deleteDocument(request, response) {
  try {
    const workspace = response.locals.workspace;
    const readerDocumentId = documentsCore.assertReaderDocumentId(
      request.params.readerDocumentId
    );
    const workspaceRoot = documentsCore.readerWorkspaceRoot(workspace);
    const documentRoot = documentsCore.readerDocumentRoot(
      workspace,
      readerDocumentId
    );
    if (!isWithin(workspaceRoot, documentRoot))
      throw new Error("Invalid reader document path.");
    if (!fs.existsSync(documentRoot))
      return response.status(200).json({ success: true, missing: true });

    const metadata = workspace.readerStandalone
      ? await documentCatalog.readAuthorizedStandaloneReaderMetadata(
          request,
          response,
          documentRoot,
          readerDocumentId,
          "delete",
          { allowDeleted: true }
        )
      : documentsCore.readReaderJsonFile(documentRoot, "metadata.json", null, {
          readerDocumentId,
          endpoint: "delete",
        });

    void recordClientTrustCheckpoint(request, {
      action: "reader_delete",
      resourceType: "reader_document",
      resourceId: readerDocumentId,
      outcome: "received",
    });
    const marker = documentsCore.markReaderDocumentDeleted({
      workspace,
      readerDocumentId,
      metadata,
      request,
    });
    enqueueReaderDocumentDelete({ workspace, readerDocumentId });
    return response.status(200).json({
      success: true,
      deletionStatus: marker.deleteStatus,
      deletedAt: marker.deletedAt,
    });
  } catch (error) {
    return response
      .status(error.status || 400)
      .json({ success: false, error: error.message });
  }
}

module.exports = {
  deleteDocument,
  metadataGet,
};
