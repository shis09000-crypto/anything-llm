const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const documentsCore = require("./documentsCore");

const DOCX_PREVIEW_TIMEOUT_MS = 45_000;
const DOCX_PREVIEW_NAME = "preview.pdf";
const READER_PREVIEW_REQUIRED_FONTS = [
  "Noto Sans CJK SC",
  "Noto Serif CJK SC",
  "Noto Color Emoji",
  "Liberation Serif",
];
const previewJobs = new Map();

function validNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK | fs.constants.X_OK);
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

function documentTypeFromMetadata(metadata = {}) {
  const explicit =
    metadata.documentType ||
    metadata.stream?.documentType ||
    metadata.contentSummary?.documentType;
  if (explicit) return String(explicit).toLowerCase();

  const mimeType = String(metadata.mimeType || metadata.stream?.mimeType || "")
    .trim()
    .toLowerCase();
  const ext = path
    .extname(
      String(
        metadata.localPath ||
          metadata.storedName ||
          metadata.originalName ||
          metadata.previewPdfName ||
          ""
      ).toLowerCase()
    )
    .toLowerCase();

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  )
    return "docx";
  if (mimeType === "text/markdown" || ext === ".md" || ext === ".markdown")
    return "markdown";
  return null;
}

function metadataIsDocx(metadata = {}) {
  return documentTypeFromMetadata(metadata) === "docx";
}

function metadataIsMarkdown(metadata = {}) {
  return documentTypeFromMetadata(metadata) === "markdown";
}

function metadataNeedsPdfPreview(metadata = {}) {
  return metadataIsDocx(metadata) || metadataIsMarkdown(metadata);
}

function previewEngineForMetadata(metadata = {}) {
  return metadataIsMarkdown(metadata) ? "mdpdf" : "libreoffice";
}

function previewEngineVersionForMetadata(metadata = {}) {
  if (metadataIsMarkdown(metadata)) return null;
  const binary = findLibreOfficeBinary();
  return binary ? executableVersion(binary) : null;
}

function previewDocumentLabel(metadata = {}) {
  return metadataIsMarkdown(metadata) ? "Markdown" : "DOCX";
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

  const previewPath = documentsCore.safeResolve(
    documentRoot,
    DOCX_PREVIEW_NAME
  );
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
    fs.rmSync(documentsCore.safeResolve(documentRoot, DOCX_PREVIEW_NAME), {
      force: true,
    });
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
    const previewPath = documentsCore.safeResolve(
      documentRoot,
      DOCX_PREVIEW_NAME
    );
    fs.writeFileSync(previewPath, pdfBuffer);
    if (!validNonEmptyFile(previewPath))
      throw new Error("Markdown preview PDF failed validation.");
    return { previewPath, source: "mdpdf" };
  } catch (error) {
    fs.rmSync(documentsCore.safeResolve(documentRoot, DOCX_PREVIEW_NAME), {
      force: true,
    });
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

function previewJobKey({ workspace, readerDocumentId, fingerprint }) {
  const workspaceKey =
    workspace?.readerStorageSegment ||
    (workspace?.slug
      ? documentsCore.safeSegment(workspace.slug, "workspace slug")
      : "standalone");
  return `${workspaceKey}:${readerDocumentId}:${fingerprint}`;
}

async function ensurePdfPreview({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
  fingerprint,
  previewUrlForDocument,
}) {
  if (!metadataNeedsPdfPreview(metadata)) return metadata;
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  const previewPath = documentsCore.safeResolve(
    documentRoot,
    DOCX_PREVIEW_NAME
  );
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
      previewPdfUrl:
        typeof previewUrlForDocument === "function"
          ? previewUrlForDocument(workspace, readerDocumentId)
          : metadata.previewPdfUrl || null,
      previewStatus: "ready",
      previewWarning: null,
      previewLastError: null,
    };
  }

  const jobKey = previewJobKey({ workspace, readerDocumentId, fingerprint });
  if (previewJobs.has(jobKey)) return await previewJobs.get(jobKey);

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
        previewPdfUrl:
          typeof previewUrlForDocument === "function"
            ? previewUrlForDocument(workspace, readerDocumentId)
            : metadata.previewPdfUrl || null,
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

  previewJobs.set(jobKey, job);
  try {
    return await job;
  } finally {
    previewJobs.delete(jobKey);
  }
}

module.exports = {
  DOCX_PREVIEW_NAME,
  convertDocxToPreview,
  convertDocxToPreviewWithLibreOffice,
  convertMarkdownToPreview,
  convertReaderDocumentToPreview,
  ensurePdfPreview,
  findLibreOfficeBinary,
  metadataNeedsPdfPreview,
  previewDocumentLabel,
  previewEngineForMetadata,
  previewEngineVersionForMetadata,
  readerPreviewEngineStatus,
};
