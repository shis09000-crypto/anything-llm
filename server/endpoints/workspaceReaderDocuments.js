const crypto = require("crypto");
const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const multer = require("multer");
const AdmZip = require("adm-zip");
const cheerio = require("cheerio");
const ExcelJS = require("exceljs");
const PQueue = require("p-queue").default;
const sharp = require("sharp");
const {
  DocumentRepository: Document,
} = require("../repositories/documentRepository");
const { validateReadPath } = require("../utils/fileAccessPolicy");
const { fileData, isWithin, normalizePath } = require("../utils/files");
const {
  getTaskConnector,
  resolveTaskProviderModel,
} = require("../utils/llmTasks");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { atomicWriteJsonFile, safeReadJsonFile } = require("../utils/safety");
const {
  DEFAULT_BASE_URL: DEFAULT_ALIBABA_OCR_BASE_URL,
  DEFAULT_MODEL: DEFAULT_ALIBABA_OCR_MODEL,
  assertImageDataUrl,
  recognizeImage,
} = require("../utils/OcrProviders/alibaba");
const { storagePath } = require("../utils/environment");
const {
  fileBackedOwnerMetadata,
  getAuthorizedWorkspace,
  getAuthorizedFileBackedResource,
  requestAuthContext,
  stripFileBackedOwnerMetadata,
} = require("../utils/authz/resourceAccess");
const {
  getClientContext,
  recordClientTrustCheckpoint,
} = require("../utils/clientIdentity");
const { hashLogValue } = require("../utils/security/redaction");
const {
  authSessionFingerprintFromRequest,
} = require("../utils/authz/vaultAccessGrants");
const {
  issueSensitiveSession,
  sensitiveSessionTokenFromRequest,
  validateSensitiveSessionForRequest,
} = require("../utils/authz/sensitiveSessions");
const { publishBroadcastEvent } = require("../utils/broadcast");
const { userFromSession } = require("../utils/http");

const SCHEMA_VERSION = 1;
const MAX_READER_FILE_SIZE = 500 * 1024 * 1024;

function includeUploadContent(request) {
  const value = request.query?.includeContent;
  return value === "1" || value === "true";
}

function includeReaderDocumentContent(request) {
  const detail = String(request.query?.detail || "metadata").toLowerCase();
  return detail === "content" || detail === "full";
}
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

const readerDocumentsPath = storagePath("reader-documents");
const DOCX_PREVIEW_NAME = "preview.pdf";
const DOCX_PREVIEW_TIMEOUT_MS = 45_000;
const docxPreviewJobs = new Map();
const READER_PREVIEW_REQUIRED_FONTS = [
  "Noto Sans CJK SC",
  "Noto Serif CJK SC",
  "Noto Color Emoji",
  "Liberation Serif",
];
const READER_THUMBNAIL_NAME = "thumbnail.jpg";
const READER_DELETE_MARKER_NAME = "delete-marker.json";
const READER_POSTPROCESS_STATUS_NAME = "postprocess.json";
const READER_PDF_MANIFEST_NAME = "pdf-manifest.json";
const READER_POSTPROCESS_TEXT_LIMIT = 100_000;
const READER_DUPLICATE_LEAD_TEXT_CHARS = 100;
const READER_THUMBNAIL_MAINTENANCE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.READER_THUMBNAIL_MAINTENANCE_INTERVAL_MS) ||
    30 * 60 * 1_000
);
const READER_THUMBNAIL_MAINTENANCE_BATCH_SIZE = Math.max(
  1,
  Number(process.env.READER_THUMBNAIL_MAINTENANCE_BATCH_SIZE) || 24
);
const READER_THUMBNAIL_WIDTH = 360;
const READER_THUMBNAIL_HEIGHT = 520;
const READER_THUMBNAIL_QUALITY = 88;
const READER_PDF_THUMBNAIL_TIMEOUT_MS = 30_000;
const READER_PDF_PAGE_PREVIEW_TIMEOUT_MS = 18_000;
const READER_PDF_PAGE_PREVIEW_DPI = 96;
const READER_PDF_PAGE_PREVIEW_QUALITY = 74;
const READER_PDF_PREWARM_MIN_BYTES = 10 * 1024 * 1024;
const READER_PDF_PREVIEW_PREBUILD_MAX_PAGES = Math.max(
  24,
  Number(process.env.READER_PDF_PREVIEW_PREBUILD_MAX_PAGES) || 800
);
const READER_PDF_PREVIEW_PREBUILD_INITIAL_PAGES = Math.max(
  4,
  Number(process.env.READER_PDF_PREVIEW_PREBUILD_INITIAL_PAGES) || 18
);
const READER_PDF_PREVIEW_NEARBY_BEFORE = Math.max(
  1,
  Number(process.env.READER_PDF_PREVIEW_NEARBY_BEFORE) || 4
);
const READER_PDF_PREVIEW_NEARBY_AFTER = Math.max(
  1,
  Number(process.env.READER_PDF_PREVIEW_NEARBY_AFTER) || 8
);
const READER_PDF_PREVIEW_PREBUILD_PAUSE_MS = Math.max(
  0,
  Number(process.env.READER_PDF_PREVIEW_PREBUILD_PAUSE_MS) || 35
);
const READER_POSTPROCESS_QUEUE_CONCURRENCY = Math.max(
  1,
  Number(process.env.READER_POSTPROCESS_QUEUE_CONCURRENCY) || 1
);
const READER_POSTPROCESS_AUTO_POLL_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.READER_POSTPROCESS_AUTO_POLL_TIMEOUT_MS) || 45_000
);
const READER_STREAM_CACHE_CONTROL = "private, max-age=604800, no-transform";
const READER_SENSITIVE_STREAM_CACHE_CONTROL =
  "private, no-store, max-age=0, must-revalidate, no-transform";
const readerPostprocessJobs = new Map();
const readerDeleteJobs = new Map();
const readerPostprocessCancelRequests = new Set();
const readerPdfManifestJobs = new Map();
const readerPdfPagePreviewJobs = new Map();
const readerPdfPreviewPrebuildJobs = new Map();
const readerPostprocessQueue = new PQueue({
  concurrency: READER_POSTPROCESS_QUEUE_CONCURRENCY,
});
let readerThumbnailMaintenanceStarted = false;
const CLASSIFICATION_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.READER_CLASSIFICATION_TIMEOUT_MS) || 20_000
);
const CLASSIFICATION_LLM_TEXT_LIMIT = 3_000;
const CLASSIFICATION_CONFIDENCE_THRESHOLD = 0.55;
const STANDALONE_READER_SCOPE = Object.freeze({
  slug: "global-reader",
  readerStorageSegment: "__global_reader__",
  readerApiPrefix: "/api/reader-documents",
  readerStandalone: true,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_READER_FILE_SIZE },
}).single("file");

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

function readerOcrConfigStatus(env = process.env) {
  const provider = String(env.READER_OCR_PROVIDER || "none").trim();
  if (provider === "none") {
    return {
      success: true,
      configured: false,
      provider,
      modelConfigured: false,
      apiKeyConfigured: false,
      baseUrlConfigured: false,
      reason: "disabled",
    };
  }

  if (provider !== "alibaba") {
    return {
      success: true,
      configured: false,
      provider,
      modelConfigured: false,
      apiKeyConfigured: false,
      baseUrlConfigured: false,
      reason: "invalid_provider",
    };
  }

  const model = String(env.READER_OCR_MODEL_PREF || "").trim();
  const apiKey = String(env.READER_OCR_API_KEY || "").trim();
  const baseUrl = String(env.READER_OCR_BASE_URL || "").trim();
  const modelConfigured = model.length > 0;
  const apiKeyConfigured = apiKey.length > 0;
  const baseUrlConfigured = baseUrl.length > 0;
  const configured = modelConfigured && apiKeyConfigured && baseUrlConfigured;
  const reason = configured
    ? "configured"
    : !modelConfigured && !apiKeyConfigured && !baseUrlConfigured
      ? "missing_model_api_key_and_base_url"
      : !modelConfigured
        ? "missing_model"
        : !apiKeyConfigured
          ? "missing_api_key"
          : "missing_base_url";

  return {
    success: true,
    configured,
    provider,
    modelConfigured,
    apiKeyConfigured,
    baseUrlConfigured,
    reason,
  };
}

function readerOcrProviderOptions(env = process.env) {
  const status = readerOcrConfigStatus(env);
  if (!status.configured) {
    const error = new Error(`Reader OCR is not configured: ${status.reason}`);
    error.status = 400;
    throw error;
  }
  return {
    provider: status.provider,
    model: String(
      env.READER_OCR_MODEL_PREF || DEFAULT_ALIBABA_OCR_MODEL
    ).trim(),
    apiKey: String(env.READER_OCR_API_KEY || "").trim(),
    baseUrl: String(
      env.READER_OCR_BASE_URL || DEFAULT_ALIBABA_OCR_BASE_URL
    ).trim(),
  };
}

