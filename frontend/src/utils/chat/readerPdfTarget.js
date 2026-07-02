export const PDF_FAST_STREAM_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_TARGET_RANGE_CHUNK_SIZE = 1024 * 1024;

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.max(1, Math.round(number));
}

function clampRatio(value) {
  if (value === undefined || value === null) return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function finiteRatio(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

function documentIdentitySet(document = {}) {
  return new Set(
    [
      document.readerDocumentId,
      document.backupReaderDocumentId,
      document.localDocumentId,
      document.workspaceDocPath,
    ]
      .filter(Boolean)
      .map(String)
  );
}

function sourceIdentitySet(source = {}) {
  return new Set(
    [
      source.readerDocumentId,
      source.backupReaderDocumentId,
      source.localDocumentId,
      source.workspaceDocPath,
    ]
      .filter(Boolean)
      .map(String)
  );
}

export function readerPdfSourceMatchesDocument(source = null, document = {}) {
  if (!source) return false;
  const sourceIds = sourceIdentitySet(source);
  if (sourceIds.size === 0) return true;
  const documentIds = documentIdentitySet(document);
  if (documentIds.size === 0) return true;
  return [...sourceIds].some((id) => documentIds.has(id));
}

export function pdfTargetFromReaderSource(source = null, reason = "source") {
  if (!source) return null;
  const locator = source.locator || {};
  const page =
    positiveInteger(locator.page) ||
    positiveInteger(source.position?.pageNumber) ||
    positiveInteger(source.screenshotSelection?.pageNumber);
  if (!page) return null;
  return {
    page,
    pageOffsetRatio: clampRatio(locator.pageOffsetRatio),
    ratio: null,
    reason,
    sourceKey: source.sourceKey || null,
  };
}

export function pdfTargetFromProgress(progress = null, reason = "progress") {
  if (!progress) return null;
  const locator = progress.locator || {};
  const page = positiveInteger(locator.page);
  const scrollRatio = finiteRatio(progress.scrollRatio);
  const percentRatio = finiteRatio(Number(progress.percent || 0) / 100);
  const ratio = scrollRatio !== null ? scrollRatio : percentRatio;
  if (!page && ratio === null) return null;
  return {
    page,
    pageOffsetRatio: clampRatio(locator.pageOffsetRatio),
    ratio,
    reason,
    sourceKey: null,
  };
}

export function resolvePdfInitialTarget({
  document = {},
  readerTextSources = [],
  jumpSource = null,
} = {}) {
  const sourceCandidates = [
    { source: jumpSource, reason: "jump-source" },
    { source: document.initialTargetSource, reason: "open-source" },
    ...(readerTextSources || []).map((source, index) => ({
      source,
      reason: index === 0 ? "pending-source" : "queued-source",
    })),
  ];

  for (const candidate of sourceCandidates) {
    if (!readerPdfSourceMatchesDocument(candidate.source, document)) continue;
    const target = pdfTargetFromReaderSource(
      candidate.source,
      candidate.reason
    );
    if (target) return target;
  }

  const progressTarget = pdfTargetFromProgress(document.progress);
  if (progressTarget) return progressTarget;

  return {
    page: 1,
    pageOffsetRatio: 0,
    ratio: null,
    reason: "fallback-page-1",
    sourceKey: null,
  };
}

export function readerProgressFromPdfTargetSource(
  source = null,
  { now = new Date().toISOString() } = {}
) {
  const target = pdfTargetFromReaderSource(source, "reader-event");
  if (!target) return null;
  return {
    label: "阅读定位",
    percent: 0,
    locator: {
      page: target.page,
      pageOffsetRatio: target.pageOffsetRatio,
    },
    scrollRatio: null,
    scrollTop: null,
    updatedAt: now,
    source: "reader-event",
    trusted: true,
  };
}

export function pdfLoadingPolicyForDocument({
  useRangeLoading = false,
  sizeBytes = null,
} = {}) {
  if (!useRangeLoading) {
    return {
      rangeChunkSize: undefined,
      disableRange: undefined,
      disableStream: undefined,
      disableAutoFetch: undefined,
      mode: "default",
    };
  }

  const size = Number(sizeBytes || 0);
  const fastStream = !size || size <= PDF_FAST_STREAM_MAX_BYTES;
  return {
    rangeChunkSize: PDF_TARGET_RANGE_CHUNK_SIZE,
    disableRange: false,
    disableStream: fastStream ? false : true,
    disableAutoFetch: fastStream ? false : true,
    mode: fastStream ? "target-fast-stream" : "target-range-only",
  };
}
