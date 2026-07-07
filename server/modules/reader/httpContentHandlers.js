const path = require("path");
const { hashLogValue } = require("../../utils/security/redaction");
const accessGate = require("./accessGate");
const documentCatalog = require("./documentCatalog");
const documentsCore = require("./documentsCore");
const ingestCore = require("./ingestCore");
const originalStream = require("./originalStream");
const pdfMedia = require("./pdfMedia");
const readerLinks = require("./readerLinks");

const DOCX_PREVIEW_NAME = "preview.pdf";
const READER_THUMBNAIL_NAME = "thumbnail.jpg";

function readerDocumentNotFoundError() {
  const error = new Error("Reader document not found.");
  error.status = 404;
  return error;
}

function assertReaderDocumentVisible(documentRoot, metadata = null) {
  if (!documentsCore.readerDocumentIsDeleted(documentRoot, metadata)) return;
  throw readerDocumentNotFoundError();
}

async function metadataForContentEndpoint({
  request,
  response,
  workspace,
  documentRoot,
  readerDocumentId,
  endpoint,
}) {
  if (workspace.readerStandalone) {
    return await documentCatalog.readAuthorizedStandaloneReaderMetadata(
      request,
      response,
      documentRoot,
      readerDocumentId,
      endpoint
    );
  }
  const metadata = documentsCore.readReaderJsonFile(
    documentRoot,
    "metadata.json",
    null,
    {
      readerDocumentId,
      endpoint,
    }
  );
  assertReaderDocumentVisible(documentRoot, metadata);
  return metadata;
}

function sendContentAccessDenied(response, contentAccess) {
  return response.status(403).json({
    success: false,
    error: contentAccess.error || "sensitive_session_required",
    code: contentAccess.error || "sensitive_session_required",
    reason: contentAccess.reason || "reader_content_access_denied",
  });
}

async function sendReaderPdfPagePreview({
  request,
  response,
  workspace,
  readerDocumentId,
  documentRoot,
  metadata,
  originalPath,
}) {
  const startedAt = Date.now();
  const requestedPage = Math.max(
    1,
    Math.round(Number(request.query?.page) || 1)
  );
  const manifest = await pdfMedia.ensureReaderPdfManifest({
    documentRoot,
    readerDocumentId,
    metadata,
    originalPath,
  });
  const pageNumber = pdfMedia.normalizedPdfPageNumber(requestedPage, manifest);
  const { previewPath, cached } = await pdfMedia.renderReaderPdfPagePreview({
    documentRoot,
    originalPath,
    pageNumber,
  });
  response.setHeader("Content-Type", "image/jpeg");
  response.setHeader(
    "Cache-Control",
    accessGate.readerStreamCacheControlForRequest(request)
  );
  response.setHeader("X-Reader-Page", String(pageNumber));
  response.setHeader("X-Reader-Page-Preview-Cache", cached ? "hit" : "miss");
  response.setHeader(
    "Server-Timing",
    `reader-page-preview;dur=${Date.now() - startedAt}`
  );
  response.setHeader(
    "Content-Disposition",
    `inline; filename="${path.basename(previewPath)}"`
  );
  response.on("finish", () => {
    pdfMedia.scheduleReaderPdfPreviewPrebuild({
      documentRoot,
      readerDocumentId,
      metadata,
      originalPath,
      manifest,
      focusPage: pageNumber,
      includeAll: false,
      reason: "open-nearby-pages",
    });
    console.info("[reader:page-preview]", {
      requestId: request.communicationRequestId || null,
      status: response.statusCode,
      readerDocumentId: hashLogValue(readerDocumentId),
      pageNumber,
      cached,
      originalSize: Number(metadata?.size || 0) || null,
      durationMs: Date.now() - startedAt,
      route: readerLinks.readerApiPrefix(workspace),
    });
  });
  return response.sendFile(previewPath);
}