async function recognizeReaderScreenshot(payload = {}, env = process.env) {
  const imageDataUrl = assertImageDataUrl(payload.imageDataUrl);
  const options = readerOcrProviderOptions(env);
  if (options.provider !== "alibaba") {
    const error = new Error("Unsupported OCR provider.");
    error.status = 400;
    throw error;
  }

  const startedAt = Date.now();
  const result = await recognizeImage({
    imageDataUrl,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
  });
  return {
    success: true,
    provider: options.provider,
    model: options.model,
    text: result.text || "",
    durationMs: Date.now() - startedAt,
  };
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

function documentTypeFromExt(ext) {
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return ext.replace(".", "");
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isUsableLibreOfficeBinary(filePath) {
  if (!filePath || !fileExists(filePath)) return false;
  try {
    execFileSync(filePath, ["--version"], {
      timeout: 3_000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function executableVersion(filePath, args = ["--version"]) {
  if (!filePath || !fileExists(filePath)) return null;
  try {
    return String(
      execFileSync(filePath, args, {
        timeout: 3_000,
        stdio: "pipe",
      })
    ).trim();
  } catch {
    return null;
  }
}

function findOnPath(binary) {
  const paths = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const entry of paths) {
    const candidate = path.resolve(entry, binary);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function findLibreOfficeBinary() {
  const candidates = [
    process.env.LIBREOFFICE_BIN,
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    findOnPath("soffice"),
    findOnPath("libreoffice"),
  ].filter(Boolean);
  return (
    candidates.find((candidate) => isUsableLibreOfficeBinary(candidate)) || null
  );
}

function fontStatusForPreview() {
  const fcMatch = findOnPath("fc-match");
  if (!fcMatch) {
    return {
      available: false,
      checker: null,
      required: READER_PREVIEW_REQUIRED_FONTS.map((font) => ({
        font,
        available: false,
      })),
    };
  }
  const required = READER_PREVIEW_REQUIRED_FONTS.map((font) => {
    try {
      const output = String(
        execFileSync(fcMatch, [font], {
          timeout: 2_000,
          stdio: "pipe",
        })
      ).trim();
      return {
        font,
        available: Boolean(output),
        matched: output.split("\n")[0] || null,
      };
    } catch {
      return { font, available: false, matched: null };
    }
  });
  return {
    available: required.some((item) => item.available),
    checker: fcMatch,
    required,
  };
}

function readerPreviewEngineStatus() {
  const libreOfficeBinary = findLibreOfficeBinary();
  let markdownAvailable = false;
  let markdownError = null;
  try {
    require.resolve("@mintplex-labs/mdpdf");
    markdownAvailable = true;
  } catch (error) {
    markdownError = error.message || "Markdown PDF preview engine unavailable.";
  }
  return {
    docx: {
      engine: "libreoffice",
      available: Boolean(libreOfficeBinary),
      binary: libreOfficeBinary,
      version: libreOfficeBinary ? executableVersion(libreOfficeBinary) : null,
      timeoutMs: DOCX_PREVIEW_TIMEOUT_MS,
      lastError: libreOfficeBinary ? null : "LibreOffice is not available.",
    },
    markdown: {
      engine: "mdpdf",
      available: markdownAvailable,
      version: null,
      lastError: markdownError,
    },
    fonts: fontStatusForPreview(),
  };
}

function previewEngineForMetadata(metadata = {}) {
  return metadataIsMarkdown(metadata) ? "mdpdf" : "libreoffice";
}

function previewEngineVersionForMetadata(metadata = {}) {
  if (metadataIsMarkdown(metadata)) return null;
  const binary = findLibreOfficeBinary();
  return binary ? executableVersion(binary) : null;
}

function fingerprintForBuffer(buffer) {
  return [
    buffer.length,
    crypto.createHash("sha256").update(buffer).digest("hex"),
  ].join(":");
}

function validNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
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

function assertReaderDocumentVisible(documentRoot, metadata = null) {
  if (!readerDocumentIsDeleted(documentRoot, metadata)) return;
  throw readerDocumentNotFoundError();
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

function enqueueReaderDocumentDelete({ workspace, readerDocumentId }) {
  const key = readerPostprocessKey(workspace, readerDocumentId);
  if (readerDeleteJobs.has(key)) return;
  const job = Promise.resolve()
    .then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
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

function existingThumbnailUrlForDocument(workspace, readerDocumentId) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  if (readerDocumentIsDeleted(documentRoot)) return null;
  const thumbnailPath = safeResolve(documentRoot, READER_THUMBNAIL_NAME);
  if (!validNonEmptyFile(thumbnailPath)) return null;
  return thumbnailUrlForDocument(workspace, readerDocumentId);
}

function metadataIsDocx(metadata = {}) {
  try {
    const mimeType = String(metadata.mimeType || "").toLowerCase();
    return (
      documentTypeFromMetadata(metadata) === "docx" ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      normalizedExtension(
        metadata.localPath || metadata.storedName || metadata.originalName || ""
      ) === ".docx"
    );
  } catch {
    return false;
  }
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

function metadataNeedsPdfPreview(metadata = {}) {
  return metadataIsDocx(metadata) || metadataIsMarkdown(metadata);
}

function previewDocumentLabel(metadata = {}) {
  return metadataIsMarkdown(metadata) ? "Markdown" : "DOCX";
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

async function finalizeReaderDocumentMetadata({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
  buffer = null,
  waitForDocxPreview = true,
}) {
  const fingerprint = buffer
    ? fingerprintForBuffer(buffer)
    : fingerprintForBuffer(fs.readFileSync(originalPath));
  const nextMetadata = {
    ...metadata,
    originalFingerprint: fingerprint,
  };
  if (!waitForDocxPreview) {
    scheduleDocxPreviewMetadataUpdate({
      workspace,
      readerDocumentId,
      metadata: nextMetadata,
      originalPath,
      fingerprint,
    });
    return nextMetadata;
  }
  return await ensureDocxPreview({
    workspace,
    readerDocumentId,
    metadata: nextMetadata,
    originalPath,
    fingerprint,
  });
}

function scheduleDocxPreviewMetadataUpdate({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
  fingerprint,
}) {
  if (!metadataNeedsPdfPreview(metadata)) return;
  const previewLabel = previewDocumentLabel(metadata);
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
    postprocessTaskPatch(status, "preview", {
      status: "processing",
      reason: `正在生成 ${previewLabel} 预览`,
    })
  );
  ensureDocxPreview({
    workspace,
    readerDocumentId,
    metadata,
    originalPath,
    fingerprint,
  })
    .then((finalMetadata) => {
      writeReaderJsonFile(documentRoot, "metadata.json", finalMetadata);
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessTaskPatch(status, "preview", {
          status: finalMetadata.previewPdfUrl ? "complete" : "failed",
          reason: finalMetadata.previewPdfUrl
            ? ""
            : finalMetadata.previewWarning || `${previewLabel} 预览生成失败。`,
        })
      );
    })
    .catch((error) => {
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessTaskPatch(status, "preview", {
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

function writeReaderDocumentFiles(
  workspace,
  readerDocumentId,
  content,
  metadata
) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  fs.mkdirSync(documentRoot, { recursive: true });
  writeReaderJsonFile(documentRoot, "content.json", content);
  writeReaderJsonFile(documentRoot, "metadata.json", metadata);
  return documentRoot;
}

function execFileWithTimeout(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: DOCX_PREVIEW_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 4,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          const reason =
            error.killed || error.signal
              ? "PDF preview conversion timed out."
              : stderr || stdout || error.message;
          return reject(new Error(String(reason).trim()));
        }
        return resolve({ stdout, stderr });
      }
    );
  });
}

function cleanupTempDir(tempDir) {
  if (!tempDir) return;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function convertDocxToPreviewWithLibreOffice({
  documentRoot,
  originalPath,
  tempDir,
}) {
  const libreOfficeBinary = findLibreOfficeBinary();
  if (!libreOfficeBinary) throw new Error("LibreOffice is not available.");

  await execFileWithTimeout(libreOfficeBinary, [
    "--headless",
    "--nologo",
    "--nofirststartwizard",
    "--convert-to",
    "pdf",
    "--outdir",
    tempDir,
    originalPath,
  ]);

  const expectedOutput = path.join(
    tempDir,
    `${path.basename(originalPath, path.extname(originalPath))}.pdf`
  );
  const fallbackOutput = fs
    .readdirSync(tempDir)
    .map((name) => path.join(tempDir, name))
    .find(
      (candidate) => /\.pdf$/i.test(candidate) && validNonEmptyFile(candidate)
    );
  const previewOutput = validNonEmptyFile(expectedOutput)
    ? expectedOutput
    : fallbackOutput;
  if (!previewOutput)
    throw new Error("LibreOffice produced an empty DOCX preview PDF.");

  const previewPath = safeResolve(documentRoot, DOCX_PREVIEW_NAME);
  fs.copyFileSync(previewOutput, previewPath);
  if (!validNonEmptyFile(previewPath))
    throw new Error("DOCX preview PDF failed validation.");
  return { previewPath, source: "libreoffice" };
}

async function convertDocxToPreview({ documentRoot, originalPath }) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-docx-preview-")
  );
  try {
    return await convertDocxToPreviewWithLibreOffice({
      documentRoot,
      originalPath,
      tempDir,
    });
  } catch (error) {
    fs.rmSync(safeResolve(documentRoot, DOCX_PREVIEW_NAME), { force: true });
    throw error;
  } finally {
    cleanupTempDir(tempDir);
  }
}

async function convertMarkdownToPreview({ documentRoot, originalPath }) {
  try {
    const { markdownToPdf } = require("@mintplex-labs/mdpdf");
    const markdown = fs.readFileSync(originalPath, "utf8");
    const pdfBuffer = await markdownToPdf(markdown);
    const previewPath = safeResolve(documentRoot, DOCX_PREVIEW_NAME);
    fs.writeFileSync(previewPath, pdfBuffer);
    if (!validNonEmptyFile(previewPath))
      throw new Error("Markdown preview PDF failed validation.");
    return { previewPath, source: "mdpdf" };
  } catch (error) {
    fs.rmSync(safeResolve(documentRoot, DOCX_PREVIEW_NAME), { force: true });
    throw error;
  }
}

async function convertReaderDocumentToPreview({
  documentRoot,
  originalPath,
  metadata,
}) {
  if (metadataIsMarkdown(metadata))
    return await convertMarkdownToPreview({ documentRoot, originalPath });
  return await convertDocxToPreview({ documentRoot, originalPath });
}

async function ensureDocxPreview({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
  fingerprint,
}) {
  if (!metadataNeedsPdfPreview(metadata)) return metadata;
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const previewPath = safeResolve(documentRoot, DOCX_PREVIEW_NAME);
  const attemptedAt = new Date().toISOString();
  const nextAttemptCount = Number(metadata.previewAttemptCount || 0) + 1;
  const hasFreshPreview =
    metadata.previewFingerprint === fingerprint &&
    validNonEmptyFile(previewPath);

  if (hasFreshPreview) {
    return {
      ...metadata,
      previewPdfName: DOCX_PREVIEW_NAME,
      previewMimeType: "application/pdf",
      previewPdfUrl: previewUrlForDocument(workspace, readerDocumentId),
      previewStatus: "ready",
      previewWarning: null,
      previewLastError: null,
    };
  }

  const jobKey = `${workspace?.readerStorageSegment || safeWorkspaceSegment(workspace)}:${readerDocumentId}:${fingerprint}`;
  if (docxPreviewJobs.has(jobKey)) return await docxPreviewJobs.get(jobKey);

  const job = (async () => {
    try {
      const preview = await convertReaderDocumentToPreview({
        documentRoot,
        originalPath,
        metadata,
      });
      return {
        ...metadata,
        previewPdfName: DOCX_PREVIEW_NAME,
        previewMimeType: "application/pdf",
        previewPdfUrl: previewUrlForDocument(workspace, readerDocumentId),
        previewStatus: "ready",
        previewAttemptedAt: attemptedAt,
        previewAttemptCount: nextAttemptCount,
        previewGeneratedAt: new Date().toISOString(),
        previewSource: preview.source,
        previewEngineVersion: previewEngineVersionForMetadata(metadata),
        previewFingerprint: fingerprint,
        previewWarning: null,
        previewLastError: null,
      };
    } catch (error) {
      fs.rmSync(previewPath, { force: true });
      const previewError =
        error.message ||
        `${previewDocumentLabel(metadata)} preview conversion failed.`;
      return {
        ...metadata,
        previewPdfName: null,
        previewMimeType: null,
        previewPdfUrl: null,
        previewStatus: "failed",
        previewAttemptedAt: attemptedAt,
        previewAttemptCount: nextAttemptCount,
        previewGeneratedAt: null,
        previewSource: previewEngineForMetadata(metadata),
        previewEngineVersion: previewEngineVersionForMetadata(metadata),
        previewFingerprint: fingerprint,
        previewWarning: previewError,
        previewLastError: previewError,
      };
    }
  })();

  docxPreviewJobs.set(jobKey, job);
  try {
    return await job;
  } finally {
    docxPreviewJobs.delete(jobKey);
  }
}

function metadataWithOriginalUrl(workspace, readerDocumentId, metadata) {
  const publicMetadata = stripFileBackedOwnerMetadata(metadata);
  const documentType = documentTypeFromMetadata(publicMetadata);
  const originalUrl = `${readerApiPrefix(workspace)}/${readerDocumentId}/original`;
  const pagePreviewUrl = `${readerApiPrefix(workspace)}/${readerDocumentId}/page-preview`;
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const hasPreviewPdf =
    Boolean(publicMetadata.previewPdfName) &&
    validNonEmptyFile(safeResolve(documentRoot, DOCX_PREVIEW_NAME));
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
    originalName: decodeMaybeMojibakeFilename(publicMetadata.originalName),
    ...(metadataNeedsPdfPreview(publicMetadata) && !hasPreviewPdf
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
    ...(metadataIsPdf(publicMetadata)
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

async function readerOwnerMetadataForRequest(request, response) {
  const user =
    response?.locals?.user ||
    (await userFromSession(request, response)) ||
    (await requestAuthContext({ request, response })).user ||
    null;
  return fileBackedOwnerMetadata(user);
}

function readerDocumentNotFoundError() {
  const error = new Error("Reader document not found.");
  error.status = 404;
  return error;
}

function readerSensitiveOwnerScope(workspace) {
  return workspace?.readerStandalone
    ? "reader:standalone"
    : `workspace:${workspace?.slug || "unknown"}:reader`;
}

function readerSensitiveResourceId(workspace, readerDocumentId) {
  const owner =
    workspace?.readerStorageSegment ||
    workspace?.slug ||
    (workspace?.readerStandalone ? "standalone" : "unknown");
  return `${owner}:${readerDocumentId}`;
}

function readerSensitiveSessionForResponse(
  request,
  response,
  workspace,
  readerDocumentId,
  method = "reader-document-open"
) {
  const userId = Number(response?.locals?.user?.id || 0);
  const context = getClientContext(request);
  if (!userId || !context?.clientId) return null;
  return issueSensitiveSession({
    userId,
    clientId: context.clientId,
    resourceType: "reader_document",
    resourceId: readerSensitiveResourceId(workspace, readerDocumentId),
    ownerScope: readerSensitiveOwnerScope(workspace),
    method,
    requestId:
      request?.signedRequest?.requestId ||
      context.requestId ||
      request?.communicationRequestId ||
      null,
    sessionFingerprint: authSessionFingerprintFromRequest(request),
  });
}

function validateReaderSensitiveSessionIfPresent({
  request,
  response,
  workspace,
  readerDocumentId,
}) {
  const token = sensitiveSessionTokenFromRequest(request);
  if (!token) return { ok: true, present: false };

  const userId = Number(response?.locals?.user?.id || 0);
  const context = getClientContext(request);
  const expectedResourceId = readerSensitiveResourceId(
    workspace,
    readerDocumentId
  );
  const expectedOwnerScope = readerSensitiveOwnerScope(workspace);
  const result = validateSensitiveSessionForRequest(request, {
    userId,
    clientId: context?.clientId,
    resourceType: "reader_document",
    resourceId: expectedResourceId,
    ownerScope: expectedOwnerScope,
    heartbeat: true,
  });
  if (!result.ok) {
    console.warn("[ReaderSensitiveSession] denied", {
      reason: result.reason || result.error || "unknown",
      route: request?.path || request?.originalUrl || null,
      readerDocumentId,
      workspaceSlug: workspace?.readerStandalone
        ? null
        : workspace?.slug || null,
      standalone: workspace?.readerStandalone === true,
      expectedResourceId,
      expectedOwnerScope,
      tokenPresent: !!token,
      sessionPresent: result.present === true,
      userId: userId || null,
      clientIdPresent: !!context?.clientId,
      requestId:
        request?.signedRequest?.requestId ||
        context?.requestId ||
        request?.communicationRequestId ||
        null,
    });
  }
  return { ...result, present: true };
}

function readerStreamCacheControlForRequest(request) {
  return sensitiveSessionTokenFromRequest(request)
    ? READER_SENSITIVE_STREAM_CACHE_CONTROL
    : READER_STREAM_CACHE_CONTROL;
}

function readerTraceLog(stage, detail = {}) {
  console.info("[ReaderTrace]", {
    stage,
    ...detail,
  });
}

function readerAccessTrace(endpoint) {
  return (request, response, next) => {
    const startedAt = Date.now();
    let clientContext = null;
    try {
      clientContext = getClientContext(request);
    } catch {
      clientContext = null;
    }
    response.on("finish", () => {
      readerTraceLog("finish", {
        endpoint,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
        readerDocumentId: request.params?.readerDocumentId || null,
        workspaceSlug: request.params?.slug || null,
        standalone: !request.params?.slug,
        sensitiveHeaderPresent: !!sensitiveSessionTokenFromRequest(request),
        clientIdPresent: !!clientContext?.clientId,
        requestId:
          request?.signedRequest?.requestId ||
          clientContext?.requestId ||
          request?.communicationRequestId ||
          null,
      });
    });
    next();
  };
}

async function assertAuthorizedStandaloneReaderDocument({
  request,
  response,
  readerDocumentId,
  metadata,
}) {
  const access = await getAuthorizedFileBackedResource({
    request,
    response,
    metadata,
    resourceType: "standalone_reader_document",
    resourceId: readerDocumentId,
  });
  if (!access) throw readerDocumentNotFoundError();
  return access;
}

async function readAuthorizedStandaloneReaderMetadata(
  request,
  response,
  documentRoot,
  readerDocumentId,
  endpoint,
  options = {}
) {
  const metadata = readReaderJsonFile(documentRoot, "metadata.json", null, {
    readerDocumentId,
    endpoint,
  });
  await assertAuthorizedStandaloneReaderDocument({
    request,
    response,
    readerDocumentId,
    metadata,
  });
  if (!options.allowDeleted)
    assertReaderDocumentVisible(documentRoot, metadata);
  return metadata;
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

function sendUploadError(response, error) {
  if (error?.code === "LIMIT_FILE_SIZE") {
    return response.status(400).json({
      success: false,
      error: "Reader document exceeds the 500MB limit.",
    });
  }
  return response.status(400).json({
    success: false,
    error: error.message || "Invalid reader document upload.",
  });
}

function optionalRequire(moduleName, searchRoots = []) {
  const roots = [
    ...searchRoots,
    path.resolve(__dirname, ".."),
    path.resolve(__dirname, "../../frontend"),
    path.resolve(__dirname, "../../collector"),
    process.cwd(),
  ];
  for (const root of roots) {
    try {
      return require(require.resolve(moduleName, { paths: [root] }));
    } catch {}
  }
  return null;
}

function isoNow() {
  return new Date().toISOString();
}

function readerPostprocessKey(workspace, readerDocumentId) {
  return `${workspace?.readerStorageSegment || safeWorkspaceSegment(workspace)}:${assertReaderDocumentId(readerDocumentId)}`;
}

function readerPostprocessWasCancelled(workspace, readerDocumentId) {
  return readerPostprocessCancelRequests.has(
    readerPostprocessKey(workspace, readerDocumentId)
  );
}

function defaultReaderPostprocessStatus(readerDocumentId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    status: "idle",
    tasks: {},
    requestedTasks: [],
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    updatedAt: isoNow(),
  };
}

function readReaderPostprocessStatus(documentRoot, readerDocumentId) {
  const statusPath = safeResolve(documentRoot, READER_POSTPROCESS_STATUS_NAME);
  if (!fs.existsSync(statusPath))
    return defaultReaderPostprocessStatus(readerDocumentId);
  const result = safeReadJsonFile(
    statusPath,
    defaultReaderPostprocessStatus(readerDocumentId),
    {
      context: { readerDocumentId, file: READER_POSTPROCESS_STATUS_NAME },
    }
  );
  if (!result.ok) {
    console.warn("[ReaderPostprocess] status fallback", result.error);
    return defaultReaderPostprocessStatus(readerDocumentId);
  }
  const parsed = result.value || {};
  return {
    ...defaultReaderPostprocessStatus(readerDocumentId),
    ...parsed,
    tasks: parsed.tasks || {},
    requestedTasks: Array.isArray(parsed.requestedTasks)
      ? parsed.requestedTasks
      : [],
  };
}

function writeReaderPostprocessStatus(documentRoot, status) {
  const next = {
    ...status,
    updatedAt: isoNow(),
  };
  const result = atomicWriteJsonFile(
    safeResolve(documentRoot, READER_POSTPROCESS_STATUS_NAME),
    next
  );
  if (!result.ok)
    console.warn("[ReaderPostprocess] status write failed", result.error);
  return next;
}

function updateReaderPostprocessStatus(
  documentRoot,
  readerDocumentId,
  updater
) {
  const current = readReaderPostprocessStatus(documentRoot, readerDocumentId);
  const next =
    typeof updater === "function"
      ? updater(current)
      : { ...current, ...updater };
  return writeReaderPostprocessStatus(documentRoot, next);
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

function postprocessTaskPatch(status, task, patch = {}) {
  return {
    ...status,
    tasks: {
      ...(status.tasks || {}),
      [task]: {
        ...(status.tasks?.[task] || {}),
        ...patch,
        updatedAt: isoNow(),
      },
    },
  };
}

function readerPostprocessProgress(status = {}) {
  const tasks = Object.values(status.tasks || {});
  if (!tasks.length) {
    return {
      percent: status.status === "complete" ? 100 : 0,
      stage: status.status || "idle",
      error: null,
    };
  }

  const complete = tasks.filter((task) => task.status === "complete").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const active = tasks.find((task) =>
    ["queued", "processing", "extracting", "classifying"].includes(task.status)
  );
  const percent = Math.round(((complete + failed) / tasks.length) * 100);
  const errorTask = tasks.find((task) => task.status === "failed");
  return {
    percent: status.status === "complete" ? 100 : Math.max(5, percent),
    stage:
      status.status === "complete"
        ? "complete"
        : active?.status || status.status || "idle",
    error: errorTask?.reason || null,
  };
}

function compactClassificationText(text = "") {
  return String(text || "")
    .replaceAll(String.fromCharCode(0), "")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createClassificationAccumulator(
  limit = READER_POSTPROCESS_TEXT_LIMIT
) {
  return {
    parts: [],
    length: 0,
    append(text = "") {
      if (this.length >= limit) return 0;
      const next = compactClassificationText(text);
      if (!next) return 0;
      const remaining = limit - this.length;
      const slice = next.slice(0, remaining);
      this.parts.push(slice);
      this.length += slice.length;
      return slice.length;
    },
    text() {
      return compactClassificationText(this.parts.join("\n")).slice(0, limit);
    },
    full() {
      return this.length >= limit;
    },
  };
}

function decodeZipHref(value = "") {
  const withoutFragment = String(value || "").split("#")[0];
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

function normalizeZipPath(value = "") {
  return path.posix
    .normalize(String(value || "").replace(/\\/g, "/"))
    .replace(/^\/+/, "");
}

function resolveZipHref(baseDir = "", href = "") {
  return normalizeZipPath(path.posix.join(baseDir, decodeZipHref(href)));
}

function zipEntryByPath(zip, targetPath) {
  const normalized = normalizeZipPath(targetPath);
  return zip
    .getEntries()
    .find((entry) => normalizeZipPath(entry.entryName) === normalized);
}

function zipEntryText(zip, targetPath) {
  const entry = zipEntryByPath(zip, targetPath);
  if (!entry || entry.isDirectory) return "";
  return entry.getData().toString("utf8");
}

function readEpubPackage(zip) {
  const containerXml = zipEntryText(zip, "META-INF/container.xml");
  if (!containerXml) return null;
  const $container = cheerio.load(containerXml, { xmlMode: true });
  const opfPath = $container("rootfile").first().attr("full-path");
  if (!opfPath) return null;
  const normalizedOpfPath = normalizeZipPath(opfPath);
  const opfText = zipEntryText(zip, normalizedOpfPath);
  if (!opfText) return null;

  const opfDir = path.posix.dirname(normalizedOpfPath);
  const baseDir = opfDir === "." ? "" : opfDir;
  const $opf = cheerio.load(opfText, { xmlMode: true });
  const manifest = new Map();
  $opf("manifest item").each((_, element) => {
    const node = $opf(element);
    const id = node.attr("id");
    const href = node.attr("href");
    if (!id || !href) return;
    manifest.set(id, {
      id,
      href,
      path: resolveZipHref(baseDir, href),
      mediaType: node.attr("media-type") || "",
      properties: String(node.attr("properties") || "")
        .split(/\s+/)
        .filter(Boolean),
    });
  });

  const spine = [];
  $opf("spine itemref").each((_, element) => {
    const node = $opf(element);
    const idref = node.attr("idref");
    if (!idref) return;
    spine.push({
      idref,
      linear: node.attr("linear") || "yes",
      item: manifest.get(idref),
    });
  });

  let coverId = "";
  $opf("metadata meta").each((_, element) => {
    const node = $opf(element);
    if (String(node.attr("name") || "").toLowerCase() === "cover")
      coverId = node.attr("content") || coverId;
  });

  return { baseDir, coverId, manifest, spine };
}

function epubCoverImageBuffer(originalPath) {
  const zip = new AdmZip(originalPath);
  const pkg = readEpubPackage(zip);
  if (!pkg) return null;

  const manifestItems = [...pkg.manifest.values()];
  const coverItem =
    (pkg.coverId && pkg.manifest.get(pkg.coverId)) ||
    manifestItems.find((item) => item.properties.includes("cover-image")) ||
    manifestItems.find(
      (item) =>
        /^image\//i.test(item.mediaType) &&
        /cover|封面/i.test(`${item.id} ${item.href}`)
    );
  if (!coverItem) return null;
  const entry = zipEntryByPath(zip, coverItem.path);
  if (!entry || entry.isDirectory) return null;
  return entry.getData();
}

async function textFromMarkdownFile(originalPath) {
  const accumulator = createClassificationAccumulator();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const stream = fs.createReadStream(originalPath, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(accumulator.text());
    };
    stream.on("data", (chunk) => {
      accumulator.append(chunk);
      if (accumulator.full()) stream.destroy();
    });
    stream.on("close", finish);
    stream.on("end", finish);
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function textFromDocxFile(originalPath) {
  const zip = new AdmZip(originalPath);
  const accumulator = createClassificationAccumulator();
  const xmlNames = [
    "word/document.xml",
    ...zip
      .getEntries()
      .map((entry) => entry.entryName)
      .filter((name) => /^word\/(header|footer)\d+\.xml$/i.test(name)),
  ];
  for (const xmlName of xmlNames) {
    const xml = zipEntryText(zip, xmlName);
    if (!xml) continue;
    const $ = cheerio.load(xml, { xmlMode: true });
    $("w\\:t, t").each((_, element) => {
      if (accumulator.full()) return false;
      accumulator.append($(element).text());
      return true;
    });
    if (accumulator.full()) break;
  }
  return accumulator.text();
}

async function textFromXlsxFile(originalPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(originalPath);
  const accumulator = createClassificationAccumulator();
  for (const sheet of workbook.worksheets || []) {
    accumulator.append(sheet.name);
    for (let rowNo = 1; rowNo <= sheet.rowCount; rowNo += 1) {
      const row = sheet.getRow(rowNo);
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      const text = values
        .map((value) => {
          if (value == null) return "";
          if (typeof value === "object") {
            if (value.text) return value.text;
            if (value.result != null) return value.result;
            if (value.richText)
              return value.richText.map((part) => part.text || "").join("");
          }
          return String(value);
        })
        .filter(Boolean)
        .join(" | ");
      accumulator.append(text);
      if (accumulator.full()) break;
    }
    if (accumulator.full()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return accumulator.text();
}

async function textFromPdfFile(originalPath) {
  const pdfjs = optionalRequire("pdfjs-dist/legacy/build/pdf");
  if (!pdfjs?.getDocument)
    return await textFromPdfFileWithPdfParse(originalPath);
  const options = {
    data: new Uint8Array(fs.readFileSync(originalPath)),
  };
  const cMapPath = path.resolve(__dirname, "../../frontend/public/pdfjs/cmaps");
  const standardFontPath = path.resolve(
    __dirname,
    "../../frontend/public/pdfjs/standard_fonts"
  );
  if (fs.existsSync(cMapPath)) {
    options.cMapUrl = `${cMapPath}${path.sep}`;
    options.cMapPacked = true;
  }
  if (fs.existsSync(standardFontPath))
    options.standardFontDataUrl = `${standardFontPath}${path.sep}`;

  const loadingTask = pdfjs.getDocument(options);
  const pdfDocument = await loadingTask.promise;
  const accumulator = createClassificationAccumulator();
  try {
    for (let pageNo = 1; pageNo <= pdfDocument.numPages; pageNo += 1) {
      const page = await pdfDocument.getPage(pageNo);
      const content = await page.getTextContent();
      accumulator.append(content.items.map((item) => item.str || "").join(" "));
      page.cleanup?.();
      if (accumulator.full()) break;
      if (pageNo % 4 === 0)
        await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await pdfDocument.destroy?.();
  }
  return accumulator.text();
}

async function textFromPdfFileWithPdfParse(originalPath) {
  const pdfParse = optionalRequire("pdf-parse");
  if (typeof pdfParse !== "function") return "";
  const data = await pdfParse(fs.readFileSync(originalPath), { max: 80 });
  return compactClassificationText(data?.text || "").slice(
    0,
    READER_POSTPROCESS_TEXT_LIMIT
  );
}

async function textFromEpubFile(originalPath) {
  const zip = new AdmZip(originalPath);
  const pkg = readEpubPackage(zip);
  if (!pkg) return "";
  const accumulator = createClassificationAccumulator();
  for (const section of pkg.spine) {
    if (section.linear === "no" || !section.item) continue;
    if (!/html|xhtml|xml/i.test(section.item.mediaType)) continue;
    const html = zipEntryText(zip, section.item.path);
    if (!html) continue;
    const $ = cheerio.load(html);
    $("script, style, nav").remove();
    accumulator.append($("body").text() || $.text());
    if (accumulator.full()) break;
    if (accumulator.parts.length % 4 === 0)
      await new Promise((resolve) => setImmediate(resolve));
  }
  return accumulator.text();
}

async function extractReaderClassificationText({ documentType, originalPath }) {
  if (!originalPath || !validNonEmptyFile(originalPath)) return "";
  if (documentType === "markdown")
    return await textFromMarkdownFile(originalPath);
  if (documentType === "docx") return await textFromDocxFile(originalPath);
  if (documentType === "xlsx") return await textFromXlsxFile(originalPath);
  if (documentType === "pdf") return await textFromPdfFile(originalPath);
  if (documentType === "epub") return await textFromEpubFile(originalPath);
  return "";
}

function normalizeDuplicateTitle(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\.(pdf|docx|xlsx|epub|md|markdown|txt)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeDuplicateLeadText(value = "") {
  return compactClassificationText(value)
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .slice(0, READER_DUPLICATE_LEAD_TEXT_CHARS);
}

function hashDuplicateLeadText(value = "") {
  const normalized = normalizeDuplicateLeadText(value);
  if (!normalized || normalized.length < READER_DUPLICATE_LEAD_TEXT_CHARS)
    return null;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function duplicateSignatureFor({ originalName = "", leadText = "" }) {
  return {
    titleKey: normalizeDuplicateTitle(originalName),
    leadTextHash: hashDuplicateLeadText(leadText),
  };
}

async function textFromPdfFirstPages(originalPath, pageLimit = 3) {
  const pdfjs = optionalRequire("pdfjs-dist/legacy/build/pdf");
  if (!pdfjs?.getDocument) {
    const pdfParse = optionalRequire("pdf-parse");
    if (typeof pdfParse !== "function") return "";
    const data = await pdfParse(fs.readFileSync(originalPath), {
      max: Math.max(1, pageLimit),
    });
    return compactClassificationText(data?.text || "");
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(originalPath)),
  });
  const pdfDocument = await loadingTask.promise;
  const accumulator = createClassificationAccumulator(
    READER_DUPLICATE_LEAD_TEXT_CHARS * 4
  );
  try {
    const limit = Math.min(pdfDocument.numPages || 0, Math.max(1, pageLimit));
    for (let pageNo = 1; pageNo <= limit; pageNo += 1) {
      const page = await pdfDocument.getPage(pageNo);
      const content = await page.getTextContent();
      accumulator.append(content.items.map((item) => item.str || "").join(" "));
      page.cleanup?.();
      if (
        normalizeDuplicateLeadText(accumulator.text()).length >=
        READER_DUPLICATE_LEAD_TEXT_CHARS
      )
        break;
    }
  } finally {
    await pdfDocument.destroy?.();
  }
  return accumulator.text();
}

async function extractReaderDuplicateLeadText({
  documentType,
  originalPath,
  buffer = null,
}) {
  if (documentType === "markdown" && buffer)
    return buffer
      .toString("utf8")
      .slice(0, READER_DUPLICATE_LEAD_TEXT_CHARS * 8);
  if (!originalPath || !validNonEmptyFile(originalPath)) return "";
  if (documentType === "pdf")
    return await textFromPdfFirstPages(originalPath, 3);
  return await extractReaderClassificationText({ documentType, originalPath });
}

function duplicateUploadAction(request) {
  return String(request.body?.duplicateAction || "")
    .trim()
    .toLowerCase();
}

function ignoredReaderDocumentIdsFromRequest(request) {
  const raw =
    request.body?.ignoredReaderDocumentIds ||
    request.body?.ignoredReaderDocumentId ||
    "";
  const values = Array.isArray(raw)
    ? raw
    : (() => {
        try {
          const parsed = JSON.parse(String(raw || "[]"));
          return Array.isArray(parsed) ? parsed : [raw];
        } catch {
          return String(raw || "")
            .split(",")
            .map((id) => id.trim());
        }
      })();
  return new Set(
    values
      .map((id) => {
        try {
          return assertReaderDocumentId(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );
}

function duplicateDisplayName(originalName = "", index = 2) {
  const ext = path.extname(originalName);
  const base = ext ? originalName.slice(0, -ext.length) : originalName;
  return `${base || "书籍"}（重复 ${Math.max(2, index)}）${ext}`;
}

function duplicateCandidateMetadata(metadata = {}) {
  return {
    titleKey:
      metadata.readerDuplicate?.titleKey ||
      metadata.duplicateTitleKey ||
      normalizeDuplicateTitle(metadata.originalName),
    leadTextHash:
      metadata.readerDuplicate?.leadTextHash ||
      metadata.duplicateLeadTextHash ||
      null,
  };
}

async function ensureDuplicateSignatureForCandidate({
  documentRoot,
  metadata,
}) {
  const current = duplicateCandidateMetadata(metadata);
  if (current.titleKey && current.leadTextHash) return current;
  try {
    const originalPath = await originalPathForReaderDocument({
      documentRoot,
      metadata,
    });
    const leadText = await extractReaderDuplicateLeadText({
      documentType: documentTypeFromMetadata(metadata),
      originalPath,
    });
    const signature = duplicateSignatureFor({
      originalName: metadata.originalName,
      leadText,
    });
    if (signature.titleKey && signature.leadTextHash) {
      writeReaderJsonFile(documentRoot, "metadata.json", {
        ...metadata,
        readerDuplicate: {
          ...(metadata.readerDuplicate || {}),
          ...signature,
          calculatedAt: isoNow(),
        },
      });
    }
    return signature;
  } catch {
    return current;
  }
}

async function duplicateScanWorkspaces(request, response, uploadWorkspace) {
  const workspaces = [STANDALONE_READER_SCOPE];
  const requestedWorkspaceSlug = String(
    request.body?.workspaceSlug || ""
  ).trim();
  if (requestedWorkspaceSlug && uploadWorkspace?.readerStandalone) {
    try {
      const workspaceSlug = safeSegment(
        requestedWorkspaceSlug,
        "workspace slug"
      );
      const authorizedWorkspace = await getAuthorizedWorkspace({
        request,
        response,
        workspaceSlug,
      });
      if (authorizedWorkspace) workspaces.push(authorizedWorkspace);
    } catch {}
  } else if (!uploadWorkspace?.readerStandalone) {
    workspaces.push(uploadWorkspace);
  }
  return workspaces.filter(
    (workspace, index, list) =>
      workspace &&
      list.findIndex(
        (item) =>
          (item.readerStorageSegment || item.slug) ===
          (workspace.readerStorageSegment || workspace.slug)
      ) === index
  );
}

async function findReaderDuplicateCandidate({
  request,
  response,
  uploadWorkspace,
  originalName,
  leadText,
}) {
  const uploadSignature = duplicateSignatureFor({ originalName, leadText });
  if (!uploadSignature.titleKey || !uploadSignature.leadTextHash) {
    return { duplicate: null, signature: uploadSignature, duplicateIndex: 2 };
  }
  const ignoredIds = ignoredReaderDocumentIdsFromRequest(request);
  let visibleSameTitleCount = 0;
  for (const workspace of await duplicateScanWorkspaces(
    request,
    response,
    uploadWorkspace
  )) {
    const workspaceRoot = readerWorkspaceRoot(workspace);
    if (!fs.existsSync(workspaceRoot)) continue;
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let readerDocumentId = null;
      try {
        readerDocumentId = assertReaderDocumentId(entry.name);
      } catch {
        continue;
      }
      const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
      let metadata = null;
      try {
        metadata = readReaderMetadata(documentRoot, {
          readerDocumentId,
          endpoint: "duplicate-scan",
        });
      } catch {
        continue;
      }
      if (readerDocumentIsDeleted(documentRoot, metadata)) continue;
      if (ignoredIds.has(readerDocumentId)) {
        console.warn("[ReaderDuplicate] ignored id is not deleted; scanning", {
          readerDocumentId,
        });
      }
      if (workspace.readerStandalone) {
        try {
          await assertAuthorizedStandaloneReaderDocument({
            request,
            response,
            readerDocumentId,
            metadata,
          });
        } catch {
          continue;
        }
      }
      const candidate = duplicateCandidateMetadata(metadata);
      if (candidate.titleKey !== uploadSignature.titleKey) continue;
      visibleSameTitleCount += 1;
      const signature = candidate.leadTextHash
        ? candidate
        : await ensureDuplicateSignatureForCandidate({
            documentRoot,
            metadata,
          });
      if (signature.leadTextHash !== uploadSignature.leadTextHash) continue;
      return {
        duplicate: {
          readerDocumentId,
          title: decodeMaybeMojibakeFilename(metadata.originalName),
          createdAt: metadata.createdAt || null,
          workspaceSlug: workspace.readerStandalone ? null : workspace.slug,
        },
        signature: uploadSignature,
        duplicateIndex: Math.max(2, visibleSameTitleCount + 1),
      };
    }
  }
  return {
    duplicate: null,
    signature: uploadSignature,
    duplicateIndex: Math.max(2, visibleSameTitleCount + 1),
  };
}

function strategyForClassificationLength(totalChars) {
  if (totalChars < 300) return null;
  if (totalChars < 1_200)
    return { sampleCount: 2, sampleSize: 200, positions: [0.25, 0.75] };
  if (totalChars < 5_000)
    return { sampleCount: 3, sampleSize: 300, positions: [0.15, 0.5, 0.85] };
  if (totalChars < 30_000)
    return {
      sampleCount: 4,
      sampleSize: 400,
      positions: [0.1, 0.35, 0.65, 0.9],
    };
  return {
    sampleCount: 5,
    sampleSize: 500,
    positions: [0.08, 0.28, 0.5, 0.72, 0.92],
  };
}

function buildReaderClassificationSamples(text = "") {
  const normalized = compactClassificationText(text);
  const totalChars = normalized.length;
  const strategy = strategyForClassificationLength(totalChars);
  if (!strategy) {
    return {
      ok: false,
      reason: "可用于分类的文本过少。",
      totalChars,
      sampleCount: 0,
      sampleSize: 0,
      sampleStrategy: "too-short",
      samples: [],
    };
  }

  const samples = strategy.positions.map((position, index) => {
    const center = Math.floor(totalChars * position);
    const start = Math.max(0, center - Math.floor(strategy.sampleSize / 2));
    const end = Math.min(totalChars, start + strategy.sampleSize);
    return {
      index: index + 1,
      position,
      text: normalized.slice(start, end),
    };
  });
  const cappedSamples = cappedClassificationSamples(samples);
  const capped =
    classificationSampleCharCount(cappedSamples) <
    classificationSampleCharCount(samples);
  return {
    ok: true,
    totalChars,
    sampleCount: cappedSamples.length,
    sampleSize: strategy.sampleSize,
    sampleStrategy: `balanced-${strategy.sampleCount}x${strategy.sampleSize}${
      capped ? "-llm-cap-3000" : ""
    }`,
    samples: cappedSamples,
  };
}

async function normalizeThumbnailBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  return await sharp(buffer, { failOnError: false })
    .rotate()
    .resize({
      width: READER_THUMBNAIL_WIDTH,
      height: READER_THUMBNAIL_HEIGHT,
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: READER_THUMBNAIL_QUALITY, mozjpeg: true })
    .toBuffer();
}

function findQuickLookBinary() {
  return fileExists("/usr/bin/qlmanage")
    ? "/usr/bin/qlmanage"
    : findOnPath("qlmanage");
}

function findPdfToPpmBinary() {
  return fileExists("/usr/bin/pdftoppm")
    ? "/usr/bin/pdftoppm"
    : findOnPath("pdftoppm");
}

function findPdfInfoBinary() {
  return fileExists("/usr/bin/pdfinfo")
    ? "/usr/bin/pdfinfo"
    : findOnPath("pdfinfo");
}

async function quickLookThumbnailBuffer(originalPath) {
  const qlmanage = findQuickLookBinary();
  if (!qlmanage) return null;
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-reader-thumb-")
  );
  try {
    await execFileWithTimeout(qlmanage, [
      "-t",
      "-s",
      String(Math.max(READER_THUMBNAIL_WIDTH, READER_THUMBNAIL_HEIGHT) * 2),
      "-o",
      tempDir,
      originalPath,
    ]);
    const thumbnailPath = fs
      .readdirSync(tempDir)
      .map((name) => path.join(tempDir, name))
      .find((candidate) => /\.(png|jpe?g|webp)$/i.test(candidate));
    if (!thumbnailPath || !validNonEmptyFile(thumbnailPath)) return null;
    return fs.readFileSync(thumbnailPath);
  } finally {
    cleanupTempDir(tempDir);
  }
}

async function pdfThumbnailBuffer(originalPath) {
  const pdftoppm = findPdfToPpmBinary();
  if (!pdftoppm || !validNonEmptyFile(originalPath)) return null;
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-reader-pdf-thumb-")
  );
  try {
    const outputBase = path.join(tempDir, "page");
    await execFileWithTimeout(
      pdftoppm,
      [
        "-f",
        "1",
        "-l",
        "1",
        "-singlefile",
        "-jpeg",
        "-r",
        "144",
        originalPath,
        outputBase,
      ],
      { timeout: READER_PDF_THUMBNAIL_TIMEOUT_MS }
    );
    const thumbnailPath = `${outputBase}.jpg`;
    if (!validNonEmptyFile(thumbnailPath)) return null;
    return fs.readFileSync(thumbnailPath);
  } catch (error) {
    console.warn("[ReaderThumbnail] PDF thumbnail conversion failed", {
      error: error.message,
    });
    return null;
  } finally {
    cleanupTempDir(tempDir);
  }
}

function parsePdfInfoManifest(stdout = "") {
  const pageMatch = String(stdout || "").match(/^Pages:\s*(\d+)/im);
  const titleMatch = String(stdout || "").match(/^Title:\s*(.+)$/im);
  return {
    pageCount: pageMatch ? Number(pageMatch[1]) || null : null,
    title: titleMatch ? titleMatch[1].trim() : null,
  };
}

function pdfManifestMatchesMetadata(manifest = null, metadata = {}) {
  if (!manifest) return false;
  const size = Number(metadata?.size || 0) || null;
  const fingerprint =
    metadata?.originalFingerprint || metadata?.fingerprint || null;
  return (
    manifest.schemaVersion === SCHEMA_VERSION &&
    (!size || manifest.size === size) &&
    (!fingerprint || manifest.fingerprint === fingerprint)
  );
}

function readReaderPdfManifest(documentRoot, readerDocumentId) {
  return readReaderJsonFile(documentRoot, READER_PDF_MANIFEST_NAME, null, {
    readerDocumentId,
    endpoint: "pdf-manifest",
  });
}

function readOptionalReaderPdfManifest(documentRoot, readerDocumentId) {
  try {
    return readReaderPdfManifest(documentRoot, readerDocumentId);
  } catch (error) {
    if (error?.code !== "READER_DOCUMENT_JSON_UNAVAILABLE") throw error;
    return null;
  }
}

function writeReaderPdfManifest({
  documentRoot,
  readerDocumentId,
  metadata,
  manifest,
}) {
  const nextManifest = {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    size: Number(metadata?.size || 0) || null,
    fingerprint: metadata?.originalFingerprint || metadata?.fingerprint || null,
    generatedAt: isoNow(),
    ...manifest,
  };
  writeReaderJsonFile(documentRoot, READER_PDF_MANIFEST_NAME, nextManifest);
  return nextManifest;
}

async function ensureReaderPdfManifest({
  documentRoot,
  readerDocumentId,
  metadata,
  originalPath,
}) {
  if (!metadataIsPdf(metadata) || !validNonEmptyFile(originalPath)) return null;
  const existing = readOptionalReaderPdfManifest(
    documentRoot,
    readerDocumentId
  );
  if (pdfManifestMatchesMetadata(existing, metadata)) return existing;

  const key = `${documentRoot}:manifest`;
  if (readerPdfManifestJobs.has(key))
    return await readerPdfManifestJobs.get(key);

  const job = (async () => {
    const pdfinfo = findPdfInfoBinary();
    let manifest = {
      pageCount: null,
      title: null,
      source: pdfinfo ? "pdfinfo" : "unavailable",
    };
    if (pdfinfo) {
      try {
        const { stdout } = await execFileWithTimeout(pdfinfo, [originalPath], {
          timeout: READER_PDF_PAGE_PREVIEW_TIMEOUT_MS,
        });
        manifest = {
          ...manifest,
          ...parsePdfInfoManifest(stdout),
        };
      } catch (error) {
        manifest.error = String(error?.message || error).slice(0, 240);
      }
    }
    return writeReaderPdfManifest({
      documentRoot,
      readerDocumentId,
      metadata,
      manifest,
    });
  })();

  readerPdfManifestJobs.set(key, job);
  try {
    return await job;
  } finally {
    readerPdfManifestJobs.delete(key);
  }
}

function normalizedPdfPageNumber(value, manifest = null) {
  const page = Math.max(1, Math.round(Number(value) || 1));
  const pageCount = Number(manifest?.pageCount || 0);
  return pageCount > 0 ? Math.min(page, pageCount) : page;
}

function pdfPagePreviewName(pageNumber) {
  return `page-preview-${normalizedPdfPageNumber(pageNumber)}.jpg`;
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function existingPdfPreviewPageSet(documentRoot) {
  try {
    return new Set(
      fs
        .readdirSync(documentRoot)
        .map((name) => {
          const match = /^page-preview-(\d+)\.jpg$/i.exec(name);
          return match ? Number(match[1]) : null;
        })
        .filter((page) => Number.isFinite(page) && page > 0)
    );
  } catch {
    return new Set();
  }
}

function orderedPdfPreviewWindowPages({
  centerPage = 1,
  manifest = null,
  before = READER_PDF_PREVIEW_NEARBY_BEFORE,
  after = READER_PDF_PREVIEW_NEARBY_AFTER,
} = {}) {
  const pageCount = Number(manifest?.pageCount || 0);
  const center = normalizedPdfPageNumber(centerPage, manifest);
  const pages = [];
  const pushPage = (page) => {
    if (!Number.isFinite(page) || page < 1) return;
    if (pageCount > 0 && page > pageCount) return;
    if (!pages.includes(page)) pages.push(page);
  };
  pushPage(center);
  for (let offset = 1; offset <= Math.max(before, after); offset++) {
    if (offset <= after) pushPage(center + offset);
    if (offset <= before) pushPage(center - offset);
  }
  return pages;
}

function orderedPdfPreviewPrebuildPages({
  manifest = null,
  focusPage = 1,
  includeAll = false,
} = {}) {
  const pageCount = Number(manifest?.pageCount || 0);
  const maxPage = pageCount
    ? Math.min(pageCount, READER_PDF_PREVIEW_PREBUILD_MAX_PAGES)
    : READER_PDF_PREVIEW_PREBUILD_INITIAL_PAGES;
  const pages = [];
  const pushPage = (page) => {
    if (!Number.isFinite(page) || page < 1 || page > maxPage) return;
    if (!pages.includes(page)) pages.push(page);
  };

  orderedPdfPreviewWindowPages({ centerPage: focusPage, manifest }).forEach(
    pushPage
  );
  for (
    let page = 1;
    page <= Math.min(maxPage, READER_PDF_PREVIEW_PREBUILD_INITIAL_PAGES);
    page++
  ) {
    pushPage(page);
  }
  if (includeAll) {
    for (let page = 1; page <= maxPage; page++) pushPage(page);
  }
  return pages;
}

async function renderReaderPdfPagePreview({
  documentRoot,
  originalPath,
  pageNumber,
}) {
  const pdftoppm = findPdfToPpmBinary();
  if (!pdftoppm) throw new Error("PDF page preview renderer unavailable.");
  if (!validNonEmptyFile(originalPath))
    throw new Error("PDF original file unavailable.");

  const previewPath = safeResolve(documentRoot, pdfPagePreviewName(pageNumber));
  if (validNonEmptyFile(previewPath)) return { previewPath, cached: true };

  const key = `${documentRoot}:page:${pageNumber}`;
  if (readerPdfPagePreviewJobs.has(key))
    return await readerPdfPagePreviewJobs.get(key);

  const job = (async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "anythingllm-reader-pdf-page-")
    );
    try {
      const outputBase = path.join(tempDir, "page");
      await execFileWithTimeout(
        pdftoppm,
        [
          "-f",
          String(pageNumber),
          "-l",
          String(pageNumber),
          "-singlefile",
          "-jpeg",
          "-jpegopt",
          `quality=${READER_PDF_PAGE_PREVIEW_QUALITY}`,
          "-r",
          String(READER_PDF_PAGE_PREVIEW_DPI),
          originalPath,
          outputBase,
        ],
        { timeout: READER_PDF_PAGE_PREVIEW_TIMEOUT_MS }
      );
      const renderedPath = `${outputBase}.jpg`;
      if (!validNonEmptyFile(renderedPath))
        throw new Error("PDF page preview render returned an empty file.");
      fs.copyFileSync(renderedPath, previewPath);
      return { previewPath, cached: false };
    } finally {
      cleanupTempDir(tempDir);
    }
  })();

  readerPdfPagePreviewJobs.set(key, job);
  try {
    return await job;
  } finally {
    readerPdfPagePreviewJobs.delete(key);
  }
}

function scheduleReaderPdfPreviewPrebuild({
  documentRoot,
  readerDocumentId,
  metadata,
  originalPath,
  manifest = null,
  focusPage = 1,
  includeAll = false,
  reason = "background",
}) {
  if (!metadataIsPdf(metadata) || !validNonEmptyFile(originalPath)) return;
  const pageCount = Number(manifest?.pageCount || 0);
  const jobKey = `${documentRoot}:prebuild:${includeAll ? "all" : focusPage}`;
  if (readerPdfPreviewPrebuildJobs.has(jobKey)) return;

  const job = (async () => {
    const startedAt = Date.now();
    const existingPages = existingPdfPreviewPageSet(documentRoot);
    const pages = orderedPdfPreviewPrebuildPages({
      manifest,
      focusPage,
      includeAll,
    }).filter((page) => !existingPages.has(page));
    if (!pages.length) return;

    console.info("[reader:page-preview-prebuild:start]", {
      readerDocumentId: hashLogValue(readerDocumentId),
      reason,
      pages: pages.length,
      pageCount: pageCount || null,
      includeAll,
      size: Number(metadata?.size || 0) || null,
    });

    let rendered = 0;
    for (const pageNumber of pages) {
      try {
        await renderReaderPdfPagePreview({
          documentRoot,
          originalPath,
          pageNumber,
        });
        rendered += 1;
      } catch (error) {
        console.warn("[ReaderPdfPreview] background prebuild page failed", {
          readerDocumentId: hashLogValue(readerDocumentId),
          pageNumber,
          error: error.message,
        });
      }
      if (READER_PDF_PREVIEW_PREBUILD_PAUSE_MS > 0)
        await sleep(READER_PDF_PREVIEW_PREBUILD_PAUSE_MS);
    }

    console.info("[reader:page-preview-prebuild:done]", {
      readerDocumentId: hashLogValue(readerDocumentId),
      reason,
      rendered,
      pages: pages.length,
      durationMs: Date.now() - startedAt,
    });
  })()
    .catch((error) => {
      console.warn("[ReaderPdfPreview] background prebuild failed", {
        readerDocumentId: hashLogValue(readerDocumentId),
        reason,
        error: error.message,
      });
    })
    .finally(() => readerPdfPreviewPrebuildJobs.delete(jobKey));

  readerPdfPreviewPrebuildJobs.set(jobKey, job);
}

function scheduleReaderPdfPreviewBackfillFromList({
  workspace,
  readerDocumentId,
  documentRoot,
  metadata,
  manifest,
}) {
  if (!metadataIsPdf(metadata)) return;
  if (Number(metadata?.size || 0) < READER_PDF_PREWARM_MIN_BYTES) return;
  if (!manifest?.pageCount) return;

  originalPathForReaderDocument({ documentRoot, metadata })
    .then((originalPath) => {
      scheduleReaderPdfPreviewPrebuild({
        documentRoot,
        readerDocumentId,
        metadata,
        originalPath,
        manifest,
        focusPage: 1,
        includeAll: true,
        reason: workspace.readerStandalone
          ? "standalone-list-large-pdf-backfill"
          : "workspace-list-large-pdf-backfill",
      });
    })
    .catch((error) => {
      console.warn("[ReaderPdfPreview] list backfill schedule failed", {
        readerDocumentId: hashLogValue(readerDocumentId),
        error: error.message,
      });
    });
}

async function prepareReaderPdfForFastOpen({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
  prewarmPage = 1,
}) {
  if (!metadataIsPdf(metadata)) return null;
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const manifest = await ensureReaderPdfManifest({
    documentRoot,
    readerDocumentId,
    metadata,
    originalPath,
  });
  const pageNumber = normalizedPdfPageNumber(prewarmPage, manifest);
  try {
    await renderReaderPdfPagePreview({
      documentRoot,
      originalPath,
      pageNumber,
    });
  } catch (error) {
    console.warn("[ReaderPdfPreview] prewarm failed", {
      readerDocumentId: hashLogValue(readerDocumentId),
      pageNumber,
      error: error.message,
    });
  }
  if (Number(metadata?.size || 0) >= READER_PDF_PREWARM_MIN_BYTES) {
    scheduleReaderPdfPreviewPrebuild({
      documentRoot,
      readerDocumentId,
      metadata,
      originalPath,
      manifest,
      focusPage: pageNumber,
      includeAll: true,
      reason: "postprocess-large-pdf",
    });
  }
  return manifest;
}

async function maybePrewarmLargeReaderPdf({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
}) {
  if (
    !metadataIsPdf(metadata) ||
    Number(metadata?.size || 0) < READER_PDF_PREWARM_MIN_BYTES
  ) {
    return null;
  }
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const manifest = await ensureReaderPdfManifest({
    documentRoot,
    readerDocumentId,
    metadata,
    originalPath,
  });
  const pageNumber = normalizedPdfPageNumber(1, manifest);
  renderReaderPdfPagePreview({
    documentRoot,
    originalPath,
    pageNumber,
  }).catch((error) => {
    console.warn("[ReaderPdfPreview] large PDF page prewarm failed", {
      readerDocumentId: hashLogValue(readerDocumentId),
      pageNumber,
      error: error.message,
    });
  });
  scheduleReaderPdfPreviewPrebuild({
    documentRoot,
    readerDocumentId,
    metadata,
    originalPath,
    manifest,
    focusPage: pageNumber,
    includeAll: true,
    reason: "upload-large-pdf",
  });
  return manifest;
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
  const manifest = await ensureReaderPdfManifest({
    documentRoot,
    readerDocumentId,
    metadata,
    originalPath,
  });
  const pageNumber = normalizedPdfPageNumber(requestedPage, manifest);
  const { previewPath, cached } = await renderReaderPdfPagePreview({
    documentRoot,
    originalPath,
    pageNumber,
  });
  response.setHeader("Content-Type", "image/jpeg");
  response.setHeader(
    "Cache-Control",
    readerStreamCacheControlForRequest(request)
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
    scheduleReaderPdfPreviewPrebuild({
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
      route: readerApiPrefix(workspace),
    });
  });
  return response.sendFile(previewPath);
}

function escapeSvgText(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapThumbnailTitle(title = "", maxChars = 13, maxLines = 5) {
  const text = String(title || "")
    .replace(/\.(pdf|docx|xlsx|epub|md|markdown|txt)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return ["Untitled"];
  const chars = Array.from(text);
  const lines = [];
  for (let index = 0; index < chars.length && lines.length < maxLines; ) {
    lines.push(chars.slice(index, index + maxChars).join(""));
    index += maxChars;
  }
  if (chars.length > maxChars * maxLines && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, -1)}…`;
  }
  return lines;
}

async function fallbackThumbnailBuffer({ content, metadata }) {
  const type = String(content?.documentType || "DOC").toUpperCase();
  const titleLines = wrapThumbnailTitle(metadata?.originalName || "Document");
  const titleTspans = titleLines
    .map(
      (line, index) =>
        `<tspan x="44" y="${190 + index * 34}">${escapeSvgText(line)}</tspan>`
    )
    .join("");
  const svg = `
    <svg width="${READER_THUMBNAIL_WIDTH}" height="${READER_THUMBNAIL_HEIGHT}" viewBox="0 0 ${READER_THUMBNAIL_WIDTH} ${READER_THUMBNAIL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" rx="28" fill="#f8fafc"/>
      <rect x="24" y="24" width="${READER_THUMBNAIL_WIDTH - 48}" height="${READER_THUMBNAIL_HEIGHT - 48}" rx="22" fill="#ffffff" stroke="#dbeafe" stroke-width="2"/>
      <rect x="44" y="54" width="104" height="42" rx="21" fill="#2563eb"/>
      <text x="96" y="82" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" fill="#ffffff">${escapeSvgText(type)}</text>
      <text font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700" fill="#0f172a">${titleTspans}</text>
      <line x1="44" y1="${READER_THUMBNAIL_HEIGHT - 104}" x2="${READER_THUMBNAIL_WIDTH - 44}" y2="${READER_THUMBNAIL_HEIGHT - 104}" stroke="#e2e8f0" stroke-width="2"/>
      <text x="44" y="${READER_THUMBNAIL_HEIGHT - 62}" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#64748b">Athena Reader</text>
    </svg>
  `;
  return await sharp(Buffer.from(svg)).png().toBuffer();
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

function readerOriginalEtag(originalPath, metadata = {}) {
  const fingerprint =
    metadata.originalFingerprint ||
    metadata.fingerprint ||
    metadata.previewFingerprint ||
    null;
  if (fingerprint) return `"reader-${String(fingerprint).replace(/"/g, "")}"`;
  try {
    const stat = fs.statSync(originalPath);
    return `"reader-${stat.size}-${Math.round(stat.mtimeMs)}"`;
  } catch {
    return null;
  }
}

function setReaderOriginalHeaders(
  requestOrResponse,
  responseOrOriginalPath,
  originalPathOrMetadata,
  metadataMaybe = {}
) {
  const legacySignature = typeof responseOrOriginalPath === "string";
  const request = legacySignature ? {} : requestOrResponse;
  const response = legacySignature ? requestOrResponse : responseOrOriginalPath;
  const originalPath = legacySignature
    ? responseOrOriginalPath
    : originalPathOrMetadata;
  const metadata = legacySignature
    ? originalPathOrMetadata || {}
    : metadataMaybe;
  const setHeader = (name, value) => {
    if (typeof response.setHeader === "function")
      return response.setHeader(name, value);
    if (typeof response.header === "function")
      return response.header(name, value);
    response.headers = response.headers || {};
    response.headers[name] = value;
    return undefined;
  };
  const etag = readerOriginalEtag(originalPath, metadata);
  setHeader("Accept-Ranges", "bytes");
  setHeader("Cache-Control", readerStreamCacheControlForRequest(request));
  setHeader("Content-Type", metadata.mimeType || "application/octet-stream");
  if (etag) setHeader("ETag", etag);
  setHeader("X-Reader-Stream", "range");
}

function sendReaderOriginalFile({ request, response, originalPath, metadata }) {
  const startedAt = Date.now();
  const range = request.headers.range || null;
  setReaderOriginalHeaders(request, response, originalPath, metadata);
  response.on("finish", () => {
    console.info("[reader:original]", {
      requestId: request.communicationRequestId || null,
      method: request.method,
      status: response.statusCode,
      range,
      contentRange: response.getHeader("Content-Range") || null,
      contentLength: response.getHeader("Content-Length") || null,
      originalSize: Number(metadata?.size || 0) || null,
      mimeType: metadata?.mimeType || null,
      durationMs: Date.now() - startedAt,
    });
  });
  return response.sendFile(originalPath);
}

async function generateReaderDocumentThumbnail({
  workspace,
  readerDocumentId,
  content,
  metadata,
  originalPath,
}) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  let sourceBuffer = null;
  if (content.documentType === "epub") {
    sourceBuffer = epubCoverImageBuffer(originalPath);
  }
  if (!sourceBuffer && content.documentType === "pdf") {
    sourceBuffer = await pdfThumbnailBuffer(originalPath);
  }
  if (!sourceBuffer) {
    const previewPath = safeResolve(documentRoot, DOCX_PREVIEW_NAME);
    const quickLookPath =
      ["docx", "markdown"].includes(content.documentType) &&
      validNonEmptyFile(previewPath)
        ? previewPath
        : originalPath;
    if (
      ["docx", "markdown"].includes(content.documentType) &&
      validNonEmptyFile(previewPath)
    ) {
      sourceBuffer = await pdfThumbnailBuffer(previewPath);
    }
    if (!sourceBuffer) {
      sourceBuffer = await quickLookThumbnailBuffer(quickLookPath);
    }
  }
  if (!sourceBuffer) {
    sourceBuffer = await fallbackThumbnailBuffer({ content, metadata });
  }
  const thumbnailBuffer = await normalizeThumbnailBuffer(sourceBuffer);
  if (!thumbnailBuffer) return null;
  const thumbnailPath = safeResolve(documentRoot, READER_THUMBNAIL_NAME);
  fs.writeFileSync(thumbnailPath, thumbnailBuffer);
  const nextMetadata = {
    ...metadata,
    thumbnailName: READER_THUMBNAIL_NAME,
    thumbnailMimeType: "image/jpeg",
    thumbnailUrl: existingThumbnailUrlForDocument(workspace, readerDocumentId),
    thumbnailGeneratedAt: isoNow(),
  };
  writeReaderJsonFile(documentRoot, "metadata.json", nextMetadata);
  return {
    metadata: nextMetadata,
    thumbnailUrl: nextMetadata.thumbnailUrl,
  };
}

function sanitizedPostprocessTasks(tasks = []) {
  const allowed = new Set([
    "preview",
    "thumbnail",
    "classification",
    "pdfManifest",
  ]);
  const source = Array.isArray(tasks) && tasks.length ? tasks : [...allowed];
  return [...new Set(source.filter((task) => allowed.has(task)))];
}

function readerAutoClassificationEnabled(env = process.env) {
  return String(env.READER_AUTO_CLASSIFICATION_ENABLED || "true") !== "false";
}

function taskIsComplete(task = null) {
  return ["complete", "skipped"].includes(task?.status);
}

function postprocessTasksComplete(status = {}, tasks = []) {
  if (!tasks.length) return true;
  return tasks.every((task) => taskIsComplete(status.tasks?.[task]));
}

async function runReaderPostprocessJob({
  workspace,
  readerDocumentId,
  tasks,
  categories,
  userId = null,
}) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  if (!fs.existsSync(documentRoot)) return;
  if (readerDocumentIsDeleted(documentRoot)) return;
  updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) => ({
    ...status,
    status: "processing",
    startedAt: status.startedAt || isoNow(),
    completedAt: null,
  }));

  let { content, metadata } = readReaderContentAndMetadata(documentRoot, {
    readerDocumentId,
    phase: "postprocess",
  });
  const originalPath = await originalPathForReaderDocument({
    documentRoot,
    metadata,
  });

  if (readerPostprocessWasCancelled(workspace, readerDocumentId)) {
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) => ({
      ...status,
      status: "cancelled",
      completedAt: isoNow(),
    }));
    return;
  }

  if (tasks.includes("preview")) {
    if (readerPostprocessWasCancelled(workspace, readerDocumentId)) return;
    const needsPdfPreview = metadataNeedsPdfPreview(metadata);
    const previewLabel = previewDocumentLabel(metadata);
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
      postprocessTaskPatch(status, "preview", {
        status: needsPdfPreview ? "processing" : "skipped",
        reason: needsPdfPreview
          ? `正在生成 ${previewLabel} 版式预览`
          : "该文档无需生成版式预览。",
      })
    );
    if (needsPdfPreview) {
      try {
        if (!originalPath) throw new Error(`${previewLabel} 原始文件不可用。`);
        const fingerprint =
          metadata.originalFingerprint ||
          fingerprintForBuffer(fs.readFileSync(originalPath));
        const finalMetadata = await ensureDocxPreview({
          workspace,
          readerDocumentId,
          metadata,
          originalPath,
          fingerprint,
        });
        metadata = finalMetadata;
        writeReaderJsonFile(documentRoot, "metadata.json", finalMetadata);
        updateReaderPostprocessStatus(
          documentRoot,
          readerDocumentId,
          (status) =>
            postprocessTaskPatch(status, "preview", {
              status: finalMetadata.previewPdfUrl ? "complete" : "failed",
              reason: finalMetadata.previewPdfUrl
                ? ""
                : finalMetadata.previewLastError ||
                  finalMetadata.previewWarning ||
                  `${previewLabel} 版式预览生成失败。`,
              result: finalMetadata.previewPdfUrl
                ? {
                    previewPdfName: finalMetadata.previewPdfName,
                    previewGeneratedAt:
                      finalMetadata.previewGeneratedAt || null,
                    previewSource: finalMetadata.previewSource || null,
                    previewEngineVersion:
                      finalMetadata.previewEngineVersion || null,
                  }
                : null,
            })
        );
        if (finalMetadata.previewPdfUrl) {
          publishReaderBroadcastEvent({
            workspace,
            userId: userId || metadata?.ownerUserId,
            readerDocumentId,
            type: "preview.ready",
            eventPriority: "normal",
            payload: {
              previewReady: true,
              previewGeneratedAt: finalMetadata.previewGeneratedAt || isoNow(),
            },
          });
        } else {
          publishReaderBroadcastEvent({
            workspace,
            userId: userId || metadata?.ownerUserId,
            readerDocumentId,
            type: "preview.failed",
            eventPriority: "background",
            payload: {
              previewReady: false,
              reason:
                finalMetadata.previewLastError ||
                finalMetadata.previewWarning ||
                `${previewLabel} 版式预览生成失败。`,
            },
          });
        }
      } catch (error) {
        updateReaderPostprocessStatus(
          documentRoot,
          readerDocumentId,
          (status) =>
            postprocessTaskPatch(status, "preview", {
              status: "failed",
              reason: error.message || `${previewLabel} 版式预览生成失败。`,
            })
        );
        publishReaderBroadcastEvent({
          workspace,
          userId: userId || metadata?.ownerUserId,
          readerDocumentId,
          type: "preview.failed",
          eventPriority: "background",
          payload: {
            previewReady: false,
            reason: error.message || `${previewLabel} 版式预览生成失败。`,
          },
        });
      }
    }
  }

  if (tasks.includes("pdfManifest")) {
    if (readerPostprocessWasCancelled(workspace, readerDocumentId)) return;
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
      postprocessTaskPatch(status, "pdfManifest", {
        status: "processing",
        reason: "正在建立 PDF 页面索引",
      })
    );
    try {
      const manifest = originalPath
        ? await prepareReaderPdfForFastOpen({
            workspace,
            readerDocumentId,
            metadata,
            originalPath,
            prewarmPage: 1,
          })
        : null;
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessTaskPatch(status, "pdfManifest", {
          status: manifest ? "complete" : "skipped",
          reason: manifest ? "" : "非 PDF 或原文件不可用。",
          result: manifest,
        })
      );
    } catch (error) {
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessTaskPatch(status, "pdfManifest", {
          status: "failed",
          reason: error.message || "PDF 页面索引建立失败。",
        })
      );
    }
  }

  if (tasks.includes("thumbnail")) {
    if (readerPostprocessWasCancelled(workspace, readerDocumentId)) return;
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
      postprocessTaskPatch(status, "thumbnail", {
        status: "processing",
        reason: "正在生成封面",
      })
    );
    try {
      const thumbnail = originalPath
        ? await generateReaderDocumentThumbnail({
            workspace,
            readerDocumentId,
            content,
            metadata,
            originalPath,
          })
        : null;
      if (thumbnail?.metadata) metadata = thumbnail.metadata;
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessTaskPatch(status, "thumbnail", {
          status: thumbnail?.thumbnailUrl ? "complete" : "failed",
          reason: thumbnail?.thumbnailUrl ? "" : "缩略图生成失败。",
          generatedAt: thumbnail?.metadata?.thumbnailGeneratedAt || null,
        })
      );
      if (thumbnail?.thumbnailUrl) {
        publishReaderBroadcastEvent({
          workspace,
          userId: userId || metadata?.ownerUserId,
          readerDocumentId,
          type: "thumbnail.ready",
          eventPriority: "background",
          payload: {
            thumbnailReady: true,
            thumbnailGeneratedAt:
              thumbnail?.metadata?.thumbnailGeneratedAt || isoNow(),
          },
        });
      }
    } catch {
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessTaskPatch(status, "thumbnail", {
          status: "failed",
          reason: "缩略图生成失败。",
        })
      );
    }
  }

  if (tasks.includes("classification")) {
    if (readerPostprocessWasCancelled(workspace, readerDocumentId)) return;
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
      postprocessTaskPatch(status, "classification", {
        status: "extracting",
        reason: "正在提取分类文本",
      })
    );
    try {
      let result = null;
      if (originalPath) {
        const text = await extractReaderClassificationText({
          documentType: content.documentType,
          originalPath,
        });
        const samplePayload = buildReaderClassificationSamples(text);
        if (!samplePayload.ok) {
          result = unknownClassificationCategory(
            sanitizedClassificationCategories(categories),
            samplePayload.reason
          );
        } else {
          updateReaderPostprocessStatus(
            documentRoot,
            readerDocumentId,
            (status) =>
              postprocessTaskPatch(status, "classification", {
                status: "classifying",
                reason: "正在自动分类",
              })
          );
          result = await classifyReaderDocumentWithDeepSeek({
            title: metadata.originalName,
            documentType: content.documentType,
            categories,
            ...samplePayload,
          });
        }
      } else {
        result = unknownClassificationCategory(
          sanitizedClassificationCategories(categories),
          "读取不到可用于分类的正文。"
        );
      }
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessTaskPatch(status, "classification", {
          status: "complete",
          reason: result.reason || result.categoryReason || "",
          result,
        })
      );
      publishReaderBroadcastEvent({
        workspace,
        userId: userId || metadata?.ownerUserId,
        readerDocumentId,
        type: "classification.ready",
        eventPriority: "background",
        payload: {
          classificationReady: true,
          categoryId: result.categoryId || result.primaryCategoryId || null,
          categoryName:
            result.categoryName || result.primaryCategoryName || null,
          source: result.source || null,
        },
      });
    } catch {
      const result = unknownClassificationCategory(
        sanitizedClassificationCategories(categories),
        safeClassificationReason("failed")
      );
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessTaskPatch(status, "classification", {
          status: "complete",
          reason: result.reason || result.categoryReason || "",
          result,
        })
      );
      publishReaderBroadcastEvent({
        workspace,
        userId: userId || metadata?.ownerUserId,
        readerDocumentId,
        type: "classification.ready",
        eventPriority: "background",
        payload: {
          classificationReady: true,
          categoryId: result.categoryId || result.primaryCategoryId || null,
          categoryName:
            result.categoryName || result.primaryCategoryName || null,
          source: result.source || "fallback",
        },
      });
    }
  }

  updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) => ({
    ...status,
    status: "complete",
    completedAt: isoNow(),
  }));
  publishReaderBroadcastEvent({
    workspace,
    userId: userId || metadata?.ownerUserId,
    readerDocumentId,
    type: "postprocess.completed",
    eventPriority: "normal",
    payload: {
      requestedTasks: tasks,
      completedAt: isoNow(),
    },
  });
}

