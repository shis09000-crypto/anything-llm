import test from "node:test";
import assert from "node:assert/strict";
import {
  pdfProgressRestoreTarget,
  selectReaderProgress,
  shouldSuppressPdfProgressDuringRestore,
  shouldUseReaderProgressCandidate,
  shouldUseReaderProgressBackup,
} from "./readerProgress.js";

test("shouldUseReaderProgressBackup prefers updated backup when stored progress has no timestamp", () => {
  const storedProgress = {
    percent: 48,
    locator: { page: 128, pageOffsetRatio: 0.32 },
    updatedAt: null,
  };
  const backupProgress = {
    percent: 52,
    locator: { page: 134, pageOffsetRatio: 0.12 },
    updatedAt: "2026-06-10T05:20:00.000Z",
  };

  assert.equal(
    shouldUseReaderProgressBackup(storedProgress, backupProgress),
    true
  );
});

test("shouldSuppressPdfProgressDuringRestore blocks initial top progress for a later-page target", () => {
  const targetProgress = {
    percent: 42,
    scrollRatio: 0.42,
    locator: { page: 88, pageOffsetRatio: 0.18 },
    updatedAt: "2026-06-10T05:20:00.000Z",
  };
  const topProgress = {
    percent: 0,
    scrollRatio: 0,
    scrollTop: 0,
    locator: { page: 1, pageOffsetRatio: 0 },
  };

  assert.equal(
    shouldSuppressPdfProgressDuringRestore(topProgress, {
      active: true,
      targetProgress,
      target: pdfProgressRestoreTarget(targetProgress),
      userInteracted: false,
    }),
    true
  );
});

test("shouldSuppressPdfProgressDuringRestore allows a user-driven return to the first page", () => {
  const targetProgress = {
    percent: 42,
    scrollRatio: 0.42,
    locator: { page: 88, pageOffsetRatio: 0.18 },
  };
  const topProgress = {
    percent: 0,
    scrollRatio: 0,
    scrollTop: 0,
    locator: { page: 1, pageOffsetRatio: 0 },
  };

  assert.equal(
    shouldSuppressPdfProgressDuringRestore(topProgress, {
      active: true,
      targetProgress,
      target: pdfProgressRestoreTarget(targetProgress),
      userInteracted: true,
    }),
    false
  );
});

test("shouldSuppressPdfProgressDuringRestore blocks initial top progress for ratio-only PDF progress", () => {
  const targetProgress = {
    percent: 37,
    scrollRatio: 0.37,
    locator: null,
  };
  const topProgress = {
    percent: 0,
    scrollRatio: 0,
    scrollTop: 0,
    locator: { page: 1, pageOffsetRatio: 0 },
  };

  assert.equal(
    shouldSuppressPdfProgressDuringRestore(topProgress, {
      active: true,
      targetProgress,
      target: pdfProgressRestoreTarget(targetProgress),
      userInteracted: false,
    }),
    true
  );
});

test("shouldUseReaderProgressCandidate rejects untrusted start progress over a meaningful stored position", () => {
  const storedProgress = {
    percent: 62,
    scrollRatio: 0.62,
    locator: { page: 212, pageOffsetRatio: 0.4 },
    updatedAt: "2026-06-10T05:20:00.000Z",
  };
  const startupSnapshot = {
    percent: 0,
    scrollRatio: 0,
    scrollTop: 0,
    locator: { page: 1, pageOffsetRatio: 0 },
    updatedAt: "2026-06-10T05:25:00.000Z",
    source: "reader-snapshot",
  };

  assert.equal(
    shouldUseReaderProgressCandidate(storedProgress, startupSnapshot),
    false
  );
});

test("shouldUseReaderProgressCandidate accepts trusted user return to first page", () => {
  const storedProgress = {
    percent: 62,
    scrollRatio: 0.62,
    locator: { page: 212, pageOffsetRatio: 0.4 },
    updatedAt: "2026-06-10T05:20:00.000Z",
  };
  const userTopProgress = {
    percent: 0,
    scrollRatio: 0,
    scrollTop: 0,
    locator: { page: 1, pageOffsetRatio: 0 },
    updatedAt: "2026-06-10T05:25:00.000Z",
    source: "reader-event",
    trusted: true,
  };

  assert.equal(
    shouldUseReaderProgressCandidate(storedProgress, userTopProgress),
    true
  );
});

test("selectReaderProgress picks the newest credible book-level position", () => {
  const historyProgress = {
    percent: 18,
    scrollRatio: 0.18,
    locator: { page: 40, pageOffsetRatio: 0.1 },
    updatedAt: "2026-06-10T05:10:00.000Z",
  };
  const backupProgress = {
    percent: 44,
    scrollRatio: 0.44,
    locator: { page: 92, pageOffsetRatio: 0.2 },
    updatedAt: "2026-06-10T05:30:00.000Z",
  };
  const staleStartupSnapshot = {
    percent: 0,
    scrollRatio: 0,
    locator: { page: 1, pageOffsetRatio: 0 },
    updatedAt: "2026-06-10T05:35:00.000Z",
  };

  assert.deepEqual(
    selectReaderProgress([
      { progress: historyProgress },
      { progress: backupProgress },
      { progress: staleStartupSnapshot },
    ]),
    backupProgress
  );
});
