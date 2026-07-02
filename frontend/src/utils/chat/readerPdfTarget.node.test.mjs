import test from "node:test";
import assert from "node:assert/strict";
import {
  PDF_FAST_STREAM_MAX_BYTES,
  PDF_TARGET_RANGE_CHUNK_SIZE,
  pdfLoadingPolicyForDocument,
  readerProgressFromPdfTargetSource,
  resolvePdfInitialTarget,
} from "./readerPdfTarget.js";

test("resolvePdfInitialTarget prioritizes the clicked jump source", () => {
  const target = resolvePdfInitialTarget({
    document: {
      readerDocumentId: "doc-1",
      initialTargetSource: {
        readerDocumentId: "doc-1",
        locator: { page: 8, pageOffsetRatio: 0.2 },
      },
      progress: { locator: { page: 22 } },
    },
    readerTextSources: [
      {
        readerDocumentId: "doc-1",
        locator: { page: 12, pageOffsetRatio: 0.4 },
      },
    ],
    jumpSource: {
      readerDocumentId: "doc-1",
      locator: { page: 30, pageOffsetRatio: 0.62 },
      sourceKey: "source-30",
    },
  });

  assert.equal(target.page, 30);
  assert.equal(target.pageOffsetRatio, 0.62);
  assert.equal(target.reason, "jump-source");
  assert.equal(target.sourceKey, "source-30");
});

test("resolvePdfInitialTarget uses pending source before stored progress", () => {
  const target = resolvePdfInitialTarget({
    document: {
      readerDocumentId: "doc-1",
      progress: { locator: { page: 22, pageOffsetRatio: 0.1 } },
    },
    readerTextSources: [
      {
        readerDocumentId: "doc-1",
        position: { pageNumber: 9 },
        locator: { pageOffsetRatio: 0.45 },
      },
    ],
  });

  assert.equal(target.page, 9);
  assert.equal(target.pageOffsetRatio, 0.45);
  assert.equal(target.reason, "pending-source");
});

test("resolvePdfInitialTarget falls back to stored progress and then page one", () => {
  const progressTarget = resolvePdfInitialTarget({
    document: {
      progress: { locator: { page: 18, pageOffsetRatio: 0.33 } },
    },
  });
  assert.equal(progressTarget.page, 18);
  assert.equal(progressTarget.pageOffsetRatio, 0.33);
  assert.equal(progressTarget.reason, "progress");

  const fallbackTarget = resolvePdfInitialTarget({ document: {} });
  assert.equal(fallbackTarget.page, 1);
  assert.equal(fallbackTarget.reason, "fallback-page-1");
});

test("readerProgressFromPdfTargetSource creates trusted reader-event progress", () => {
  const progress = readerProgressFromPdfTargetSource(
    {
      locator: { page: 41, pageOffsetRatio: 0.7 },
    },
    { now: "2026-07-02T00:00:00.000Z" }
  );

  assert.deepEqual(progress.locator, { page: 41, pageOffsetRatio: 0.7 });
  assert.equal(progress.source, "reader-event");
  assert.equal(progress.trusted, true);
  assert.equal(progress.updatedAt, "2026-07-02T00:00:00.000Z");
});

test("pdfLoadingPolicyForDocument enables fast stream for normal PDFs", () => {
  const policy = pdfLoadingPolicyForDocument({
    useRangeLoading: true,
    sizeBytes: PDF_FAST_STREAM_MAX_BYTES,
  });

  assert.equal(policy.rangeChunkSize, PDF_TARGET_RANGE_CHUNK_SIZE);
  assert.equal(policy.disableRange, false);
  assert.equal(policy.disableStream, false);
  assert.equal(policy.disableAutoFetch, false);
  assert.equal(policy.mode, "target-fast-stream");
});

test("pdfLoadingPolicyForDocument keeps large PDFs range-only", () => {
  const policy = pdfLoadingPolicyForDocument({
    useRangeLoading: true,
    sizeBytes: PDF_FAST_STREAM_MAX_BYTES + 1,
  });

  assert.equal(policy.rangeChunkSize, PDF_TARGET_RANGE_CHUNK_SIZE);
  assert.equal(policy.disableRange, false);
  assert.equal(policy.disableStream, true);
  assert.equal(policy.disableAutoFetch, true);
  assert.equal(policy.mode, "target-range-only");
});
