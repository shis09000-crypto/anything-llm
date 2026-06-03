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
const { markdownToPdf } = require("@mintplex-labs/mdpdf");
const { NodeHtmlMarkdown } = require("node-html-markdown");
const { Document } = require("../models/documents");
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

const SCHEMA_VERSION = 1;
const MAX_READER_FILE_SIZE = 500 * 1024 * 1024;
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
const READER_THUMBNAIL_NAME = "thumbnail.jpg";
const READER_POSTPROCESS_STATUS_NAME = "postprocess.json";
const READER_POSTPROCESS_TEXT_LIMIT = 100_000;
const READER_THUMBNAIL_WIDTH = 360;
const READER_THUMBNAIL_HEIGHT = 520;
const READER_THUMBNAIL_QUALITY = 88;
const READER_POSTPROCESS_QUEUE_CONCURRENCY = Math.max(
  1,
  Number(process.env.READER_POSTPROCESS_QUEUE_CONCURRENCY) || 1
);
const readerPostprocessJobs = new Map();
const readerPostprocessQueue = new PQueue({
  concurrency: READER_POSTPROCESS_QUEUE_CONCURRENCY,
});
const CLASSIFICATION_TIMEOUT_MS = 20_000;
const CLASSIFICATION_LLM_TEXT_LIMIT = 3_000;
const CLASSIFICATION_CONFIDENCE_THRESHOLD = 0.55;

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
  const workspaceSegment = safeWorkspaceSegment(workspace);
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

function findTextutilBinary() {
  return fileExists("/usr/bin/textutil")
    ? "/usr/bin/textutil"
    : findOnPath("textutil");
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

function previewUrlForDocument(workspace, readerDocumentId) {
  return `/api/workspace/${workspace.slug}/reader-documents/${readerDocumentId}/preview.pdf`;
}

function thumbnailUrlForDocument(workspace, readerDocumentId) {
  return `/api/workspace/${workspace.slug}/reader-documents/${readerDocumentId}/thumbnail.jpg`;
}

function metadataIsDocx(metadata = {}) {
  try {
    return (
      normalizedExtension(
        metadata.localPath || metadata.storedName || metadata.originalName || ""
      ) === ".docx"
    );
  } catch {
    return false;
  }
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
  if (!metadataIsDocx(metadata)) return;
  ensureDocxPreview({
    workspace,
    readerDocumentId,
    metadata,
    originalPath,
    fingerprint,
  })
    .then((finalMetadata) => {
      const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
      writeReaderJsonFile(documentRoot, "metadata.json", finalMetadata);
    })
    .catch((error) =>
      console.warn("[ReaderDocument] DOCX preview metadata update failed", {
        readerDocumentId,
        error: error.message,
      })
    );
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
              ? "DOCX preview conversion timed out."
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

async function convertDocxToPreviewWithTextutil({
  documentRoot,
  originalPath,
  tempDir,
}) {
  const textutilBinary = findTextutilBinary();
  if (!textutilBinary) throw new Error("textutil is not available.");

  const htmlPath = path.join(tempDir, "docx-preview.html");
  await execFileWithTimeout(textutilBinary, [
    "-convert",
    "html",
    "-output",
    htmlPath,
    originalPath,
  ]);
  if (!validNonEmptyFile(htmlPath))
    throw new Error("textutil produced an empty DOCX HTML preview.");

  const html = fs.readFileSync(htmlPath, "utf8");
  const markdown = NodeHtmlMarkdown.translate(html).trim();
  if (!markdown)
    throw new Error("DOCX HTML preview could not be converted to Markdown.");

  const pdfBuffer = await markdownToPdf(markdown);
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0)
    throw new Error("Markdown PDF fallback produced an empty PDF.");

  const previewPath = safeResolve(documentRoot, DOCX_PREVIEW_NAME);
  fs.writeFileSync(previewPath, pdfBuffer);
  if (!validNonEmptyFile(previewPath))
    throw new Error("DOCX preview PDF failed validation.");
  return { previewPath, source: "textutil-mdpdf" };
}

async function convertDocxToPreview({ documentRoot, originalPath }) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-docx-preview-")
  );
  const errors = [];
  try {
    try {
      return await convertDocxToPreviewWithLibreOffice({
        documentRoot,
        originalPath,
        tempDir,
      });
    } catch (error) {
      errors.push(`LibreOffice: ${error.message}`);
      fs.rmSync(safeResolve(documentRoot, DOCX_PREVIEW_NAME), { force: true });
    }

    try {
      return await convertDocxToPreviewWithTextutil({
        documentRoot,
        originalPath,
        tempDir,
      });
    } catch (error) {
      errors.push(`textutil/mdpdf: ${error.message}`);
      fs.rmSync(safeResolve(documentRoot, DOCX_PREVIEW_NAME), { force: true });
      throw new Error(errors.join(" | "));
    }
  } finally {
    cleanupTempDir(tempDir);
  }
}

