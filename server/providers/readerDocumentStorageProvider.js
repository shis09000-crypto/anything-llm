const fs = require("fs");
const path = require("path");
const readerModule = require("../endpoints/workspaceReaderDocuments");
const { sanitizeValue } = require("../utils/dataAccess/dataAccessPolicy");

const reader = readerModule._private;

function nonEmptyFile(filePath = null) {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function safeMetadataSummary(metadata = {}) {
  const sanitized = sanitizeValue(metadata) || {};
  return {
    readerDocumentId: sanitized.readerDocumentId || null,
    documentType: sanitized.documentType || null,
    mimeType: sanitized.mimeType || null,
    originalName: sanitized.originalName || null,
    title: sanitized.title || sanitized.displayTitle || null,
    size: sanitized.size || null,
    previewStatus: sanitized.previewStatus || null,
    thumbnailStatus: sanitized.thumbnailStatus || null,
    classificationStatus: sanitized.classificationStatus || null,
    availability:
      sanitized.availability || sanitized.readerAvailability || null,
    deleteStatus: sanitized.deleteStatus || null,
    deletedAt: sanitized.deletedAt || null,
    createdAt: sanitized.createdAt || null,
    updatedAt: sanitized.updatedAt || null,
  };
}

function previewFileName(metadata = {}) {
  return path.basename(String(metadata.previewPdfName || "preview.pdf"));
}

function originalFileName(metadata = {}) {
  const name = metadata.storedName || metadata.originalName || null;
  return name ? path.basename(String(name)) : null;
}

function resolve({ workspace, readerDocumentId }) {
  const id = reader.assertReaderDocumentId(readerDocumentId);
  const root = reader.readerDocumentRoot(workspace, id);
  const metadata = reader.readReaderMetadata(root, {
    readerDocumentId: id,
    endpoint: "reader-storage-provider",
  });
  const canonical = reader.metadataWithOriginalUrl(workspace, id, metadata);
  const originalName = originalFileName(metadata);
  const originalPath = originalName ? path.join(root, originalName) : null;
  const previewPath = path.join(root, previewFileName(metadata));
  const thumbnailPath = path.join(root, "thumbnail.jpg");
  return {
    workspaceSlug: workspace?.readerStandalone ? null : workspace?.slug || null,
    standalone: workspace?.readerStandalone === true,
    readerDocumentId: id,
    root,
    metadata,
    canonical,
    originalPath,
    previewPath,
    thumbnailPath,
  };
}

const ReaderDocumentStorageProvider = {
  resolve,

  status(options = {}) {
    const resolved = resolve(options);
    const postprocess = reader.readerPostprocessResponse(
      options.workspace,
      resolved.readerDocumentId
    );
    return {
      readerDocumentId: resolved.readerDocumentId,
      workspaceSlug: resolved.workspaceSlug,
      standalone: resolved.standalone,
      deleted: reader.readerDocumentIsDeleted(resolved.root, resolved.metadata),
      files: {
        original: nonEmptyFile(resolved.originalPath),
        preview: nonEmptyFile(resolved.previewPath),
        thumbnail: nonEmptyFile(resolved.thumbnailPath),
      },
      urls: {
        original: !!resolved.canonical.originalUrl,
        previewPdf: !!resolved.canonical.previewPdfUrl,
        thumbnail: !!resolved.canonical.thumbnailUrl,
      },
      metadata: safeMetadataSummary(resolved.metadata),
      postprocess: postprocess?.postprocess || null,
    };
  },

  canonicalDescriptor(options = {}) {
    const resolved = resolve(options);
    return {
      readerDocumentId: resolved.readerDocumentId,
      workspaceSlug: resolved.workspaceSlug,
      standalone: resolved.standalone,
      resourceId: `${resolved.workspaceSlug || "standalone"}:${
        resolved.readerDocumentId
      }`,
      hasOriginalUrl: !!resolved.canonical.originalUrl,
      hasPreviewPdfUrl: !!resolved.canonical.previewPdfUrl,
      hasThumbnailUrl: !!resolved.canonical.thumbnailUrl,
      metadata: safeMetadataSummary(resolved.metadata),
    };
  },
};

module.exports = { ReaderDocumentStorageProvider };
