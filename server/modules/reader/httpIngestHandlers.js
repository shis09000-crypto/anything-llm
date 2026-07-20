const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const {
  DocumentRepository: Document,
} = require("../../repositories/documentRepository");
const { fileData, normalizePath } = require("../../utils/files");
const { storagePath } = require("../../utils/environment");
const {
  fileBackedOwnerMetadata,
  requestAuthContext,
} = require("../../utils/authz/resourceAccess");
const { userFromSession } = require("../../utils/http");
const accessGate = require("./accessGate");
const documentCatalog = require("./documentCatalog");
const documentsCore = require("./documentsCore");
const ingestCore = require("./ingestCore");
const pdfMedia = require("./pdfMedia");
const postprocessCore = require("./postprocessCore");
const postprocessPipeline = require("./postprocessPipeline");
const previewPipeline = require("./previewPipeline");
const readerLinks = require("./readerLinks");

const SCHEMA_VERSION = 1;
const MAX_READER_FILE_SIZE = 500 * 1024 * 1024;

const uploadTempRoot = storagePath("tmp", "reader-uploads");
fs.mkdirSync(uploadTempRoot, { recursive: true });
const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, uploadTempRoot),
    filename: (_request, _file, callback) =>
      callback(null, `${crypto.randomUUID()}.upload`),
  }),
  limits: { fileSize: MAX_READER_FILE_SIZE },
}).single("file");

function includeUploadContent(request) {
  const value = request.query?.includeContent;
  return value === "1" || value === "true";
}

function sendUploadError(response, error) {
  if (error?.code === "LIMIT_FILE_SIZE") {
    return response.status(413).json({
      success: false,
      error: "request_entity_too_large",
      limitClass: "multipart_document",
      maxBytes: MAX_READER_FILE_SIZE,
    });
  }
  return response.status(400).json({
    success: false,
    error: error.message || "Invalid reader document upload.",
  });
}

function duplicateUploadAction(request) {
  return String(request.body?.duplicateAction || "")
    .trim()
    .toLowerCase();
}

function duplicateDisplayName(originalName = "", index = 2) {
  const ext = path.extname(originalName);
  const base = ext ? originalName.slice(0, -ext.length) : originalName;
  return `${base || "书籍"}（重复 ${Math.max(2, index)}）${ext}`;
}

function writeReaderDocumentFiles(
  workspace,
  readerDocumentId,
  content,
  metadata
) {
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  fs.mkdirSync(documentRoot, { recursive: true });
  documentsCore.writeReaderJsonFile(documentRoot, "content.json", content);
  documentsCore.writeReaderJsonFile(documentRoot, "metadata.json", metadata);
  return documentRoot;
}

async function ownerMetadataForStandaloneRequest(request, response) {
  if (!response.locals.workspace?.readerStandalone) return {};
  const user =
    response?.locals?.user ||
    (await userFromSession(request, response)) ||
    (await requestAuthContext({ request, response })).user ||
    null;
  return fileBackedOwnerMetadata(user);
}

async function finalizeReaderDocumentMetadata({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
  buffer = null,
  waitForPreview = true,
}) {
  const fingerprint = buffer
    ? ingestCore.fingerprintForBuffer(buffer)
    : await ingestCore.fingerprintForFile(originalPath);
  const nextMetadata = {
    ...metadata,
    originalFingerprint: fingerprint,
  };
  if (!waitForPreview) {
    schedulePreviewMetadataUpdate({
      workspace,
      readerDocumentId,
      metadata: nextMetadata,
      originalPath,
      fingerprint,
    });
    return nextMetadata;
  }
  return await previewPipeline.ensurePdfPreview({
    workspace,
    readerDocumentId,
    metadata: nextMetadata,
    originalPath,
    fingerprint,
    previewUrlForDocument: readerLinks.previewUrlForDocument,
  });
}