async function ensureDocxPreview({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
  fingerprint,
}) {
  if (!metadataIsDocx(metadata)) return metadata;
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const previewPath = safeResolve(documentRoot, DOCX_PREVIEW_NAME);
  const hasFreshPreview =
    metadata.previewFingerprint === fingerprint &&
    validNonEmptyFile(previewPath);

  if (hasFreshPreview) {
    return {
      ...metadata,
      previewPdfName: DOCX_PREVIEW_NAME,
      previewMimeType: "application/pdf",
      previewPdfUrl: previewUrlForDocument(workspace, readerDocumentId),
      previewWarning: null,
    };
  }

  const jobKey = `${safeWorkspaceSegment(workspace)}:${readerDocumentId}:${fingerprint}`;
  if (docxPreviewJobs.has(jobKey)) return await docxPreviewJobs.get(jobKey);

  const job = (async () => {
    try {
      const preview = await convertDocxToPreview({
        documentRoot,
        originalPath,
      });
      return {
        ...metadata,
        previewPdfName: DOCX_PREVIEW_NAME,
        previewMimeType: "application/pdf",
        previewPdfUrl: previewUrlForDocument(workspace, readerDocumentId),
        previewGeneratedAt: new Date().toISOString(),
        previewSource: preview.source,
        previewFingerprint: fingerprint,
        previewWarning: null,
      };
    } catch (error) {
      fs.rmSync(previewPath, { force: true });
      return {
        ...metadata,
        previewPdfName: null,
        previewMimeType: null,
        previewPdfUrl: null,
        previewGeneratedAt: null,
        previewSource: "libreoffice",
        previewFingerprint: fingerprint,
        previewWarning:
          error.message ||
          "DOCX preview conversion failed. HTML fallback used.",
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
  return {
    ...metadata,
    originalName: decodeMaybeMojibakeFilename(metadata.originalName),
    originalUrl: `/api/workspace/${workspace.slug}/reader-documents/${readerDocumentId}/original`,
    ...(metadata.previewPdfName
      ? {
          previewPdfUrl: previewUrlForDocument(workspace, readerDocumentId),
          previewMimeType: "application/pdf",
        }
      : {}),
    ...(metadata.thumbnailName
      ? {
          thumbnailUrl: thumbnailUrlForDocument(workspace, readerDocumentId),
          thumbnailMimeType: "image/jpeg",
        }
      : {}),
  };
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
  return `${safeWorkspaceSegment(workspace)}:${assertReaderDocumentId(readerDocumentId)}`;
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

async function originalPathForReaderDocument({ documentRoot, metadata }) {
  if (metadata.localPath)
    return (await validateLocalReaderPath(metadata.localPath)).absolutePath;
  if (!metadata.storedName) return null;
  return safeResolve(documentRoot, metadata.storedName);
}

function thumbnailDataUrlFromDocumentRoot(documentRoot) {
  const thumbnailPath = safeResolve(documentRoot, READER_THUMBNAIL_NAME);
  if (!validNonEmptyFile(thumbnailPath)) return null;
  return `data:image/jpeg;base64,${fs.readFileSync(thumbnailPath).toString("base64")}`;
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
  if (!sourceBuffer) {
    const previewPath = safeResolve(documentRoot, DOCX_PREVIEW_NAME);
    const quickLookPath =
      content.documentType === "docx" && validNonEmptyFile(previewPath)
        ? previewPath
        : originalPath;
    sourceBuffer = await quickLookThumbnailBuffer(quickLookPath);
  }
  const thumbnailBuffer = await normalizeThumbnailBuffer(sourceBuffer);
  if (!thumbnailBuffer) return null;
  const thumbnailPath = safeResolve(documentRoot, READER_THUMBNAIL_NAME);
  fs.writeFileSync(thumbnailPath, thumbnailBuffer);
  const nextMetadata = {
    ...metadata,
    thumbnailName: READER_THUMBNAIL_NAME,
    thumbnailMimeType: "image/jpeg",
    thumbnailUrl: thumbnailUrlForDocument(workspace, readerDocumentId),
    thumbnailGeneratedAt: isoNow(),
  };
  writeReaderJsonFile(documentRoot, "metadata.json", nextMetadata);
  return {
    metadata: nextMetadata,
    thumbnailDataUrl: `data:image/jpeg;base64,${thumbnailBuffer.toString("base64")}`,
  };
}

function sanitizedPostprocessTasks(tasks = []) {
  const allowed = new Set(["thumbnail", "classification"]);
  const source = Array.isArray(tasks) && tasks.length ? tasks : [...allowed];
  return [...new Set(source.filter((task) => allowed.has(task)))];
}

async function runReaderPostprocessJob({
  workspace,
  readerDocumentId,
  tasks,
  categories,
}) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  if (!fs.existsSync(documentRoot)) return;
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

  if (tasks.includes("thumbnail")) {
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
          status: thumbnail?.thumbnailDataUrl ? "complete" : "failed",
          reason: thumbnail?.thumbnailDataUrl ? "" : "缩略图生成失败。",
          generatedAt: thumbnail?.metadata?.thumbnailGeneratedAt || null,
        })
      );
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
    }
  }

  updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) => ({
    ...status,
    status: "complete",
    completedAt: isoNow(),
  }));
}