function publishReaderBroadcastEvent({
  workspace,
  userId = null,
  readerDocumentId,
  type,
  eventPriority = "normal",
  payload = {},
} = {}) {
  if (!readerDocumentId || !type) return null;
  const workspaceSlug =
    workspace?.slug === STANDALONE_READER_SCOPE.slug ? null : workspace?.slug;
  return publishBroadcastEvent({
    namespace: "reader",
    type,
    eventPriority,
    visibility: "reader",
    scope: {
      ...(userId ? { userId: Number(userId) } : {}),
      ...(workspaceSlug ? { workspaceSlug } : {}),
      readerDocumentId,
    },
    resource: {
      kind: "reader-document",
      id: readerDocumentId,
    },
    payload: {
      ...(workspaceSlug ? { workspaceSlug } : {}),
      readerDocumentId,
      ...payload,
    },
  });
}

function enqueueReaderPostprocessJob({
  workspace,
  readerDocumentId,
  tasks,
  categories,
  force = false,
  userId = null,
}) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const originalTasks = sanitizedPostprocessTasks(tasks);
  const autoClassificationDisabled =
    originalTasks.includes("classification") &&
    !force &&
    !readerAutoClassificationEnabled();
  const requestedTasks = autoClassificationDisabled
    ? originalTasks.filter((task) => task !== "classification")
    : originalTasks;
  if (autoClassificationDisabled) {
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
      postprocessTaskPatch(status, "classification", {
        status: "skipped",
        reason: "自动分类已关闭。",
      })
    );
  }
  if (!requestedTasks.length) {
    return readReaderPostprocessStatus(documentRoot, readerDocumentId);
  }

  const key = readerPostprocessKey(workspace, readerDocumentId);
  if (readerPostprocessJobs.has(key))
    return readReaderPostprocessStatus(documentRoot, readerDocumentId);

  const currentStatus = readReaderPostprocessStatus(
    documentRoot,
    readerDocumentId
  );
  if (!force && postprocessTasksComplete(currentStatus, requestedTasks))
    return currentStatus;

  const queuedAt = isoNow();
  const queuedStatus = writeReaderPostprocessStatus(documentRoot, {
    ...currentStatus,
    status: "queued",
    requestedTasks,
    queuedAt,
    completedAt: null,
    tasks: requestedTasks.reduce(
      (tasksByName, task) => {
        tasksByName[task] = {
          ...(tasksByName[task] || {}),
          status: "queued",
          reason: "等待后台处理",
          queuedAt,
          updatedAt: queuedAt,
        };
        return tasksByName;
      },
      { ...currentStatus.tasks }
    ),
  });

  const job = readerPostprocessQueue
    .add(() =>
      runReaderPostprocessJob({
        workspace,
        readerDocumentId,
        tasks: requestedTasks,
        categories,
        userId,
      })
    )
    .catch(() => null)
    .finally(() => {
      readerPostprocessJobs.delete(key);
      readerPostprocessCancelRequests.delete(key);
    });
  readerPostprocessJobs.set(key, job);
  return queuedStatus;
}

