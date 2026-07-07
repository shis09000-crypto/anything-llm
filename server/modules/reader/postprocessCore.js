const { safeResolve } = require("./documentsCore");

const READER_POSTPROCESS_STATUS_NAME = "postprocess.json";

function isoNow() {
  return new Date().toISOString();
}

function readerPostprocessKey(workspace, readerDocumentId, assertId) {
  return `${workspace?.readerStorageSegment || workspace?.slug}:${assertId(
    readerDocumentId
  )}`;
}

function defaultReaderPostprocessStatus(readerDocumentId, schemaVersion = 1) {
  return {
    schemaVersion,
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

function readReaderPostprocessStatus({
  fs,
  safeReadJsonFile,
  documentRoot,
  readerDocumentId,
  schemaVersion = 1,
  logger = console,
}) {
  const fallback = defaultReaderPostprocessStatus(
    readerDocumentId,
    schemaVersion
  );
  const statusPath = safeResolve(documentRoot, READER_POSTPROCESS_STATUS_NAME);
  if (!fs.existsSync(statusPath)) return fallback;
  const result = safeReadJsonFile(statusPath, fallback, {
    context: { readerDocumentId, file: READER_POSTPROCESS_STATUS_NAME },
  });
  if (!result.ok) {
    logger.warn("[ReaderPostprocess] status fallback", result.error);
    return fallback;
  }
  const parsed = result.value || {};
  return {
    ...fallback,
    ...parsed,
    tasks: parsed.tasks || {},
    requestedTasks: Array.isArray(parsed.requestedTasks)
      ? parsed.requestedTasks
      : [],
  };
}

function writeReaderPostprocessStatus({
  atomicWriteJsonFile,
  documentRoot,
  status,
  logger = console,
}) {
  const next = {
    ...status,
    updatedAt: isoNow(),
  };
  const result = atomicWriteJsonFile(
    safeResolve(documentRoot, READER_POSTPROCESS_STATUS_NAME),
    next
  );
  if (!result.ok)
    logger.warn("[ReaderPostprocess] status write failed", result.error);
  return next;
}

function updateReaderPostprocessStatus({
  readStatus,
  writeStatus,
  documentRoot,
  readerDocumentId,
  updater,
}) {
  const current = readStatus(documentRoot, readerDocumentId);
  const next =
    typeof updater === "function"
      ? updater(current)
      : { ...current, ...updater };
  return writeStatus(documentRoot, next);
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

module.exports = {
  defaultReaderPostprocessStatus,
  postprocessTaskPatch,
  readerPostprocessKey,
  readerPostprocessProgress,
  readReaderPostprocessStatus,
  updateReaderPostprocessStatus,
  writeReaderPostprocessStatus,
};