function schedulePreviewMetadataUpdate({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
  fingerprint,
}) {
  if (!previewPipeline.metadataNeedsPdfPreview(metadata)) return;
  const previewLabel = previewPipeline.previewDocumentLabel(metadata);
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  postprocessPipeline.updateReaderPostprocessStatus(
    documentRoot,
    readerDocumentId,
    (status) =>
      postprocessCore.postprocessTaskPatch(status, "preview", {
        status: "processing",
        reason: `正在生成 ${previewLabel} 预览`,
      })
  );
  previewPipeline
    .ensurePdfPreview({
      workspace,
      readerDocumentId,
      metadata,
      originalPath,
      fingerprint,
      previewUrlForDocument: readerLinks.previewUrlForDocument,
    })
    .then((finalMetadata) => {
      documentsCore.writeReaderJsonFile(
        documentRoot,
        "metadata.json",
        finalMetadata
      );
      postprocessPipeline.updateReaderPostprocessStatus(
        documentRoot,
        readerDocumentId,
        (status) =>
          postprocessCore.postprocessTaskPatch(status, "preview", {
            status: finalMetadata.previewPdfUrl ? "complete" : "failed",
            reason: finalMetadata.previewPdfUrl
              ? ""
              : finalMetadata.previewWarning ||
                `${previewLabel} 预览生成失败。`,
          })
      );
    })
    .catch((error) => {
      postprocessPipeline.updateReaderPostprocessStatus(
        documentRoot,
        readerDocumentId,
        (status) =>
          postprocessCore.postprocessTaskPatch(status, "preview", {
            status: "failed",
            reason: error.message || `${previewLabel} 预览生成失败。`,
          })
      );
      console.warn("[ReaderDocument] PDF preview metadata update failed", {
        readerDocumentId,
        error: error.message,
      });
    });
}

