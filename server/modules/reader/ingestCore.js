const crypto = require("crypto");
const path = require("path");
const { normalizedExtension } = require("./documentsCore");

const SCHEMA_VERSION = 1;
const ALLOWED_TYPES = {
  ".md": ["text/markdown", "text/plain", "application/octet-stream"],
  ".markdown": ["text/markdown", "text/plain", "application/octet-stream"],
  ".pdf": ["application/pdf", "application/octet-stream"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/octet-stream",
  ],
  ".xlsx": [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
  ],
  ".epub": ["application/epub+zip", "application/octet-stream"],
};

function documentTypeFromExt(ext) {
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return ext.replace(".", "");
}

function fingerprintForBuffer(buffer) {
  return [
    buffer.length,
    crypto.createHash("sha256").update(buffer).digest("hex"),
  ].join(":");
}

function markdownBlocks(text = "") {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let buffer = [];
  let index = 0;
  const flush = () => {
    const content = buffer.join("\n").trim();
    if (!content) {
      buffer = [];
      return;
    }
    blocks.push({
      blockId: `block-${index++}`,
      type: /^#{1,6}\s/.test(content) ? "heading" : "paragraph",
      text: content,
    });
    buffer = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) flush();
    buffer.push(line);
  }
  flush();
  return blocks;
}

function contentForUpload({ readerDocumentId, documentType, buffer }) {
  if (documentType === "markdown") {
    const text = buffer.toString("utf8");
    return {
      schemaVersion: SCHEMA_VERSION,
      readerDocumentId,
      documentType,
      blocks: markdownBlocks(text),
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    documentType,
    ...(documentType === "xlsx" ? { sheets: [] } : {}),
    ...(documentType === "pdf" ? { pages: [] } : {}),
    ...(documentType === "docx" ? { blocks: [] } : {}),
    ...(documentType === "epub" ? { toc: [] } : {}),
  };
}

function parsedWorkspaceContent(readerDocumentId, data = {}) {
  const text = data.pageContent || "";
  return {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    documentType: "markdown",
    blocks: markdownBlocks(text),
    parsedOnly: true,
  };
}

function mimeForExt(ext) {
  return ALLOWED_TYPES[ext]?.find(
    (type) => type !== "application/octet-stream"
  );
}

function contentAndMetadataForLocalPath({
  readerDocumentId,
  source = "local_path",
  absolutePath,
  buffer,
  stat,
}) {
  const ext = normalizedExtension(absolutePath);
  const documentType = documentTypeFromExt(ext);
  const content = contentForUpload({
    readerDocumentId,
    documentType,
    buffer,
  });
  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    source,
    originalName: path.basename(absolutePath),
    storedName: null,
    localPath: absolutePath,
    mimeType: mimeForExt(ext) || "application/octet-stream",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    originalFingerprint: fingerprintForBuffer(buffer),
    createdAt: new Date().toISOString(),
  };

  return { content, metadata };
}

function documentTypeFromMetadata(metadata = {}) {
  const explicit =
    metadata.documentType ||
    metadata.stream?.documentType ||
    metadata.contentSummary?.documentType;
  if (explicit) return explicit;

  const mimeType = String(metadata.mimeType || metadata.stream?.mimeType || "")
    .trim()
    .toLowerCase();
  const ext = normalizedExtension(
    metadata.localPath ||
      metadata.storedName ||
      metadata.originalName ||
      metadata.previewPdfName ||
      ""
  );

  if (mimeType === "application/pdf" || ext === ".pdf") return "pdf";
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  )
    return "docx";
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ext === ".xlsx"
  )
    return "xlsx";
  if (mimeType === "application/epub+zip" || ext === ".epub") return "epub";
  if (mimeType === "text/markdown" || ext === ".md" || ext === ".markdown")
    return "markdown";
  return null;
}

function metadataIsMarkdown(metadata = {}) {
  try {
    const mimeType = String(metadata.mimeType || "").toLowerCase();
    const ext = normalizedExtension(
      metadata.localPath || metadata.storedName || metadata.originalName || ""
    );
    return (
      documentTypeFromMetadata(metadata) === "markdown" ||
      mimeType === "text/markdown" ||
      ext === ".md" ||
      ext === ".markdown"
    );
  } catch {
    return false;
  }
}

function metadataIsPdf(metadata = {}) {
  try {
    const mimeType = String(metadata.mimeType || "").toLowerCase();
    return (
      mimeType === "application/pdf" ||
      normalizedExtension(
        metadata.localPath || metadata.storedName || metadata.originalName || ""
      ) === ".pdf"
    );
  } catch {
    return false;
  }
}

module.exports = {
  contentAndMetadataForLocalPath,
  contentForUpload,
  documentTypeFromExt,
  documentTypeFromMetadata,
  fingerprintForBuffer,
  markdownBlocks,
  metadataIsMarkdown,
  metadataIsPdf,
  mimeForExt,
  parsedWorkspaceContent,
};
