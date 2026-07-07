const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { hashLogValue } = require("../../utils/security/redaction");
const documentsCore = require("./documentsCore");
const formatReaders = require("./formatReaders");
const ingestCore = require("./ingestCore");
const ocr = require("./ocr");
const pdfMediaCore = require("./pdfMediaCore");
const readerLinks = require("./readerLinks");

const SCHEMA_VERSION = 1;
const DOCX_PREVIEW_NAME = "preview.pdf";
const READER_THUMBNAIL_NAME = "thumbnail.jpg";
const READER_PDF_MANIFEST_NAME = "pdf-manifest.json";
const READER_THUMBNAIL_WIDTH = 360;
const READER_THUMBNAIL_HEIGHT = 520;
const READER_THUMBNAIL_QUALITY = 88;
const READER_PDF_THUMBNAIL_TIMEOUT_MS = 30_000;
const READER_PDF_PAGE_PREVIEW_TIMEOUT_MS = 18_000;
const READER_PDF_PAGE_PREVIEW_DPI = 96;
const READER_PDF_PAGE_PREVIEW_QUALITY = 74;
const READER_PDF_PREWARM_MIN_BYTES = 10 * 1024 * 1024;
const READER_PDF_PREVIEW_PREBUILD_PAUSE_MS = Math.max(
  0,
  Number(process.env.READER_PDF_PREVIEW_PREBUILD_PAUSE_MS) || 35
);
const READER_MEDIA_EXEC_TIMEOUT_MS = 45_000;
const readerPdfManifestJobs = new Map();
const readerPdfPagePreviewJobs = new Map();
const readerPdfPreviewPrebuildJobs = new Map();

function isoNow() {
  return new Date().toISOString();
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function validNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
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

function execFileWithTimeout(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: READER_MEDIA_EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 4,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          const reason =
            error.killed || error.signal
              ? "Reader media command timed out."
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

function readOptionalReaderPdfManifest(documentRoot, readerDocumentId) {
  return pdfMediaCore.readOptionalReaderPdfManifest({
    readReaderJsonFile: documentsCore.readReaderJsonFile,
    documentRoot,
    readerDocumentId,
  });
}

function pdfManifestMatchesMetadata(manifest = null, metadata = {}) {
  return pdfMediaCore.pdfManifestMatchesMetadata(
    manifest,
    metadata,
    SCHEMA_VERSION
  );
}

function writeReaderPdfManifest({
  documentRoot,
  readerDocumentId,
  metadata,
  manifest,
}) {
  const nextManifest = pdfMediaCore.buildReaderPdfManifest({
    readerDocumentId,
    metadata,
    manifest,
    schemaVersion: SCHEMA_VERSION,
    now: isoNow(),
  });
  documentsCore.writeReaderJsonFile(
    documentRoot,
    READER_PDF_MANIFEST_NAME,
    nextManifest
  );
  return nextManifest;
}

async function ensureReaderPdfManifest({
  documentRoot,
  readerDocumentId,
  metadata,
  originalPath,
}) {
  if (!ingestCore.metadataIsPdf(metadata) || !validNonEmptyFile(originalPath))
    return null;
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
          ...pdfMediaCore.parsePdfInfoManifest(stdout),
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

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const previewPath = documentsCore.safeResolve(
    documentRoot,
    pdfMediaCore.pdfPagePreviewName(pageNumber)
  );
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
  if (!ingestCore.metadataIsPdf(metadata) || !validNonEmptyFile(originalPath))
    return;
  const pageCount = Number(manifest?.pageCount || 0);
  const jobKey = `${documentRoot}:prebuild:${includeAll ? "all" : focusPage}`;
  if (readerPdfPreviewPrebuildJobs.has(jobKey)) return;

  const job = (async () => {
    const startedAt = Date.now();
    const existingPages = existingPdfPreviewPageSet(documentRoot);
    const pages = pdfMediaCore
      .orderedPdfPreviewPrebuildPages({
        manifest,
        focusPage,
        includeAll,
      })
      .filter((page) => !existingPages.has(page));
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
  if (!ingestCore.metadataIsPdf(metadata)) return;
  if (Number(metadata?.size || 0) < READER_PDF_PREWARM_MIN_BYTES) return;
  if (!manifest?.pageCount) return;

  documentsCore
    .originalPathForReaderDocument({ documentRoot, metadata })
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
  if (!ingestCore.metadataIsPdf(metadata)) return null;
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  const manifest = await ensureReaderPdfManifest({
    documentRoot,
    readerDocumentId,
    metadata,
    originalPath,
  });
  const pageNumber = pdfMediaCore.normalizedPdfPageNumber(
    prewarmPage,
    manifest
  );
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
    !ingestCore.metadataIsPdf(metadata) ||
    Number(metadata?.size || 0) < READER_PDF_PREWARM_MIN_BYTES
  ) {
    return null;
  }
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  const manifest = await ensureReaderPdfManifest({
    documentRoot,
    readerDocumentId,
    metadata,
    originalPath,
  });
  const pageNumber = pdfMediaCore.normalizedPdfPageNumber(1, manifest);
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

async function generateReaderDocumentThumbnail({
  workspace,
  readerDocumentId,
  content,
  metadata,
  originalPath,
}) {
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  let sourceBuffer = null;
  if (content.documentType === "epub") {
    sourceBuffer = formatReaders.epubCoverImageBuffer(originalPath);
  }
  if (!sourceBuffer && content.documentType === "pdf") {
    sourceBuffer = await pdfThumbnailBuffer(originalPath);
  }
  if (!sourceBuffer) {
    const previewPath = documentsCore.safeResolve(
      documentRoot,
      DOCX_PREVIEW_NAME
    );
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
  const thumbnailPath = documentsCore.safeResolve(
    documentRoot,
    READER_THUMBNAIL_NAME
  );
  fs.writeFileSync(thumbnailPath, thumbnailBuffer);
  const nextMetadata = {
    ...metadata,
    thumbnailName: READER_THUMBNAIL_NAME,
    thumbnailMimeType: "image/jpeg",
    thumbnailUrl: readerLinks.existingThumbnailUrlForDocument(
      workspace,
      readerDocumentId
    ),
    thumbnailGeneratedAt: isoNow(),
  };
  documentsCore.writeReaderJsonFile(
    documentRoot,
    "metadata.json",
    nextMetadata
  );
  return {
    metadata: nextMetadata,
    thumbnailUrl: nextMetadata.thumbnailUrl,
  };
}

module.exports = {
  ...pdfMediaCore,
  ensureReaderPdfManifest,
  existingPdfPreviewPageSet,
  fallbackThumbnailBuffer,
  findPdfInfoBinary,
  findPdfToPpmBinary,
  generateReaderDocumentThumbnail,
  maybePrewarmLargeReaderPdf,
  normalizeThumbnailBuffer,
  prepareReaderPdfForFastOpen,
  pdfThumbnailBuffer,
  readOptionalReaderPdfManifest,
  renderReaderPdfPagePreview,
  scheduleReaderPdfPreviewBackfillFromList,
  scheduleReaderPdfPreviewPrebuild,
  quickLookThumbnailBuffer,
  recognizeReaderScreenshot: ocr.recognizeReaderScreenshot,
  writeReaderPdfManifest,
};