function cancelReaderPostprocessJob({ workspace, readerDocumentId }) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const key = readerPostprocessKey(workspace, readerDocumentId);
  readerPostprocessCancelRequests.add(key);
  readerPostprocessJobs.delete(key);
  return updateReaderPostprocessStatus(
    documentRoot,
    readerDocumentId,
    (status) => ({
      ...status,
      status: "cancelled",
      completedAt: isoNow(),
      tasks: Object.fromEntries(
        Object.entries(status.tasks || {}).map(([task, value]) => [
          task,
          ["complete", "skipped"].includes(value?.status)
            ? value
            : {
                ...value,
                status: "cancelled",
                reason: "已由 Developer Control 取消。",
                updatedAt: isoNow(),
              },
        ])
      ),
    })
  );
}

function readerPostprocessResponse(workspace, readerDocumentId) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const status = readReaderPostprocessStatus(documentRoot, readerDocumentId);
  const classification = status.tasks?.classification?.result || null;
  const progress = readerPostprocessProgress(status);
  let metadata = null;
  try {
    metadata = metadataWithOriginalUrl(
      workspace,
      readerDocumentId,
      readReaderMetadata(documentRoot, {
        readerDocumentId,
        endpoint: "postprocess.response",
      })
    );
  } catch {
    metadata = null;
  }
  return {
    success: true,
    status: status.status,
    postprocess: status,
    progress,
    stage: progress.stage,
    tasks: status.tasks || {},
    postprocessConfig: {
      autoPollTimeoutMs: READER_POSTPROCESS_AUTO_POLL_TIMEOUT_MS,
    },
    thumbnailUrl: existingThumbnailUrlForDocument(workspace, readerDocumentId),
    classification,
    ...(metadata ? { metadata } : {}),
  };
}