function enqueueReaderPostprocessJob({
  workspace,
  readerDocumentId,
  tasks,
  categories,
}) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const requestedTasks = sanitizedPostprocessTasks(tasks);
  if (!requestedTasks.length) {
    return readReaderPostprocessStatus(documentRoot, readerDocumentId);
  }

  const key = readerPostprocessKey(workspace, readerDocumentId);
  if (readerPostprocessJobs.has(key))
    return readReaderPostprocessStatus(documentRoot, readerDocumentId);

  const queuedAt = isoNow();
  const queuedStatus = writeReaderPostprocessStatus(documentRoot, {
    ...readReaderPostprocessStatus(documentRoot, readerDocumentId),
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
      { ...readReaderPostprocessStatus(documentRoot, readerDocumentId).tasks }
    ),
  });

  const job = readerPostprocessQueue
    .add(() =>
      runReaderPostprocessJob({
        workspace,
        readerDocumentId,
        tasks: requestedTasks,
        categories,
      })
    )
    .catch(() => null)
    .finally(() => readerPostprocessJobs.delete(key));
  readerPostprocessJobs.set(key, job);
  return queuedStatus;
}

function readerPostprocessResponse(workspace, readerDocumentId) {
  const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
  const status = readReaderPostprocessStatus(documentRoot, readerDocumentId);
  const classification = status.tasks?.classification?.result || null;
  return {
    success: true,
    status: status.status,
    postprocess: status,
    tasks: status.tasks || {},
    thumbnailDataUrl: thumbnailDataUrlFromDocumentRoot(documentRoot),
    classification,
  };
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

function readerClassificationLog(message, data = {}) {
  console.log("[ReaderDocumentClassification]", message, data);
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
- 如果文本可用但不属于任何现有分类，选择 other。
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

function validateClassificationResult({ result, categories, sampleStrategy }) {
  const category = categories.find(
    (item) => item.id === String(result?.primaryCategoryId || "")
  );
  if (!category)
    return unknownClassificationCategory(
      categories,
      safeClassificationReason("invalid_category")
    );
  const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  if (confidence < CLASSIFICATION_CONFIDENCE_THRESHOLD)
    return unknownClassificationCategory(
      categories,
      safeClassificationReason("low_confidence")
    );
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
    return unknownClassificationCategory(
      categories,
      safeClassificationReason("empty_categories")
    );
  const samples = cappedClassificationSamples(body.samples);
  const sampleStrategy =
    String(body.sampleStrategy || "").slice(0, 80) +
    (classificationSampleCharCount(body.samples) > CLASSIFICATION_LLM_TEXT_LIMIT
      ? "-server-llm-cap-3000"
      : "");
  const sampleChars = classificationSampleCharCount(samples);
  if (!samples.length)
    return unknownClassificationCategory(
      categories,
      safeClassificationReason("failed")
    );

  const taskProvider = resolveTaskProviderModel(
    "reader_document_classification"
  );
  if (taskProvider.provider === "deepseek" && !process.env.DEEPSEEK_API_KEY)
    return unknownClassificationCategory(
      categories,
      safeClassificationReason("missing_key")
    );

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
      const fallback = unknownClassificationCategory(
        categories,
        safeClassificationReason("invalid_json")
      );
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
    const fallback = unknownClassificationCategory(
      categories,
      safeClassificationReason(type)
    );
    readerClassificationLog("fallback", {
      title: String(body.title || "").slice(0, 80),
      reason: fallback.reason,
    });
    return fallback;
  }
}

function workspaceReaderDocumentsEndpoints(app) {
  if (!app) return;

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
          const metadata = {
            schemaVersion: SCHEMA_VERSION,
            readerDocumentId,
            source: "reader_upload",
            originalName,
            storedName,
            mimeType: mime,
            size: request.file.size,
            originalFingerprint: fingerprintForBuffer(request.file.buffer),
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

          return response.status(200).json({
            success: true,
            warning: finalMetadata.previewWarning || null,
            readerDocumentId,
            content,
            metadata: metadataWithOriginalUrl(
              workspace,
              readerDocumentId,
              finalMetadata
            ),
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
          endpoint: "preview",
        });
        const previewPath = safeResolve(documentRoot, DOCX_PREVIEW_NAME);
        if (!validNonEmptyFile(previewPath))
          return response.status(404).json({
            success: false,
            error: "DOCX preview PDF not found.",
          });
        response.setHeader("Content-Type", "application/pdf");
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
          endpoint: "thumbnail",
        });
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
    "/workspace/:slug/reader-documents/:readerDocumentId/original",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
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
        const originalPath = metadata.localPath
          ? (await validateLocalReaderPath(metadata.localPath)).absolutePath
          : safeResolve(documentRoot, metadata.storedName);
        return response.sendFile(originalPath);
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/:readerDocumentId",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const { content, metadata: initialMetadata } =
          readReaderContentAndMetadata(documentRoot, {
            readerDocumentId,
            endpoint: "get",
          });
        let metadata = initialMetadata;
        if (metadataIsDocx(metadata)) {
          const originalPath = metadata.localPath
            ? (await validateLocalReaderPath(metadata.localPath)).absolutePath
            : safeResolve(documentRoot, metadata.storedName);
          metadata = await finalizeReaderDocumentMetadata({
            workspace,
            readerDocumentId,
            metadata,
            originalPath,
          });
          writeReaderJsonFile(documentRoot, "metadata.json", metadata);
        }

        return response.status(200).json({
          success: true,
          warning: metadata.previewWarning || null,
          content,
          metadata: metadataWithOriginalUrl(
            workspace,
            readerDocumentId,
            metadata
          ),
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
          return response
            .status(404)
            .json({ success: false, error: "Reader document not found." });
        fs.rmSync(documentRoot, { recursive: true, force: true });
        return response.status(200).json({ success: true });
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
    createClassificationAccumulator,
    extractReaderClassificationText,
    findLibreOfficeBinary,
    generateReaderDocumentThumbnail,
    readEpubPackage,
    parseClassificationJson,
    readerDocumentRoot,
    readerOcrConfigStatus,
    readerOcrProviderOptions,
    readerPostprocessResponse,
    recognizeReaderScreenshot,
    safeSegment,
    sanitizedClassificationCategories,
    sanitizedPostprocessTasks,
    safeClassificationReason,
    validateClassificationResult,
  },
};