async function upload(request, response) {
  uploadMiddleware(request, response, async (uploadError) => {
    let temporaryUploadPath = request.file?.path || null;
    let createdDocumentRoot = null;
    let committed = false;
    try {
      if (uploadError) return sendUploadError(response, uploadError);
      const workspace = response.locals.workspace;
      const { ext, mime } = documentsCore.assertAllowedUpload(request.file);
      const originalName = documentsCore.decodeMaybeMojibakeFilename(
        request.file.originalname
      );
      const readerDocumentId = crypto.randomUUID();
      const documentType = ingestCore.documentTypeFromExt(ext);
      const storedName = `original${ext}`;
      const documentRoot = documentsCore.readerDocumentRoot(
        workspace,
        readerDocumentId
      );
      createdDocumentRoot = documentRoot;
      fs.mkdirSync(documentRoot, { recursive: true });

      const originalPath = documentsCore.safeResolve(documentRoot, storedName);
      fs.renameSync(temporaryUploadPath, originalPath);
      temporaryUploadPath = null;

      const content = ingestCore.contentForUpload({
        readerDocumentId,
        documentType,
        buffer:
          documentType === "markdown" ? fs.readFileSync(originalPath) : null,
      });
      const originalFingerprint =
        await ingestCore.fingerprintForFile(originalPath);
      const leadText = await documentCatalog.extractReaderDuplicateLeadText({
        documentType,
        originalPath,
      });
      const duplicateResult =
        await documentCatalog.findReaderDuplicateCandidate({
          request,
          response,
          uploadWorkspace: workspace,
          originalName,
          leadText,
        });
      const continuingDuplicate =
        duplicateUploadAction(request) === "continue" &&
        duplicateResult.duplicate;
      if (duplicateResult.duplicate && !continuingDuplicate) {
        fs.rmSync(documentRoot, { recursive: true, force: true });
        createdDocumentRoot = null;
        return response.status(409).json({
          success: false,
          code: "READER_DUPLICATE",
          error: "检测到重复书籍。",
          duplicate: duplicateResult.duplicate,
        });
      }
      const effectiveOriginalName = continuingDuplicate
        ? duplicateDisplayName(originalName, duplicateResult.duplicateIndex)
        : originalName;
      const metadata = {
        schemaVersion: SCHEMA_VERSION,
        readerDocumentId,
        source: "reader_upload",
        originalName: effectiveOriginalName,
        uploadedOriginalName:
          effectiveOriginalName === originalName ? null : originalName,
        storedName,
        documentType,
        mimeType: mime,
        size: request.file.size,
        originalFingerprint,
        readerDuplicate: {
          titleKey: duplicateResult.signature.titleKey,
          leadTextHash: duplicateResult.signature.leadTextHash,
          duplicateOfReaderDocumentId:
            duplicateResult.duplicate?.readerDocumentId || null,
          duplicateIndex: continuingDuplicate
            ? duplicateResult.duplicateIndex
            : null,
          calculatedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        ...(await ownerMetadataForStandaloneRequest(request, response)),
      };

      documentsCore.writeReaderJsonFile(documentRoot, "content.json", content);
      documentsCore.writeReaderJsonFile(
        documentRoot,
        "metadata.json",
        metadata
      );
      const finalMetadata = await finalizeReaderDocumentMetadata({
        workspace,
        readerDocumentId,
        metadata,
        originalPath,
        buffer: null,
        waitForPreview: false,
      });
      documentsCore.writeReaderJsonFile(
        documentRoot,
        "metadata.json",
        finalMetadata
      );
      const pdfManifest = await pdfMedia.maybePrewarmLargeReaderPdf({
        workspace,
        readerDocumentId,
        metadata: finalMetadata,
        originalPath,
      });
      const responseMetadata = pdfManifest
        ? { ...finalMetadata, pdfManifest }
        : finalMetadata;

      committed = true;
      return response.status(200).json({
        success: true,
        warning: finalMetadata.previewWarning || null,
        readerDocumentId,
        sensitiveSession: accessGate.readerSensitiveSessionForResponse(
          request,
          response,
          workspace,
          readerDocumentId,
          "reader-upload"
        ),
        ...(includeUploadContent(request) ? { content } : {}),
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
      if (!committed && createdDocumentRoot)
        fs.rmSync(createdDocumentRoot, { recursive: true, force: true });
      return sendUploadError(response, error);
    } finally {
      if (temporaryUploadPath) fs.rmSync(temporaryUploadPath, { force: true });
    }
  });
}

async function fromLocalPath(request, response) {
  try {
    const workspace = response.locals.workspace;
    const { absolutePath, stat } = await documentsCore.validateLocalReaderPath(
      request.body?.absolutePath,
      request.body?.fileAccessContext || {}
    );
    const readerDocumentId = crypto.randomUUID();
    const buffer = fs.readFileSync(absolutePath);
    const { content, metadata } = ingestCore.contentAndMetadataForLocalPath({
      readerDocumentId,
      absolutePath,
      buffer,
      stat,
    });
    const ownedMetadata = {
      ...metadata,
      ...(await ownerMetadataForStandaloneRequest(request, response)),
    };
    const documentRoot = writeReaderDocumentFiles(
      workspace,
      readerDocumentId,
      content,
      ownedMetadata
    );
    const finalMetadata = await finalizeReaderDocumentMetadata({
      workspace,
      readerDocumentId,
      metadata: ownedMetadata,
      originalPath: absolutePath,
      buffer,
    });
    documentsCore.writeReaderJsonFile(
      documentRoot,
      "metadata.json",
      finalMetadata
    );

    return response.status(200).json({
      success: true,
      warning: finalMetadata.previewWarning || null,
      readerDocumentId,
      sensitiveSession: accessGate.readerSensitiveSessionForResponse(
        request,
        response,
        workspace,
        readerDocumentId,
        "reader-local-path-open"
      ),
      content,
      metadata: readerLinks.metadataWithOriginalUrl(
        workspace,
        readerDocumentId,
        finalMetadata
      ),
    });
  } catch (error) {
    return response.status(error.status || 400).json({
      success: false,
      error: error.message,
    });
  }
}

async function fromWorkspace(request, response) {
  try {
    const workspace = response.locals.workspace;
    const docPath = normalizePath(String(request.query.docPath || ""));
    const document = await Document.get({
      workspaceId: workspace.id,
      docpath: docPath,
    });
    if (!document)
      return response
        .status(404)
        .json({ success: false, error: "Workspace document not found." });

    const data = await fileData(document.docpath);
    if (!data?.pageContent)
      return response.status(404).json({
        success: false,
        error: "Workspace parsed content not found.",
      });

    const readerDocumentId = crypto.randomUUID();
    const content = ingestCore.parsedWorkspaceContent(readerDocumentId, data);
    const metadata = {
      schemaVersion: SCHEMA_VERSION,
      readerDocumentId,
      source: "workspace_parsed",
      originalName: data.title || path.basename(docPath),
      storedName: null,
      mimeType: "text/markdown",
      size: Buffer.byteLength(data.pageContent || "", "utf8"),
      createdAt: new Date().toISOString(),
      docPath,
      parsedOnly: true,
      notice: "该文档不是原始版式，仅展示已解析内容",
    };

    return response.status(200).json({
      success: true,
      content,
      metadata,
    });
  } catch (error) {
    return response.status(400).json({ success: false, error: error.message });
  }
}

module.exports = {
  fromLocalPath,
  fromWorkspace,
  upload,
};