function shouldQueueThumbnailMaintenance({ workspace, readerDocumentId }) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  if (readerDocumentIsDeleted(documentRoot)) return false;
  if (existingThumbnailUrlForDocument(workspace, readerDocumentId))
    return false;
  const status = readReaderPostprocessStatus(documentRoot, readerDocumentId);
  const task = status.tasks?.thumbnail || null;
  if (["queued", "processing"].includes(task?.status)) return false;
  if (task?.status === "failed") {
    const lastUpdated = new Date(
      task.updatedAt || task.queuedAt || 0
    ).getTime();
    if (
      Number.isFinite(lastUpdated) &&
      Date.now() - lastUpdated < 30 * 60 * 1000
    )
      return false;
  }
  return true;
}

function queueThumbnailMaintenance({
  workspace,
  readerDocumentId,
  reason = "missing-thumbnail",
}) {
  if (!shouldQueueThumbnailMaintenance({ workspace, readerDocumentId })) return;
  console.log("[ReaderThumbnailMaintenance] queued", {
    readerDocumentId,
    workspace: workspace?.slug || workspace?.readerStorageSegment || null,
    reason,
  });
  enqueueReaderPostprocessJob({
    workspace,
    readerDocumentId,
    tasks: ["thumbnail"],
    categories: [],
  });
}