async function previewPdf(request, response) {
  try {
    const workspace = response.locals.workspace;
    const readerDocumentId = documentsCore.assertReaderDocumentId(
      request.params.readerDocumentId
    );
    const documentRoot = documentsCore.readerDocumentRoot(
      workspace,
      readerDocumentId
    );
    await metadataForContentEndpoint({
      request,
      response,
      workspace,
      documentRoot,
      readerDocumentId,
      endpoint: "preview",
    });
    const contentAccess = accessGate.validateReaderContentAccess({
      request,
      response,
      workspace,
      readerDocumentId,
      endpoint: "preview.pdf",
    });
    if (!contentAccess.ok)
      return sendContentAccessDenied(response, contentAccess);
    const previewPath = documentsCore.safeResolve(
      documentRoot,
      DOCX_PREVIEW_NAME
    );
    if (!documentsCore.validNonEmptyFile(previewPath))
      return response.status(404).json({
        success: false,
        error: "Reader preview PDF not found.",
      });
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader(
      "Cache-Control",
      accessGate.readerStreamCacheControlForRequest(request)
    );
    response.setHeader(
      "Content-Disposition",
      `inline; filename="${DOCX_PREVIEW_NAME}"`
    );
    return response.sendFile(previewPath);
  } catch (error) {
    return response.status(404).json({ success: false, error: error.message });
  }
}

async function thumbnail(request, response) {
  try {
    const workspace = response.locals.workspace;
    const readerDocumentId = documentsCore.assertReaderDocumentId(
      request.params.readerDocumentId
    );
    const documentRoot = documentsCore.readerDocumentRoot(
      workspace,
      readerDocumentId
    );
    await metadataForContentEndpoint({
      request,
      response,
      workspace,
      documentRoot,
      readerDocumentId,
      endpoint: "thumbnail",
    });
    const thumbnailPath = documentsCore.safeResolve(
      documentRoot,
      READER_THUMBNAIL_NAME
    );
    if (!documentsCore.validNonEmptyFile(thumbnailPath))
      return response.status(404).json({
        success: false,
        error: "Reader document thumbnail not found.",
      });
    response.setHeader("Content-Type", "image/jpeg");
    response.setHeader(
      "Content-Disposition",
      `inline; filename="${READER_THUMBNAIL_NAME}"`
    );
    return response.sendFile(thumbnailPath);
  } catch (error) {
    return response.status(404).json({ success: false, error: error.message });
  }
}

async function pagePreview(request, response) {
  try {
    const workspace = response.locals.workspace;
    const readerDocumentId = documentsCore.assertReaderDocumentId(
      request.params.readerDocumentId
    );
    const documentRoot = documentsCore.readerDocumentRoot(
      workspace,
      readerDocumentId
    );
    const metadata = await metadataForContentEndpoint({
      request,
      response,
      workspace,
      documentRoot,
      readerDocumentId,
      endpoint: "page-preview",
    });
    const contentAccess = accessGate.validateReaderContentAccess({
      request,
      response,
      workspace,
      readerDocumentId,
      endpoint: "page-preview",
    });
    if (!contentAccess.ok)
      return sendContentAccessDenied(response, contentAccess);
    if (!ingestCore.metadataIsPdf(metadata))
      return response.status(400).json({
        success: false,
        error: "Reader page preview is only available for PDFs.",
      });
    const originalPath = await documentsCore.originalPathForReaderDocument({
      documentRoot,
      metadata,
    });
    return await sendReaderPdfPagePreview({
      request,
      response,
      workspace,
      readerDocumentId,
      documentRoot,
      metadata,
      originalPath,
    });
  } catch (error) {
    return response.status(404).json({ success: false, error: error.message });
  }
}

async function original(request, response) {
  try {
    const workspace = response.locals.workspace;
    const readerDocumentId = documentsCore.assertReaderDocumentId(
      request.params.readerDocumentId
    );
    const documentRoot = documentsCore.readerDocumentRoot(
      workspace,
      readerDocumentId
    );
    const metadata = await metadataForContentEndpoint({
      request,
      response,
      workspace,
      documentRoot,
      readerDocumentId,
      endpoint: "original",
    });
    const contentAccess = accessGate.validateReaderContentAccess({
      request,
      response,
      workspace,
      readerDocumentId,
      endpoint: "original",
    });
    if (!contentAccess.ok)
      return sendContentAccessDenied(response, contentAccess);
    const originalPath = await documentsCore.originalPathForReaderDocument({
      documentRoot,
      metadata,
    });
    return originalStream.sendReaderOriginalFile({
      request,
      response,
      originalPath,
      metadata,
    });
  } catch (error) {
    return response.status(404).json({ success: false, error: error.message });
  }
}

module.exports = {
  original,
  pagePreview,
  previewPdf,
  sendReaderPdfPagePreview,
  thumbnail,
};
