const { hashLogValue, redactLogObject } = require("../security/redaction");

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|credential|authorization|cookie|apikey|api[-_]?key|signing|sessionSecret|sensitiveSession|originalUrl|previewPdfUrl|pagePreviewUrl|absolutePath|localPath|filePath|docPath|stream|content|text|markdown|body|raw)/i;

function safeHash(value = "") {
  return hashLogValue(value);
}

function redactDeveloperValue(key, value) {
  if (SENSITIVE_KEY_PATTERN.test(String(key))) {
    if (key === "readerDocumentId" || key === "workspaceSlug") return value;
    return `[redacted:${safeHash(value)}]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => redactDeveloperValue(key, entry));
  }
  if (value && typeof value === "object") return redactDeveloperObject(value);
  if (typeof value === "string" && value.length > 1_000) {
    return `${value.slice(0, 1_000)}…`;
  }
  return value;
}

function redactDeveloperObject(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return redactDeveloperValue("value", value);
  }
  return redactLogObject(
    Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactDeveloperValue(key, entry),
      ])
    )
  );
}

function safeReaderMetadataSummary(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return null;
  return redactDeveloperObject({
    readerDocumentId: metadata.readerDocumentId || null,
    source: metadata.source || null,
    originalNameHash: metadata.originalName
      ? safeHash(metadata.originalName)
      : null,
    documentType: metadata.documentType || null,
    mimeType: metadata.mimeType || null,
    size: metadata.size || 0,
    createdAt: metadata.createdAt || null,
    updatedAt: metadata.updatedAt || null,
    uploadedOriginalNameHash: metadata.uploadedOriginalName
      ? safeHash(metadata.uploadedOriginalName)
      : null,
    hasThumbnail: !!metadata.thumbnailName || !!metadata.thumbnailUrl,
    thumbnailGeneratedAt: metadata.thumbnailGeneratedAt || null,
    deleteStatus: metadata.deleteStatus || null,
    deletedAt: metadata.deletedAt || null,
    previewWarning: metadata.previewWarning || null,
    parsedOnly: !!metadata.parsedOnly,
    pdfManifest: metadata.pdfManifest
      ? {
          pageCount: metadata.pdfManifest.pageCount || null,
          chunkSize: metadata.pdfManifest.chunkSize || null,
          generatedAt: metadata.pdfManifest.generatedAt || null,
        }
      : null,
  });
}

module.exports = {
  redactDeveloperObject,
  safeHash,
  safeReaderMetadataSummary,
};