function workspaceFromReaderStorageSegment(segment = "") {
  if (segment === STANDALONE_READER_SCOPE.readerStorageSegment)
    return STANDALONE_READER_SCOPE;
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
    const workspaceRoot = readerWorkspaceRoot(workspace);
    for (const documentEntry of fs.readdirSync(workspaceRoot, {
      withFileTypes: true,
    })) {
      if (!documentEntry.isDirectory()) continue;
      let readerDocumentId = null;
      try {
        readerDocumentId = assertReaderDocumentId(documentEntry.name);
      } catch {
        continue;
      }
      const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
      let metadata = null;
      try {
        metadata = readReaderMetadata(documentRoot, {
          readerDocumentId,
          endpoint: "thumbnail-maintenance",
        });
      } catch {
        continue;
      }
      if (readerDocumentIsDeleted(documentRoot, metadata)) continue;
      if (!shouldQueueThumbnailMaintenance({ workspace, readerDocumentId }))
        continue;
      queueThumbnailMaintenance({ workspace, readerDocumentId, reason });
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

async function listReaderDocumentsForWorkspace({
  request,
  response,
  workspace,
}) {
  const workspaceRoot = readerWorkspaceRoot(workspace);
  if (!fs.existsSync(workspaceRoot)) return [];
  const documents = [];
  const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let readerDocumentId = null;
    try {
      readerDocumentId = assertReaderDocumentId(entry.name);
    } catch {
      continue;
    }
    const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
    let metadata = null;
    try {
      metadata = readReaderMetadata(documentRoot, {
        readerDocumentId,
        endpoint: "list",
      });
      if (readerDocumentIsDeleted(documentRoot, metadata)) continue;
      if (workspace.readerStandalone) {
        await assertAuthorizedStandaloneReaderDocument({
          request,
          response,
          readerDocumentId,
          metadata,
        });
      }
    } catch {
      continue;
    }
    const pdfManifest = readOptionalReaderPdfManifest(
      documentRoot,
      readerDocumentId
    );
    scheduleReaderPdfPreviewBackfillFromList({
      workspace,
      readerDocumentId,
      documentRoot,
      metadata,
      manifest: pdfManifest,
    });
    const enrichedMetadata = pdfManifest
      ? { ...metadata, pdfManifest }
      : metadata;
    queueThumbnailMaintenance({
      workspace,
      readerDocumentId,
      reason: "list",
    });
    documents.push({
      readerDocumentId,
      warning: metadata.previewWarning || null,
      contentSummary: readerContentSummary({
        content: null,
        metadata: enrichedMetadata,
      }),
      metadata: metadataWithOriginalUrl(
        workspace,
        readerDocumentId,
        enrichedMetadata
      ),
      postprocess: readerPostprocessResponse(workspace, readerDocumentId)
        .postprocess,
    });
  }
  return documents.sort(
    (a, b) =>
      new Date(b.metadata?.createdAt || 0).getTime() -
      new Date(a.metadata?.createdAt || 0).getTime()
  );
}

function safeClassificationReason(type = "failed") {
  const reasons = {
    missing_key: "分类模型未配置，已归入未知分类。",
    unavailable: "分类模型暂不可用，已归入未知分类。",
    timeout: "分类请求超时，已归入未知分类。",
    invalid_json: "分类模型返回格式异常，已归入未知分类。",
    invalid_category: "分类模型选择了不存在的分类，已归入未知分类。",
    low_confidence: "分类置信度较低，已归入未知分类。",
    empty_categories: "分类列表不可用，已归入未知分类。",
    failed: "自动分类失败，已归入未知分类。",
  };
  return reasons[type] || reasons.failed;
}

function sanitizedClassificationCategories(categories = []) {
  const byId = new Map();
  for (const rawCategory of Array.isArray(categories) ? categories : []) {
    const id = String(rawCategory?.id || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const name = String(rawCategory?.name || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 30);
    if (!id || !name || byId.has(id)) continue;
    byId.set(id, { id, name });
  }
  if (!byId.has("unknown"))
    byId.set("unknown", { id: "unknown", name: "未知分类" });
  return [...byId.values()];
}

function unknownClassificationCategory(categories = [], reason = "") {
  const unknown = categories.find((category) => category.id === "unknown") || {
    id: "unknown",
    name: "未知分类",
  };
  const now = new Date().toISOString();
  return {
    success: true,
    categoryStatus: "unknown",
    categoryStage: "unknownReason",
    categoryReason: reason,
    reason,
    category: {
      primaryCategoryId: unknown.id,
      primaryCategoryName: unknown.name,
      secondaryCategory: "",
      tags: [],
      confidence: 0,
      source: "fallback",
      reason,
      evidence: [],
      sampleStrategy: "",
      classifiedAt: now,
      updatedAt: now,
    },
  };
}

function classificationLookupKey(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[《》<>【】[\]（）(){}，,。.:：·・"'“”‘’/\\|]+/g, "");
}

function resolveClassificationCategory(result = {}, categories = []) {
  const candidates = [
    result.primaryCategoryId,
    result.primaryCategoryName,
    result.categoryId,
    result.categoryName,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const exact = categories.find((category) => category.id === candidate);
    if (exact) return exact;
  }

  const normalizedCandidates = candidates.map(classificationLookupKey);
  for (const candidate of normalizedCandidates) {
    const matched = categories.find(
      (category) =>
        classificationLookupKey(category.id) === candidate ||
        classificationLookupKey(category.name) === candidate
    );
    if (matched) return matched;
  }

  return null;
}

const FINANCE_TITLE_KEYWORDS = [
  "经济",
  "金融",
  "资本",
  "投资",
  "周期",
  "财富",
  "货币",
  "银行",
  "证券",
  "股票",
  "基金",
  "债券",
  "交易",
  "宏观",
  "产业",
  "财务",
  "商业",
  "market",
  "finance",
  "capital",
  "investment",
  "investing",
  "wealth",
  "cycle",
  "money",
  "bank",
];

function titleHasFinanceSignal(title = "") {
  const normalizedTitle = classificationLookupKey(title);
  if (!normalizedTitle) return false;
  return FINANCE_TITLE_KEYWORDS.some((keyword) =>
    normalizedTitle.includes(classificationLookupKey(keyword))
  );
}

function financeCategory(categories = []) {
  return (
    categories.find((category) => category.id === "finance") ||
    categories.find(
      (category) =>
        classificationLookupKey(category.name) ===
        classificationLookupKey("金融经济")
    ) ||
    categories.find((category) =>
      classificationLookupKey(category.name).includes(
        classificationLookupKey("金融")
      )
    )
  );
}

function titleFallbackClassification({
  title = "",
  categories = [],
  reason = "",
  sampleStrategy = "",
}) {
  const category = financeCategory(categories);
  if (!category || !titleHasFinanceSignal(title)) return null;
  const now = new Date().toISOString();
  const titleSnippet = String(title || "").slice(0, 80);
  const fallbackReason =
    String(reason || "")
      .replace("已归入未知分类", `已按书名关键词归入${category.name}`)
      .trim() || `自动分类未能可靠判断，已按书名关键词归入${category.name}。`;
  return {
    success: true,
    categoryStatus: "classified",
    categoryStage: "fallback-rule",
    categoryReason: fallbackReason,
    reason: fallbackReason,
    category: {
      primaryCategoryId: category.id,
      primaryCategoryName: category.name,
      secondaryCategory: "",
      tags: ["金融经济"],
      confidence: 0.49,
      source: "fallback-rule",
      reason: fallbackReason,
      evidence: titleSnippet ? [`书名关键词命中：${titleSnippet}`] : [],
      sampleStrategy,
      classifiedAt: now,
      updatedAt: now,
    },
  };
}

function classificationFallback({
  title = "",
  categories = [],
  reason = "",
  sampleStrategy = "",
}) {
  return (
    titleFallbackClassification({
      title,
      categories,
      reason,
      sampleStrategy,
    }) || unknownClassificationCategory(categories, reason)
  );
}

function cappedClassificationSamples(samples = []) {
  let used = 0;
  const capped = [];
  for (const rawSample of Array.isArray(samples) ? samples : []) {
    const remaining = CLASSIFICATION_LLM_TEXT_LIMIT - used;
    if (remaining <= 0) break;
    const text = String(rawSample?.text || "").slice(0, remaining);
    used += text.length;
    if (!text.trim()) continue;
    capped.push({
      index: Number(rawSample.index) || capped.length + 1,
      position: Number(rawSample.position) || null,
      text,
    });
  }
  return capped;
}

function classificationSampleCharCount(samples = []) {
  return samples.reduce(
    (sum, sample) => sum + String(sample.text || "").length,
    0
  );
}

function confidenceBucket(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  if (confidence > 0) return "low";
  return "none";
}

function readerClassificationLog(message, data = {}) {
  console.log("[ReaderDocumentClassification]", message, {
    titleHash: data.title ? hashLogValue(data.title) : null,
    documentType: data.documentType,
    sampleCount: data.sampleCount,
    sampleChars: data.sampleChars,
    categoryCount: data.categoryCount,
    categoryId: data.categoryId,
    confidence: confidenceBucket(data.confidence),
    durationMs: data.durationMs,
    responseChars: data.responseChars,
  });
}

function extractFirstJsonObject(text = "") {
  const raw = String(text || "");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (depth === 0) {
      if (char !== "{") continue;
      start = index;
      depth = 1;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) return raw.slice(start, index + 1);
    }
  }
  return "";
}

function parseClassificationJson(text = "") {
  const raw = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const withoutFence = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const jsonObject = extractFirstJsonObject(withoutFence);
    if (!jsonObject) throw new Error("classification_invalid_json");
    return JSON.parse(jsonObject);
  }
}

function buildReaderClassificationPrompt({
  title,
  documentType,
  categories,
  samples,
  sampleStrategy,
  totalChars,
}) {
  return `请根据抽样文本为书籍选择一个主分类。

硬性规则：
- 只能从给定分类列表中选择 primaryCategoryId，不得创造新分类。
- primaryCategoryName 必须与 primaryCategoryId 对应。
- 如果文本不可用、无法判断或置信度不足，选择 unknown。
- 如果文本可用但不属于任何现有分类，优先选择 other（如果分类列表存在 other），否则选择 unknown。
- evidence 只能引用抽样片段中出现的信息，不要编造书名、作者、章节或不存在的概念。
- 只输出严格 JSON，不要 Markdown，不要解释。

输出 JSON 结构：
{"primaryCategoryId":"","primaryCategoryName":"","secondaryCategory":"","confidence":0,"reason":"","evidence":[],"tags":[]}

分类列表：
${JSON.stringify(categories)}

书籍信息：
${JSON.stringify({
  title: String(title || "").slice(0, 160),
  documentType,
  totalChars,
  sampleStrategy,
  sampleTextChars: classificationSampleCharCount(samples),
})}

抽样片段：
${JSON.stringify(samples)}`;
}

function validateClassificationResult({
  result,
  categories,
  sampleStrategy,
  title = "",
}) {
  const category = resolveClassificationCategory(result, categories);
  if (!category)
    return classificationFallback({
      title,
      categories,
      reason: safeClassificationReason("invalid_category"),
      sampleStrategy,
    });
  const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  if (confidence < CLASSIFICATION_CONFIDENCE_THRESHOLD)
    return classificationFallback({
      title,
      categories,
      reason: safeClassificationReason("low_confidence"),
      sampleStrategy,
    });
  const now = new Date().toISOString();
  return {
    success: true,
    categoryStatus: "classified",
    categoryStage: "classified",
    categoryReason: String(result.reason || "").slice(0, 180),
    category: {
      primaryCategoryId: category.id,
      primaryCategoryName: category.name,
      secondaryCategory: String(result.secondaryCategory || "")
        .trim()
        .slice(0, 40),
      tags: Array.isArray(result.tags)
        ? result.tags
            .map((tag) => String(tag).trim())
            .filter(Boolean)
            .slice(0, 6)
        : [],
      confidence,
      source: "llm",
      reason: String(result.reason || "")
        .trim()
        .slice(0, 180),
      evidence: Array.isArray(result.evidence)
        ? result.evidence
            .map((item) => String(item).trim())
            .filter(Boolean)
            .slice(0, 4)
        : [],
      sampleStrategy,
      classifiedAt: now,
      updatedAt: now,
    },
  };
}

