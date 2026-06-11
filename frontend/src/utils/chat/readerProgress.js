export function readerProgressTimestamp(progress = null) {
  const time = new Date(progress?.updatedAt || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function readerProgressHasPosition(progress = null) {
  const percent = Number(progress?.percent || 0);
  const scrollRatio =
    progress?.scrollRatio === undefined || progress?.scrollRatio === null
      ? 0
      : Number(progress.scrollRatio) || 0;
  const scrollTop =
    progress?.scrollTop === undefined || progress?.scrollTop === null
      ? 0
      : Number(progress.scrollTop) || 0;
  const locator = progress?.locator || {};
  const locatorPage = Number(locator.page || 0);
  const locatorOffset = Number(locator.pageOffsetRatio || 0);
  return (
    percent > 0.5 ||
    scrollRatio > 0.005 ||
    scrollTop > 4 ||
    locatorPage > 1 ||
    locatorOffset > 0.01 ||
    !!locator.cfi ||
    !!locator.cfiRange
  );
}

export function shouldUseReaderProgressBackup(
  itemProgress = null,
  backupProgress = null
) {
  if (!backupProgress) return false;
  const backupTime = readerProgressTimestamp(backupProgress);
  const itemTime = readerProgressTimestamp(itemProgress);
  if (backupTime && (!itemTime || backupTime > itemTime)) return true;
  if (!itemTime && !backupTime) {
    return (
      readerProgressHasPosition(backupProgress) &&
      !readerProgressHasPosition(itemProgress)
    );
  }
  return false;
}

export function pdfProgressRestoreTarget(progress = null) {
  if (!progress) return null;
  const locator = progress.locator || {};
  const page = Number(locator.page || 0);
  const pageOffsetRatio = Math.max(
    0,
    Math.min(1, Number(locator.pageOffsetRatio || 0))
  );
  const scrollRatio =
    progress.scrollRatio === undefined || progress.scrollRatio === null
      ? null
      : Math.max(0, Math.min(1, Number(progress.scrollRatio) || 0));
  const percentRatio = Math.max(
    0,
    Math.min(1, Number(progress.percent || 0) / 100)
  );
  const ratio = scrollRatio !== null ? scrollRatio : percentRatio || null;
  if (!page && !ratio) return null;
  return { page, pageOffsetRatio, ratio };
}

export function pdfProgressRestoreKey(document = {}, progress = null) {
  const target = pdfProgressRestoreTarget(progress);
  const stableId =
    document?.readerDocumentId ||
    document?.backupReaderDocumentId ||
    document?.workspaceDocPath ||
    document?.localDocumentId ||
    document?.title ||
    "unknown";
  return [
    stableId,
    target?.page || 0,
    target?.pageOffsetRatio?.toFixed?.(4) || "0",
    target?.ratio?.toFixed?.(4) || "0",
    progress?.updatedAt || "",
  ].join(":");
}

function isStartishPdfProgress(progress = null) {
  const locator = progress?.locator || {};
  const page = Number(locator.page || 0);
  const offset = Number(locator.pageOffsetRatio || 0);
  const percent = Number(progress?.percent || 0);
  const ratio =
    progress?.scrollRatio === undefined || progress?.scrollRatio === null
      ? percent / 100
      : Number(progress.scrollRatio) || 0;
  const scrollTop =
    progress?.scrollTop === undefined || progress?.scrollTop === null
      ? 0
      : Number(progress.scrollTop) || 0;
  return (
    (!page || page <= 1) &&
    offset <= 0.03 &&
    percent <= 1 &&
    ratio <= 0.01 &&
    scrollTop <= 8
  );
}

export function shouldSuppressPdfProgressDuringRestore(
  progress = null,
  restoreState = {}
) {
  if (!progress || !restoreState?.active) return false;
  if (restoreState.userInteracted) return false;
  const target =
    restoreState.target ||
    pdfProgressRestoreTarget(restoreState.targetProgress);
  if (!target) return false;
  if (!readerProgressHasPosition(restoreState.targetProgress)) return false;
  if (!isStartishPdfProgress(progress)) return false;
  return (
    target.page > 1 ||
    Number(target.pageOffsetRatio || 0) > 0.03 ||
    Number(target.ratio || 0) > 0.01
  );
}
