const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { storagePath } = require("../../utils/environment");
const { validateReadPath } = require("../../utils/fileAccessPolicy");
const { isWithin } = require("../../utils/files/pathSafety");
const { atomicWriteJsonFile, safeReadJsonFile } = require("../../utils/safety");

const MAX_READER_FILE_SIZE = 500 * 1024 * 1024;
const READER_DELETE_MARKER_NAME = "delete-marker.json";
const READER_DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
const STANDALONE_READER_SCOPE = Object.freeze({
  slug: "global-reader",
  readerStorageSegment: "__global_reader__",
  readerApiPrefix: "/api/reader-documents",
  readerStandalone: true,
});

const readerDocumentsPath = storagePath("reader-documents");

function isoNow() {
  return new Date().toISOString();
}

function safeSegment(value, label) {
  const text = String(value || "");
  if (
    !text ||
    text.includes("..") ||
    path.isAbsolute(text) ||
    /[\\/]/.test(text)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

function safeWorkspaceSegment(workspace) {
  return safeSegment(workspace.slug, "workspace slug");
}

function assertReaderDocumentId(readerDocumentId) {
  const id = safeSegment(readerDocumentId, "reader document id");
  if (!READER_DOCUMENT_ID_PATTERN.test(id))
    throw new Error("Invalid reader document id.");
  return id;
}

function normalizedExtension(filename = "") {
  const ext = path.extname(String(filename).toLowerCase());
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, ext))
    throw new Error("Unsupported reader document type.");
  return ext;
}

function textScore(value = "") {
  const text = String(value || "");
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const mojibake = (text.match(/[\u0080-\u009fÃÂâäåæçèéêë]/g) || []).length;
  return cjk * 4 - mojibake;
}

function decodeMaybeMojibakeFilename(filename = "") {
  const original = String(filename || "");
  if (!original) return original;
  try {
    const decoded = Buffer.from(original, "latin1").toString("utf8");
    if (
      decoded &&
      decoded !== original &&
      textScore(decoded) > textScore(original)
    )
      return decoded;
  } catch {}
  return original;
}

function assertAllowedUpload(file) {
  if (!file) throw new Error("Missing file.");
  if (file.size > MAX_READER_FILE_SIZE)
    throw new Error("Reader document exceeds the 500MB limit.");
  const ext = normalizedExtension(
    decodeMaybeMojibakeFilename(file.originalname)
  );
  const mime = String(file.mimetype || "").toLowerCase();
  if (!ALLOWED_TYPES[ext].includes(mime))
    throw new Error("Reader document MIME type is not allowed.");
  return { ext, mime };
}

function safeResolve(root, ...segments) {
  const target = path.resolve(root, ...segments);
  if (target !== root && !isWithin(root, target))
    throw new Error("Invalid reader document path.");
  return target;
}

function readerWorkspaceRoot(workspace) {
  const root = path.resolve(readerDocumentsPath);
  const workspaceSegment =
    workspace?.readerStorageSegment || safeWorkspaceSegment(workspace);
  return safeResolve(root, workspaceSegment);
}

function readerDocumentRoot(workspace, readerDocumentId) {
  const workspaceRoot = readerWorkspaceRoot(workspace);
  const id = assertReaderDocumentId(readerDocumentId);
  return safeResolve(workspaceRoot, id);
}

function readerDeleteMarkerPath(documentRoot) {
  return safeResolve(documentRoot, READER_DELETE_MARKER_NAME);
}

function readReaderDeleteMarker(documentRoot) {
  const markerPath = readerDeleteMarkerPath(documentRoot);
  if (!fs.existsSync(markerPath)) return null;
  const result = safeReadJsonFile(markerPath, null, {
    context: { file: READER_DELETE_MARKER_NAME },
  });
  return result.ok ? result.value : { deleteStatus: "pending" };
}

function readerDocumentIsDeleted(documentRoot, metadata = null) {
  if (readReaderDeleteMarker(documentRoot)) return true;
  const status = String(metadata?.deleteStatus || "").toLowerCase();
  return !!(
    metadata?.deletedAt ||
    status === "pending" ||
    status === "deleted"
  );
}

function readReaderJsonFile(
  documentRoot,
  filename,
  fallback = null,
  context = {}
) {
  const filePath = safeResolve(documentRoot, filename);
  const result = safeReadJsonFile(filePath, fallback, {
    context: { file: filename, ...context },
  });
  if (!result.ok) {
    throw Object.assign(
      new Error(`Reader document ${filename} is unavailable.`),
      {
        code: "READER_DOCUMENT_JSON_UNAVAILABLE",
        detail: result.error,
      }
    );
  }
  return result.value;
}