function withClassificationTimeout(promise) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("classification_timeout");
      error.code = "CLASSIFICATION_TIMEOUT";
      reject(error);
    }, CLASSIFICATION_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function classifyReaderDocumentWithDeepSeek(body = {}) {
  const categories = sanitizedClassificationCategories(body.categories);
  if (!categories.length)
    return classificationFallback({
      title: body.title,
      categories,
      reason: safeClassificationReason("empty_categories"),
    });
  const samples = cappedClassificationSamples(body.samples);
  const sampleStrategy =
    String(body.sampleStrategy || "").slice(0, 80) +
    (classificationSampleCharCount(body.samples) > CLASSIFICATION_LLM_TEXT_LIMIT
      ? "-server-llm-cap-3000"
      : "");
  const sampleChars = classificationSampleCharCount(samples);
  if (!samples.length)
    return classificationFallback({
      title: body.title,
      categories,
      reason: safeClassificationReason("failed"),
      sampleStrategy,
    });

  const taskProvider = resolveTaskProviderModel(
    "reader_document_classification"
  );
  if (taskProvider.provider === "deepseek" && !process.env.DEEPSEEK_API_KEY)
    return classificationFallback({
      title: body.title,
      categories,
      reason: safeClassificationReason("missing_key"),
      sampleStrategy,
    });

  try {
    readerClassificationLog("start", {
      title: String(body.title || "").slice(0, 80),
      documentType: body.documentType,
      sampleCount: samples.length,
      sampleChars,
      categoryCount: categories.length,
    });
    const { connector: LLMConnector, provider } = getTaskConnector(
      "reader_document_classification"
    );
    if (
      typeof LLMConnector?.compressMessages !== "function" ||
      typeof LLMConnector?.getChatCompletion !== "function"
    ) {
      const error = new Error("classification_connector_unavailable");
      error.code =
        provider === "deepseek"
          ? "LLM_TASK_PROVIDER_MISSING_KEY"
          : "LLM_TASK_CONNECTOR_UNAVAILABLE";
      throw error;
    }
    const prompt = buildReaderClassificationPrompt({
      title: body.title,
      documentType: body.documentType,
      categories,
      samples,
      sampleStrategy,
      totalChars: Number(body.totalChars) || 0,
    });
    const messages = await LLMConnector.compressMessages(
      {
        systemPrompt:
          "你是书籍分类器。你必须只输出严格 JSON，并且只能从给定分类中选择。",
        userPrompt: prompt,
        contextTexts: [],
        chatHistory: [],
        attachments: [],
      },
      []
    );
    const llmStartedAt = Date.now();
    const { textResponse, metrics } = await withClassificationTimeout(
      LLMConnector.getChatCompletion(messages, {
        temperature: 0.1,
        responseFormat: { type: "json_object" },
      })
    );
    readerClassificationLog("llm_returned", {
      title: String(body.title || "").slice(0, 80),
      durationMs:
        Math.round(Number(metrics?.duration || 0) * 1000) ||
        Date.now() - llmStartedAt,
      responseChars: String(textResponse || "").length,
    });
    let parsed = null;
    try {
      parsed = parseClassificationJson(textResponse);
    } catch {
      const fallback = classificationFallback({
        title: body.title,
        categories,
        reason: safeClassificationReason("invalid_json"),
        sampleStrategy,
      });
      readerClassificationLog("fallback", {
        title: String(body.title || "").slice(0, 80),
        reason: fallback.reason,
      });
      return fallback;
    }
    const result = validateClassificationResult({
      result: parsed,
      categories,
      sampleStrategy,
      title: body.title,
    });
    readerClassificationLog(
      result.categoryStatus === "classified" ? "classified" : "fallback",
      {
        title: String(body.title || "").slice(0, 80),
        categoryId: result.category?.primaryCategoryId,
        confidence: result.category?.confidence,
        reason: result.reason || result.categoryReason || "",
      }
    );
    return result;
  } catch (error) {
    const type =
      error?.code === "CLASSIFICATION_TIMEOUT"
        ? "timeout"
        : error?.code === "LLM_TASK_PROVIDER_MISSING_KEY"
          ? "missing_key"
          : "unavailable";
    const fallback = classificationFallback({
      title: body.title,
      categories,
      reason: safeClassificationReason(type),
      sampleStrategy,
    });
    readerClassificationLog("fallback", {
      title: String(body.title || "").slice(0, 80),
      reason: fallback.reason,
    });
    return fallback;
  }
}

