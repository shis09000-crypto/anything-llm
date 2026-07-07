const READER_PDF_MANIFEST_NAME = "pdf-manifest.json";
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

function parsePdfInfoManifest(stdout = "") {
  const pageMatch = String(stdout || "").match(/^Pages:\s*(\d+)/im);
  const titleMatch = String(stdout || "").match(/^Title:\s*(.+)$/im);
  return {
    pageCount: pageMatch ? Number(pageMatch[1]) || null : null,
    title: titleMatch ? titleMatch[1].trim() : null,
  };
}

function pdfManifestMatchesMetadata(
  manifest = null,
  metadata = {},
  schemaVersion = 1
) {
  if (!manifest) return false;
  const size = Number(metadata?.size || 0) || null;
  const fingerprint =
    metadata?.originalFingerprint || metadata?.fingerprint || null;
  return (
    manifest.schemaVersion === schemaVersion &&
    (!size || manifest.size === size) &&
    (!fingerprint || manifest.fingerprint === fingerprint)
  );
}

function readReaderPdfManifest({
  readReaderJsonFile,
  documentRoot,
  readerDocumentId,
}) {
  return readReaderJsonFile(documentRoot, READER_PDF_MANIFEST_NAME, null, {
    readerDocumentId,
    endpoint: "pdf-manifest",
  });
}

function readOptionalReaderPdfManifest({
  readReaderJsonFile,
  documentRoot,
  readerDocumentId,
}) {
  try {
    return readReaderPdfManifest({
      readReaderJsonFile,
      documentRoot,
      readerDocumentId,
    });
  } catch (error) {
    if (error?.code !== "READER_DOCUMENT_JSON_UNAVAILABLE") throw error;
    return null;
  }
}

function buildReaderPdfManifest({
  readerDocumentId,
  metadata,
  manifest,
  schemaVersion = 1,
  now = new Date().toISOString(),
}) {
  return {
    schemaVersion,
    readerDocumentId,
    size: Number(metadata?.size || 0) || null,
    fingerprint: metadata?.originalFingerprint || metadata?.fingerprint || null,
    generatedAt: now,
    ...manifest,
  };
}

function normalizedPdfPageNumber(value, manifest = null) {
  const page = Math.max(1, Math.round(Number(value) || 1));
  const pageCount = Number(manifest?.pageCount || 0);
  return pageCount > 0 ? Math.min(page, pageCount) : page;
}

function pdfPagePreviewName(pageNumber) {
  return `page-preview-${normalizedPdfPageNumber(pageNumber)}.jpg`;
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

module.exports = {
  buildReaderPdfManifest,
  orderedPdfPreviewPrebuildPages,
  orderedPdfPreviewWindowPages,
  parsePdfInfoManifest,
  pdfManifestMatchesMetadata,
  pdfPagePreviewName,
  readOptionalReaderPdfManifest,
  readReaderPdfManifest,
};
