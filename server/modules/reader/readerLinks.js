const fs = require("fs");
const {
  stripFileBackedOwnerMetadata,
} = require("../../utils/authz/resourceAccess");
const documentsCore = require("./documentsCore");
const ingestCore = require("./ingestCore");
const previewPipeline = require("./previewPipeline");

const DOCX_PREVIEW_NAME = "preview.pdf";
const READER_THUMBNAIL_NAME = "thumbnail.jpg";
const READER_STREAM_CACHE_CONTROL = "private, max-age=604800, no-transform";

function validNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function readerApiPrefix(workspace) {
  if (workspace?.readerApiPrefix) return workspace.readerApiPrefix;
  return `/api/workspace/${workspace.slug}/reader-documents`;
}

function previewUrlForDocument(workspace, readerDocumentId) {
  return `${readerApiPrefix(workspace)}/${readerDocumentId}/preview.pdf`;
}

function thumbnailUrlForDocument(workspace, readerDocumentId) {
  return `${readerApiPrefix(workspace)}/${readerDocumentId}/thumbnail.jpg`;
}

function originalUrlForDocument(workspace, readerDocumentId) {
  return `${readerApiPrefix(workspace)}/${readerDocumentId}/original`;
}

function pagePreviewUrlForDocument(workspace, readerDocumentId) {
  return `${readerApiPrefix(workspace)}/${readerDocumentId}/page-preview`;
}

function existingThumbnailUrlForDocument(workspace, readerDocumentId) {
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  if (documentsCore.readerDocumentIsDeleted(documentRoot)) return null;
  const thumbnailPath = documentsCore.safeResolve(
    documentRoot,
    READER_THUMBNAIL_NAME
  );
  if (!validNonEmptyFile(thumbnailPath)) return null;
  return thumbnailUrlForDocument(workspace, readerDocumentId);
}

function metadataWithOriginalUrl(workspace, readerDocumentId, metadata) {
  const publicMetadata = stripFileBackedOwnerMetadata(metadata);
  const documentType = ingestCore.documentTypeFromMetadata(publicMetadata);
  const originalUrl = originalUrlForDocument(workspace, readerDocumentId);
  const pagePreviewUrl = pagePreviewUrlForDocument(workspace, readerDocumentId);
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  const hasPreviewPdf =
    Boolean(publicMetadata.previewPdfName) &&
    validNonEmptyFile(
      documentsCore.safeResolve(documentRoot, DOCX_PREVIEW_NAME)
    );
  const thumbnailUrl = existingThumbnailUrlForDocument(
    workspace,
    readerDocumentId
  );
  const size = Number(publicMetadata.size || 0);
  const etag =
    publicMetadata.originalFingerprint ||
    publicMetadata.fingerprint ||
    publicMetadata.previewFingerprint ||
    null;
  const pdfManifest = publicMetadata.pdfManifest || null;
  return {
    ...publicMetadata,
    documentType,
    originalName: documentsCore.decodeMaybeMojibakeFilename(
      publicMetadata.originalName
    ),
    ...(previewPipeline.metadataNeedsPdfPreview(publicMetadata) &&
    !hasPreviewPdf
      ? {
          previewPdfName: null,
          previewPdfUrl: null,
          previewMimeType: null,
          previewStatus:
            publicMetadata.previewStatus === "failed" ||
            publicMetadata.previewWarning ||
            publicMetadata.previewLastError
              ? "failed"
              : publicMetadata.previewStatus || "missing",
        }
      : {}),
    readerDocumentWorkspaceSlug: workspace?.readerStandalone
      ? null
      : workspace?.slug || publicMetadata.readerDocumentWorkspaceSlug || null,
    originalUrl,
    stream: {
      streamUrl: originalUrl,
      url: originalUrl,
      size,
      etag,
      supportsRange: true,
      cacheControl: READER_STREAM_CACHE_CONTROL,
      mimeType: publicMetadata.mimeType || "application/octet-stream",
      documentType,
    },
    ...(ingestCore.metadataIsPdf(publicMetadata)
      ? {
          pagePreviewUrl,
          pdfManifest,
        }
      : {}),
    ...(hasPreviewPdf
      ? {
          previewPdfUrl: previewUrlForDocument(workspace, readerDocumentId),
          previewMimeType: "application/pdf",
          previewStatus: "ready",
          previewWarning: null,
          previewLastError: null,
        }
      : {}),
    ...(thumbnailUrl
      ? {
          thumbnailUrl,
          thumbnailMimeType: "image/jpeg",
        }
      : {}),
  };
}

module.exports = {
  existingThumbnailUrlForDocument,
  metadataWithOriginalUrl,
  originalUrlForDocument,
  pagePreviewUrlForDocument,
  previewUrlForDocument,
  readerApiPrefix,
  thumbnailUrlForDocument,
};