function writeReaderJsonFile(documentRoot, filename, value) {
  const result = atomicWriteJsonFile(
    safeResolve(documentRoot, filename),
    value
  );
  if (!result.ok) {
    throw Object.assign(
      new Error(`Failed to write reader document ${filename}.`),
      {
        code: "READER_DOCUMENT_JSON_WRITE_FAILED",
        detail: result.error,
      }
    );
  }
  return value;
}

function readReaderContentAndMetadata(documentRoot, context = {}) {
  return {
    content: readReaderJsonFile(documentRoot, "content.json", null, context),
    metadata: readReaderJsonFile(documentRoot, "metadata.json", null, context),
  };
}

function readReaderMetadata(documentRoot, context = {}) {
  return readReaderJsonFile(documentRoot, "metadata.json", null, context);
}

function readerContentSummary({ content = null, metadata = null } = {}) {
  return {
    hasContent: !!content,
    documentType: content?.documentType || metadata?.documentType || null,
    size: metadata?.size || 0,
    pageCount: Array.isArray(content?.pages) ? content.pages.length : null,
    sectionCount: Array.isArray(content?.sections)
      ? content.sections.length
      : null,
    textLength:
      typeof content?.text === "string"
        ? content.text.length
        : typeof content?.markdown === "string"
          ? content.markdown.length
          : null,
  };
}

function validNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

async function validateLocalReaderPath(absolutePath, context = {}) {
  const validation = await validateReadPath(absolutePath, context);
  if (!validation.allowed) {
    const error = new Error(validation.message || "Local path is not allowed.");
    error.status = validation.reason === "path_not_found" ? 404 : 403;
    throw error;
  }
  const stat = fs.statSync(validation.path);
  if (!stat.isFile()) {
    const error = new Error("Local reader path must be a file.");
    error.status = 400;
    throw error;
  }
  if (stat.size > MAX_READER_FILE_SIZE) {
    const error = new Error("Reader document exceeds the 500MB limit.");
    error.status = 400;
    throw error;
  }
  return { absolutePath: validation.path, stat };
}

function storedOriginalPathForReaderDocument(documentRoot, metadata) {
  if (!metadata?.storedName) return null;
  const storedPath = safeResolve(documentRoot, metadata.storedName);
  return validNonEmptyFile(storedPath) ? storedPath : null;
}

async function originalPathForReaderDocument({ documentRoot, metadata }) {
  const storedPath = storedOriginalPathForReaderDocument(
    documentRoot,
    metadata
  );
  if (metadata.localPath) {
    try {
      return (await validateLocalReaderPath(metadata.localPath)).absolutePath;
    } catch (error) {
      if (storedPath) return storedPath;
      throw error;
    }
  }
  return storedPath;
}

function restoreReaderDocumentVisibility({ workspace, readerDocumentId }) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const metadata = readReaderMetadata(documentRoot, {
    readerDocumentId,
    endpoint: "restore-visibility",
  });
  const markerPath = readerDeleteMarkerPath(documentRoot);
  if (fs.existsSync(markerPath)) fs.rmSync(markerPath, { force: true });
  const {
    deletedAt: _deletedAt,
    deleteStatus: _deleteStatus,
    deleteRequestId: _deleteRequestId,
    ...nextMetadata
  } = metadata || {};
  writeReaderJsonFile(documentRoot, "metadata.json", nextMetadata);
  return nextMetadata;
}

function markReaderDocumentDeleted({
  workspace,
  readerDocumentId,
  metadata = {},
  request,
}) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const now = isoNow();
  const existingMarker = readReaderDeleteMarker(documentRoot);
  const marker = {
    schemaVersion: 1,
    readerDocumentId,
    deleteStatus: "pending",
    deletedAt: existingMarker?.deletedAt || now,
    deleteRequestId:
      existingMarker?.deleteRequestId ||
      request?.headers?.["x-request-id"] ||
      crypto.randomUUID(),
  };
  writeReaderJsonFile(documentRoot, READER_DELETE_MARKER_NAME, marker);
  try {
    writeReaderJsonFile(documentRoot, "metadata.json", {
      ...metadata,
      deletedAt: metadata.deletedAt || marker.deletedAt,
      deleteStatus: "pending",
      deleteRequestId: marker.deleteRequestId,
    });
  } catch {}
  return marker;
}

module.exports = {
  assertAllowedUpload,
  assertReaderDocumentId,
  decodeMaybeMojibakeFilename,
  markReaderDocumentDeleted,
  normalizedExtension,
  originalPathForReaderDocument,
  readReaderContentAndMetadata,
  readReaderJsonFile,
  readReaderMetadata,
  readerContentSummary,
  readerDocumentIsDeleted,
  readerDocumentRoot,
  readerWorkspaceRoot,
  restoreReaderDocumentVisibility,
  safeResolve,
  safeSegment,
  storedOriginalPathForReaderDocument,
  STANDALONE_READER_SCOPE,
  validateLocalReaderPath,
  validNonEmptyFile,
  writeReaderJsonFile,
};