function workspaceReaderDocumentsEndpoints(app) {
  if (!app) return;
  startReaderThumbnailMaintenancePatrol();

  const standaloneReaderScope = (_request, response, next) => {
    response.locals.workspace = STANDALONE_READER_SCOPE;
    next();
  };

  app.get(
    "/reader-documents",
    [validatedRequest, flexUserRoleValid([ROLES.all]), standaloneReaderScope],
    async (request, response) => {
      try {
        const documents = await listReaderDocumentsForWorkspace({
          request,
          response,
          workspace: response.locals.workspace,
        });
        return response.status(200).json({ success: true, documents });
      } catch (error) {
        return response
          .status(400)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/reader-documents/upload",
    [validatedRequest, flexUserRoleValid([ROLES.all]), standaloneReaderScope],
    async (request, response) => {
      upload(request, response, async (uploadError) => {
        try {
          if (uploadError) return sendUploadError(response, uploadError);
          const workspace = response.locals.workspace;
          const { ext, mime } = assertAllowedUpload(request.file);
          const originalName = decodeMaybeMojibakeFilename(
            request.file.originalname
          );
          const readerDocumentId = crypto.randomUUID();
          const documentType = documentTypeFromExt(ext);
          const storedName = `original${ext}`;
          const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
          fs.mkdirSync(documentRoot, { recursive: true });

          const originalPath = safeResolve(documentRoot, storedName);
          fs.writeFileSync(originalPath, request.file.buffer);

          const content = contentForUpload({
            readerDocumentId,
            documentType,
            buffer: request.file.buffer,
          });
          const leadText = await extractReaderDuplicateLeadText({
            documentType,
            originalPath,
            buffer: request.file.buffer,
          });
          const duplicateResult = await findReaderDuplicateCandidate({
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
            return response.status(409).json({
              success: false,
              code: "READER_DUPLICATE",
              error: "检测到重复书籍。",
              duplicate: duplicateResult.duplicate,
            });
          }
          const ownerMetadata = await readerOwnerMetadataForRequest(
            request,
            response
          );
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
            originalFingerprint: fingerprintForBuffer(request.file.buffer),
            readerDuplicate: {
              titleKey: duplicateResult.signature.titleKey,
              leadTextHash: duplicateResult.signature.leadTextHash,
              duplicateOfReaderDocumentId:
                duplicateResult.duplicate?.readerDocumentId || null,
              duplicateIndex: continuingDuplicate
                ? duplicateResult.duplicateIndex
                : null,
              calculatedAt: isoNow(),
            },
            createdAt: new Date().toISOString(),
            ...ownerMetadata,
          };

          writeReaderJsonFile(documentRoot, "content.json", content);
          writeReaderJsonFile(documentRoot, "metadata.json", metadata);
          const finalMetadata = await finalizeReaderDocumentMetadata({
            workspace,
            readerDocumentId,
            metadata,
            originalPath,
            buffer: request.file.buffer,
            waitForDocxPreview: false,
          });
          writeReaderJsonFile(documentRoot, "metadata.json", finalMetadata);
          const pdfManifest = await maybePrewarmLargeReaderPdf({
            workspace,
            readerDocumentId,
            metadata: finalMetadata,
            originalPath,
          });
          const responseMetadata = pdfManifest
            ? { ...finalMetadata, pdfManifest }
            : finalMetadata;

          return response.status(200).json({
            success: true,
            warning: finalMetadata.previewWarning || null,
            readerDocumentId,
            sensitiveSession: readerSensitiveSessionForResponse(
              request,
              response,
              workspace,
              readerDocumentId,
              "reader-upload"
            ),
            ...(includeUploadContent(request) ? { content } : {}),
            metadata: metadataWithOriginalUrl(
              workspace,
              readerDocumentId,
              responseMetadata
            ),
            postprocess: readerPostprocessResponse(workspace, readerDocumentId)
              .postprocess,
          });
        } catch (error) {
          return sendUploadError(response, error);
        }
      });
    }
  );

  app.post(
    "/reader-documents/from-local-path",
    [validatedRequest, flexUserRoleValid([ROLES.all]), standaloneReaderScope],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const { absolutePath, stat } = await validateLocalReaderPath(
          request.body?.absolutePath,
          request.body?.fileAccessContext || {}
        );
        const readerDocumentId = crypto.randomUUID();
        const buffer = fs.readFileSync(absolutePath);
        const { content, metadata } = contentAndMetadataForLocalPath({
          readerDocumentId,
          absolutePath,
          buffer,
          stat,
        });
        const ownerMetadata = await readerOwnerMetadataForRequest(
          request,
          response
        );
        const ownedMetadata = { ...metadata, ...ownerMetadata };
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
        writeReaderJsonFile(documentRoot, "metadata.json", finalMetadata);

        return response.status(200).json({
          success: true,
          warning: finalMetadata.previewWarning || null,
          readerDocumentId,
          sensitiveSession: readerSensitiveSessionForResponse(
            request,
            response,
            workspace,
            readerDocumentId,
            "reader-local-path-open"
          ),
          content,
          metadata: metadataWithOriginalUrl(
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
  );

  app.post(
    "/reader-documents/classify",
    [validatedRequest, flexUserRoleValid([ROLES.all]), standaloneReaderScope],
    async (request, response) => {
      const result = await classifyReaderDocumentWithDeepSeek(
        request.body || {}
      );
      return response.status(200).json(result);
    }
  );

  app.get(
    "/reader-documents/ocr-config",
    [validatedRequest, flexUserRoleValid([ROLES.all]), standaloneReaderScope],
    async (_request, response) => {
      return response.status(200).json(readerOcrConfigStatus());
    }
  );

  app.post(
    "/reader-documents/ocr-screenshot",
    [validatedRequest, flexUserRoleValid([ROLES.all]), standaloneReaderScope],
    async (request, response) => {
      try {
        const result = await recognizeReaderScreenshot(request.body || {});
        return response.status(200).json(result);
      } catch (error) {
        return response.status(error.status || 500).json({
          success: false,
          error: error.message || "OCR request failed.",
        });
      }
    }
  );

  app.post(
    "/reader-documents/:readerDocumentId/postprocess",
    [validatedRequest, flexUserRoleValid([ROLES.all]), standaloneReaderScope],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        await readAuthorizedStandaloneReaderMetadata(
          request,
          response,
          documentRoot,
          readerDocumentId,
          "postprocess.enqueue"
        );
        const status = enqueueReaderPostprocessJob({
          workspace,
          readerDocumentId,
          tasks: request.body?.tasks,
          categories: request.body?.categories,
          force:
            request.body?.force === true || request.body?.intent === "manual",
          userId: response.locals.user?.id || null,
        });
        return response.status(202).json({
          ...readerPostprocessResponse(workspace, readerDocumentId),
          postprocess: status,
          status: status.status,
        });
      } catch (error) {
        return response
          .status(error.status || 400)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/reader-documents/:readerDocumentId/postprocess",
    [validatedRequest, flexUserRoleValid([ROLES.all]), standaloneReaderScope],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        await readAuthorizedStandaloneReaderMetadata(
          request,
          response,
          documentRoot,
          readerDocumentId,
          "postprocess.status"
        );
        return response
          .status(200)
          .json(readerPostprocessResponse(workspace, readerDocumentId));
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/reader-documents/:readerDocumentId/reopen-local-path",
    [validatedRequest, flexUserRoleValid([ROLES.all]), standaloneReaderScope],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const previousMetadata = await readAuthorizedStandaloneReaderMetadata(
          request,
          response,
          documentRoot,
          readerDocumentId,
          "reopen-local-path"
        );
        if (!previousMetadata.localPath) {
          const error = new Error("Reader document has no local path binding.");
          error.status = 400;
          throw error;
        }

        const { absolutePath, stat } = await validateLocalReaderPath(
          previousMetadata.localPath,
          request.body?.fileAccessContext || {}
        );
        const buffer = fs.readFileSync(absolutePath);
        const { content, metadata } = contentAndMetadataForLocalPath({
          readerDocumentId,
          absolutePath,
          buffer,
          stat,
        });
        const nextMetadata = {
          ...previousMetadata,
          ...metadata,
          reopenedAt: new Date().toISOString(),
        };

        writeReaderDocumentFiles(
          workspace,
          readerDocumentId,
          content,
          nextMetadata
        );
        const finalMetadata = await finalizeReaderDocumentMetadata({
          workspace,
          readerDocumentId,
          metadata: nextMetadata,
          originalPath: absolutePath,
          buffer,
        });
        writeReaderDocumentFiles(
          workspace,
          readerDocumentId,
          content,
          finalMetadata
        );

        return response.status(200).json({
          success: true,
          warning: finalMetadata.previewWarning || null,
          readerDocumentId,
          sensitiveSession: readerSensitiveSessionForResponse(
            request,
            response,
            workspace,
            readerDocumentId,
            "reader-local-path-reopen"
          ),
          content,
          metadata: metadataWithOriginalUrl(
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
  );

  app.get(
    "/reader-documents/:readerDocumentId/preview.pdf",
    [
      readerAccessTrace("standalone.preview.pdf"),
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      standaloneReaderScope,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        await readAuthorizedStandaloneReaderMetadata(
          request,
          response,
          documentRoot,
          readerDocumentId,
          "preview"
        );
        const sensitiveSession = validateReaderSensitiveSessionIfPresent({
          request,
          response,
          workspace,
          readerDocumentId,
        });
        if (!sensitiveSession.ok)
          return response.status(403).json({
            success: false,
            error: "Sensitive reader session is invalid or expired.",
          });
        const previewPath = safeResolve(documentRoot, DOCX_PREVIEW_NAME);
        if (!validNonEmptyFile(previewPath))
          return response.status(404).json({
            success: false,
            error: "Reader preview PDF not found.",
          });
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader(
          "Cache-Control",
          readerStreamCacheControlForRequest(request)
        );
        response.setHeader(
          "Content-Disposition",
          `inline; filename="${DOCX_PREVIEW_NAME}"`
        );
        return response.sendFile(previewPath);
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/reader-documents/:readerDocumentId/thumbnail.jpg",
    [
      readerAccessTrace("standalone.thumbnail"),
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      standaloneReaderScope,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        await readAuthorizedStandaloneReaderMetadata(
          request,
          response,
          documentRoot,
          readerDocumentId,
          "thumbnail"
        );
        const thumbnailPath = safeResolve(documentRoot, READER_THUMBNAIL_NAME);
        if (!validNonEmptyFile(thumbnailPath))
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
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/reader-documents/:readerDocumentId/page-preview",
    [
      readerAccessTrace("standalone.page-preview"),
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      standaloneReaderScope,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const metadata = await readAuthorizedStandaloneReaderMetadata(
          request,
          response,
          documentRoot,
          readerDocumentId,
          "page-preview"
        );
        const sensitiveSession = validateReaderSensitiveSessionIfPresent({
          request,
          response,
          workspace,
          readerDocumentId,
        });
        if (!sensitiveSession.ok)
          return response.status(403).json({
            success: false,
            error: "Sensitive reader session is invalid or expired.",
          });
        if (!metadataIsPdf(metadata))
          return response.status(400).json({
            success: false,
            error: "Reader page preview is only available for PDFs.",
          });
        const originalPath = await originalPathForReaderDocument({
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
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/reader-documents/:readerDocumentId/original",
    [
      readerAccessTrace("standalone.original"),
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      standaloneReaderScope,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const metadata = await readAuthorizedStandaloneReaderMetadata(
          request,
          response,
          documentRoot,
          readerDocumentId,
          "original"
        );
        const sensitiveSession = validateReaderSensitiveSessionIfPresent({
          request,
          response,
          workspace,
          readerDocumentId,
        });
        if (!sensitiveSession.ok)
          return response.status(403).json({
            success: false,
            error: "Sensitive reader session is invalid or expired.",
          });
        const originalPath = await originalPathForReaderDocument({
          documentRoot,
          metadata,
        });
        return sendReaderOriginalFile({
          request,
          response,
          originalPath,
          metadata,
        });
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/reader-documents/:readerDocumentId",
    [
      readerAccessTrace("standalone.metadata"),
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      standaloneReaderScope,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const includeContent = includeReaderDocumentContent(request);
        const metadata = readReaderMetadata(documentRoot, {
          readerDocumentId,
          endpoint: "get",
        });
        const content = includeContent
          ? readReaderJsonFile(documentRoot, "content.json", null, {
              readerDocumentId,
              endpoint: "get",
            })
          : null;
        await assertAuthorizedStandaloneReaderDocument({
          request,
          response,
          readerDocumentId,
          metadata,
        });
        const pdfManifest = readOptionalReaderPdfManifest(
          documentRoot,
          readerDocumentId
        );
        const responseMetadata = pdfManifest
          ? { ...metadata, pdfManifest }
          : metadata;

        return response.status(200).json({
          success: true,
          warning: metadata.previewWarning || null,
          sensitiveSession: readerSensitiveSessionForResponse(
            request,
            response,
            workspace,
            readerDocumentId,
            "reader-document-open"
          ),
          ...(includeContent ? { content } : {}),
          contentSummary: readerContentSummary({
            content,
            metadata: responseMetadata,
          }),
          metadata: metadataWithOriginalUrl(
            workspace,
            readerDocumentId,
            responseMetadata
          ),
          postprocess: readerPostprocessResponse(workspace, readerDocumentId)
            .postprocess,
        });
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.delete(
    "/reader-documents/:readerDocumentId",
    [validatedRequest, flexUserRoleValid([ROLES.all]), standaloneReaderScope],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const workspaceRoot = readerWorkspaceRoot(workspace);
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        if (!isWithin(workspaceRoot, documentRoot))
          throw new Error("Invalid reader document path.");
        if (!fs.existsSync(documentRoot))
          return response.status(200).json({ success: true, missing: true });
        const metadata = await readAuthorizedStandaloneReaderMetadata(
          request,
          response,
          documentRoot,
          readerDocumentId,
          "delete",
          { allowDeleted: true }
        );
        void recordClientTrustCheckpoint(request, {
          action: "reader_delete",
          resourceType: "reader_document",
          resourceId: readerDocumentId,
          outcome: "received",
        });
        const marker = markReaderDocumentDeleted({
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
  );

  app.get(
    "/workspace/:slug/reader-documents",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const documents = await listReaderDocumentsForWorkspace({
          request,
          response,
          workspace: response.locals.workspace,
        });
        return response.status(200).json({ success: true, documents });
      } catch (error) {
        return response
          .status(400)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/reader-documents/upload",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      upload(request, response, async (uploadError) => {
        try {
          if (uploadError) return sendUploadError(response, uploadError);
          const workspace = response.locals.workspace;
          const { ext, mime } = assertAllowedUpload(request.file);
          const originalName = decodeMaybeMojibakeFilename(
            request.file.originalname
          );
          const readerDocumentId = crypto.randomUUID();
          const documentType = documentTypeFromExt(ext);
          const storedName = `original${ext}`;
          const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
          fs.mkdirSync(documentRoot, { recursive: true });

          const originalPath = safeResolve(documentRoot, storedName);
          fs.writeFileSync(originalPath, request.file.buffer);

          const content = contentForUpload({
            readerDocumentId,
            documentType,
            buffer: request.file.buffer,
          });
          const leadText = await extractReaderDuplicateLeadText({
            documentType,
            originalPath,
            buffer: request.file.buffer,
          });
          const duplicateResult = await findReaderDuplicateCandidate({
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
            originalFingerprint: fingerprintForBuffer(request.file.buffer),
            readerDuplicate: {
              titleKey: duplicateResult.signature.titleKey,
              leadTextHash: duplicateResult.signature.leadTextHash,
              duplicateOfReaderDocumentId:
                duplicateResult.duplicate?.readerDocumentId || null,
              duplicateIndex: continuingDuplicate
                ? duplicateResult.duplicateIndex
                : null,
              calculatedAt: isoNow(),
            },
            createdAt: new Date().toISOString(),
          };

          writeReaderJsonFile(documentRoot, "content.json", content);
          writeReaderJsonFile(documentRoot, "metadata.json", metadata);
          const finalMetadata = await finalizeReaderDocumentMetadata({
            workspace,
            readerDocumentId,
            metadata,
            originalPath,
            buffer: request.file.buffer,
            waitForDocxPreview: false,
          });
          writeReaderJsonFile(documentRoot, "metadata.json", finalMetadata);
          const pdfManifest = await maybePrewarmLargeReaderPdf({
            workspace,
            readerDocumentId,
            metadata: finalMetadata,
            originalPath,
          });
          const responseMetadata = pdfManifest
            ? { ...finalMetadata, pdfManifest }
            : finalMetadata;

          return response.status(200).json({
            success: true,
            warning: finalMetadata.previewWarning || null,
            readerDocumentId,
            sensitiveSession: readerSensitiveSessionForResponse(
              request,
              response,
              workspace,
              readerDocumentId,
              "reader-upload"
            ),
            ...(includeUploadContent(request) ? { content } : {}),
            metadata: metadataWithOriginalUrl(
              workspace,
              readerDocumentId,
              responseMetadata
            ),
            postprocess: readerPostprocessResponse(workspace, readerDocumentId)
              .postprocess,
          });
        } catch (error) {
          return sendUploadError(response, error);
        }
      });
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/from-workspace",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
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
        const content = parsedWorkspaceContent(readerDocumentId, data);
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
        return response
          .status(400)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/reader-documents/from-local-path",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const { absolutePath, stat } = await validateLocalReaderPath(
          request.body?.absolutePath,
          request.body?.fileAccessContext || {}
        );
        const readerDocumentId = crypto.randomUUID();
        const buffer = fs.readFileSync(absolutePath);
        const { content, metadata } = contentAndMetadataForLocalPath({
          readerDocumentId,
          absolutePath,
          buffer,
          stat,
        });

        writeReaderDocumentFiles(
          workspace,
          readerDocumentId,
          content,
          metadata
        );
        const finalMetadata = await finalizeReaderDocumentMetadata({
          workspace,
          readerDocumentId,
          metadata,
          originalPath: absolutePath,
          buffer,
        });
        writeReaderDocumentFiles(
          workspace,
          readerDocumentId,
          content,
          finalMetadata
        );

        return response.status(200).json({
          success: true,
          warning: finalMetadata.previewWarning || null,
          readerDocumentId,
          sensitiveSession: readerSensitiveSessionForResponse(
            request,
            response,
            workspace,
            readerDocumentId,
            "reader-local-path-open"
          ),
          content,
          metadata: metadataWithOriginalUrl(
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
  );

  app.post(
    "/workspace/:slug/reader-documents/classify",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      const result = await classifyReaderDocumentWithDeepSeek(
        request.body || {}
      );
      return response.status(200).json(result);
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/ocr-config",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (_request, response) => {
      return response.status(200).json(readerOcrConfigStatus());
    }
  );

  app.post(
    "/workspace/:slug/reader-documents/ocr-screenshot",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const result = await recognizeReaderScreenshot(request.body || {});
        return response.status(200).json(result);
      } catch (error) {
        return response.status(error.status || 500).json({
          success: false,
          error: error.message || "OCR request failed.",
        });
      }
    }
  );

  app.post(
    "/workspace/:slug/reader-documents/:readerDocumentId/postprocess",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        readReaderJsonFile(documentRoot, "metadata.json", null, {
          readerDocumentId,
          endpoint: "postprocess.enqueue",
        });
        const status = enqueueReaderPostprocessJob({
          workspace,
          readerDocumentId,
          tasks: request.body?.tasks,
          categories: request.body?.categories,
          force:
            request.body?.force === true || request.body?.intent === "manual",
          userId: response.locals.user?.id || null,
        });
        return response.status(202).json({
          ...readerPostprocessResponse(workspace, readerDocumentId),
          postprocess: status,
          status: status.status,
        });
      } catch (error) {
        return response
          .status(400)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/:readerDocumentId/postprocess",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        readReaderJsonFile(documentRoot, "metadata.json", null, {
          readerDocumentId,
          endpoint: "postprocess.status",
        });
        return response
          .status(200)
          .json(readerPostprocessResponse(workspace, readerDocumentId));
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/reader-documents/:readerDocumentId/reopen-local-path",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const previousMetadata = readReaderJsonFile(
          documentRoot,
          "metadata.json",
          null,
          { readerDocumentId, endpoint: "reopen-local-path" }
        );
        if (!previousMetadata.localPath) {
          const error = new Error("Reader document has no local path binding.");
          error.status = 400;
          throw error;
        }

        const { absolutePath, stat } = await validateLocalReaderPath(
          previousMetadata.localPath,
          request.body?.fileAccessContext || {}
        );
        const buffer = fs.readFileSync(absolutePath);
        const { content, metadata } = contentAndMetadataForLocalPath({
          readerDocumentId,
          absolutePath,
          buffer,
          stat,
        });
        const nextMetadata = {
          ...previousMetadata,
          ...metadata,
          reopenedAt: new Date().toISOString(),
        };

        writeReaderDocumentFiles(
          workspace,
          readerDocumentId,
          content,
          nextMetadata
        );
        const finalMetadata = await finalizeReaderDocumentMetadata({
          workspace,
          readerDocumentId,
          metadata: nextMetadata,
          originalPath: absolutePath,
          buffer,
        });
        writeReaderDocumentFiles(
          workspace,
          readerDocumentId,
          content,
          finalMetadata
        );

        return response.status(200).json({
          success: true,
          warning: finalMetadata.previewWarning || null,
          readerDocumentId,
          sensitiveSession: readerSensitiveSessionForResponse(
            request,
            response,
            workspace,
            readerDocumentId,
            "reader-local-path-reopen"
          ),
          content,
          metadata: metadataWithOriginalUrl(
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
  );

  app.get(
    "/workspace/:slug/reader-documents/:readerDocumentId/preview.pdf",
    [
      readerAccessTrace("workspace.preview.pdf"),
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const metadata = readReaderJsonFile(
          documentRoot,
          "metadata.json",
          null,
          {
            readerDocumentId,
            endpoint: "preview",
          }
        );
        assertReaderDocumentVisible(documentRoot, metadata);
        const sensitiveSession = validateReaderSensitiveSessionIfPresent({
          request,
          response,
          workspace,
          readerDocumentId,
        });
        if (!sensitiveSession.ok)
          return response.status(403).json({
            success: false,
            error: "Sensitive reader session is invalid or expired.",
          });
        const previewPath = safeResolve(documentRoot, DOCX_PREVIEW_NAME);
        if (!validNonEmptyFile(previewPath))
          return response.status(404).json({
            success: false,
            error: "Reader preview PDF not found.",
          });
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader(
          "Cache-Control",
          readerStreamCacheControlForRequest(request)
        );
        response.setHeader(
          "Content-Disposition",
          `inline; filename="${DOCX_PREVIEW_NAME}"`
        );
        return response.sendFile(previewPath);
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/:readerDocumentId/thumbnail.jpg",
    [
      readerAccessTrace("workspace.thumbnail"),
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const metadata = readReaderJsonFile(
          documentRoot,
          "metadata.json",
          null,
          {
            readerDocumentId,
            endpoint: "thumbnail",
          }
        );
        assertReaderDocumentVisible(documentRoot, metadata);
        const thumbnailPath = safeResolve(documentRoot, READER_THUMBNAIL_NAME);
        if (!validNonEmptyFile(thumbnailPath))
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
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/:readerDocumentId/page-preview",
    [
      readerAccessTrace("workspace.page-preview"),
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const metadata = readReaderJsonFile(
          documentRoot,
          "metadata.json",
          null,
          {
            readerDocumentId,
            endpoint: "page-preview",
          }
        );
        assertReaderDocumentVisible(documentRoot, metadata);
        const sensitiveSession = validateReaderSensitiveSessionIfPresent({
          request,
          response,
          workspace,
          readerDocumentId,
        });
        if (!sensitiveSession.ok)
          return response.status(403).json({
            success: false,
            error: "Sensitive reader session is invalid or expired.",
          });
        if (!metadataIsPdf(metadata))
          return response.status(400).json({
            success: false,
            error: "Reader page preview is only available for PDFs.",
          });
        const originalPath = await originalPathForReaderDocument({
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
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/:readerDocumentId/original",
    [
      readerAccessTrace("workspace.original"),
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const metadata = readReaderJsonFile(
          documentRoot,
          "metadata.json",
          null,
          {
            readerDocumentId,
            endpoint: "original",
          }
        );
        assertReaderDocumentVisible(documentRoot, metadata);
        const sensitiveSession = validateReaderSensitiveSessionIfPresent({
          request,
          response,
          workspace,
          readerDocumentId,
        });
        if (!sensitiveSession.ok)
          return response.status(403).json({
            success: false,
            error: "Sensitive reader session is invalid or expired.",
          });
        const originalPath = await originalPathForReaderDocument({
          documentRoot,
          metadata,
        });
        return sendReaderOriginalFile({
          request,
          response,
          originalPath,
          metadata,
        });
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/:readerDocumentId",
    [
      readerAccessTrace("workspace.metadata"),
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const includeContent = includeReaderDocumentContent(request);
        const metadata = readReaderMetadata(documentRoot, {
          readerDocumentId,
          endpoint: "get",
        });
        assertReaderDocumentVisible(documentRoot, metadata);
        const content = includeContent
          ? readReaderJsonFile(documentRoot, "content.json", null, {
              readerDocumentId,
              endpoint: "get",
            })
          : null;
        const pdfManifest = readOptionalReaderPdfManifest(
          documentRoot,
          readerDocumentId
        );
        const responseMetadata = pdfManifest
          ? { ...metadata, pdfManifest }
          : metadata;

        return response.status(200).json({
          success: true,
          warning: metadata.previewWarning || null,
          sensitiveSession: readerSensitiveSessionForResponse(
            request,
            response,
            workspace,
            readerDocumentId,
            "reader-document-open"
          ),
          ...(includeContent ? { content } : {}),
          contentSummary: readerContentSummary({
            content,
            metadata: responseMetadata,
          }),
          metadata: metadataWithOriginalUrl(
            workspace,
            readerDocumentId,
            responseMetadata
          ),
          postprocess: readerPostprocessResponse(workspace, readerDocumentId)
            .postprocess,
        });
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.delete(
    "/workspace/:slug/reader-documents/:readerDocumentId",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const workspaceRoot = readerWorkspaceRoot(workspace);
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        if (!isWithin(workspaceRoot, documentRoot))
          throw new Error("Invalid reader document path.");
        if (!fs.existsSync(documentRoot))
          return response.status(200).json({ success: true, missing: true });
        const metadata = readReaderJsonFile(
          documentRoot,
          "metadata.json",
          null,
          {
            readerDocumentId,
            endpoint: "delete",
          }
        );
        void recordClientTrustCheckpoint(request, {
          action: "reader_delete",
          resourceType: "reader_document",
          resourceId: readerDocumentId,
          outcome: "received",
        });
        const marker = markReaderDocumentDeleted({
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
          .status(400)
          .json({ success: false, error: error.message });
      }
    }
  );
}

module.exports = {
  MAX_READER_FILE_SIZE,
  workspaceReaderDocumentsEndpoints,
  _private: {
    assertAllowedUpload,
    assertReaderDocumentId,
    buildReaderClassificationSamples,
    cappedClassificationSamples,
    classifyReaderDocumentWithDeepSeek,
    classificationSampleCharCount,
    compactClassificationText,
    duplicateSignatureFor,
    extractReaderDuplicateLeadText,
    createClassificationAccumulator,
    extractReaderClassificationText,
    findReaderDuplicateCandidate,
    findLibreOfficeBinary,
    readerPreviewEngineStatus,
    metadataNeedsPdfPreview,
    generateReaderDocumentThumbnail,
    cancelReaderPostprocessJob,
    enqueueReaderPostprocessJob,
    markReaderDocumentDeleted,
    restoreReaderDocumentVisibility,
    listReaderDocumentsForWorkspace,
    metadataWithOriginalUrl,
    orderedPdfPreviewPrebuildPages,
    orderedPdfPreviewWindowPages,
    readEpubPackage,
    readOptionalReaderPdfManifest,
    parseClassificationJson,
    readerDocumentRoot,
    readerDocumentIsDeleted,
    readerOriginalEtag,
    readerWorkspaceRoot,
    runReaderThumbnailMaintenancePass,
    readerOcrConfigStatus,
    readerOcrProviderOptions,
    readerAutoClassificationEnabled,
    readReaderPostprocessStatus,
    readReaderContentAndMetadata,
    readAuthorizedStandaloneReaderMetadata,
    readReaderJsonFile,
    readReaderMetadata,
    writeReaderJsonFile,
    readerPostprocessResponse,
    readerContentSummary,
    recognizeReaderScreenshot,
    safeSegment,
    sanitizedClassificationCategories,
    sanitizedPostprocessTasks,
    safeClassificationReason,
    setReaderOriginalHeaders,
    STANDALONE_READER_SCOPE,
    validateClassificationResult,
  },
};
