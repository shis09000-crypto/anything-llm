const READER_WORKER_TASKS = Object.freeze({
  PREVIEW: "preview",
  THUMBNAIL: "thumbnail",
  CLASSIFICATION: "classification",
  PAGE_PREVIEW: "page-preview",
  PDF_MANIFEST: "pdfManifest",
});

const READER_WORKER_INTENTS = Object.freeze({
  OPEN: "open",
  UPLOAD: "upload",
  MANUAL: "manual",
  MAINTENANCE: "maintenance",
});

const READER_WORKER_PRIORITIES = Object.freeze({
  USER_VISIBLE: {
    priority: "P0",
    policy: "foreground",
    protected: true,
    emergency: true,
  },
  BACKGROUND: {
    priority: "P4",
    policy: "maintenance",
    protected: false,
    emergency: false,
  },
});

const READER_WORKER_EVENTS = Object.freeze({
  PREVIEW_READY: "reader.preview.ready",
  PREVIEW_FAILED: "reader.preview.failed",
  THUMBNAIL_READY: "reader.thumbnail.ready",
  CLASSIFICATION_READY: "reader.classification.ready",
  POSTPROCESS_COMPLETED: "reader.postprocess.completed",
});

function readerWorkerPriorityForIntent(
  intent = READER_WORKER_INTENTS.MAINTENANCE
) {
  return [
    READER_WORKER_INTENTS.OPEN,
    READER_WORKER_INTENTS.UPLOAD,
    READER_WORKER_INTENTS.MANUAL,
  ].includes(intent)
    ? READER_WORKER_PRIORITIES.USER_VISIBLE
    : READER_WORKER_PRIORITIES.BACKGROUND;
}

function readerWorkerTaskDescriptor({
  task,
  intent = READER_WORKER_INTENTS.MAINTENANCE,
  userId = null,
  workspaceSlug = null,
  readerDocumentId,
  requestId = null,
  source = "api",
} = {}) {
  if (!Object.values(READER_WORKER_TASKS).includes(task)) {
    throw new Error(`Unsupported reader worker task: ${task || "unknown"}`);
  }
  if (!readerDocumentId) {
    throw new Error("readerDocumentId is required for reader worker tasks.");
  }

  const priority = readerWorkerPriorityForIntent(intent);
  return {
    kind: "reader-worker",
    task,
    intent,
    userId,
    workspaceSlug,
    readerDocumentId,
    requestId,
    source,
    priority: priority.priority,
    policy: priority.policy,
    protected: priority.protected,
    emergency: priority.emergency,
    dedupeKey: `reader-worker:${workspaceSlug || "standalone"}:${readerDocumentId}:${task}`,
  };
}

function readerWorkerEvent({
  type,
  readerDocumentId,
  workspaceSlug = null,
  payload = {},
} = {}) {
  if (!Object.values(READER_WORKER_EVENTS).includes(type)) {
    throw new Error(`Unsupported reader worker event: ${type || "unknown"}`);
  }
  if (!readerDocumentId) {
    throw new Error("readerDocumentId is required for reader worker events.");
  }

  return {
    namespace: "reader",
    type,
    eventPriority: type.endsWith(".failed") ? "normal" : "background",
    visibility: "reader",
    scope: { workspaceSlug },
    resource: { kind: "reader-document", id: readerDocumentId },
    coalesceKey: `reader:${type}:${workspaceSlug || "standalone"}:${readerDocumentId}`,
    payload,
  };
}

module.exports = {
  READER_WORKER_EVENTS,
  READER_WORKER_INTENTS,
  READER_WORKER_PRIORITIES,
  READER_WORKER_TASKS,
  readerWorkerEvent,
  readerWorkerPriorityForIntent,
  readerWorkerTaskDescriptor,
};
