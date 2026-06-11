import test from "node:test";
import assert from "node:assert/strict";
import {
  pdfProgressRestoreTarget,
  shouldSuppressPdfProgressDuringRestore,
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
