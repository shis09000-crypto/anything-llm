const {
  READER_WORKER_EVENTS,
  READER_WORKER_INTENTS,
  READER_WORKER_TASKS,
  readerWorkerEvent,
  readerWorkerPriorityForIntent,
  readerWorkerTaskDescriptor,
} = require("../../utils/readerWorker/contract");

describe("reader worker contract", () => {
  test("user-visible intents map to foreground P0", () => {
    for (const intent of [
      READER_WORKER_INTENTS.OPEN,
      READER_WORKER_INTENTS.UPLOAD,
      READER_WORKER_INTENTS.MANUAL,
    ]) {
      expect(readerWorkerPriorityForIntent(intent)).toEqual({
        priority: "P0",
        policy: "foreground",
        protected: true,
        emergency: true,
      });
    }
  });

  test("maintenance intent maps to background P4", () => {
    expect(
      readerWorkerPriorityForIntent(READER_WORKER_INTENTS.MAINTENANCE)
    ).toEqual({
      priority: "P4",
      policy: "maintenance",
      protected: false,
      emergency: false,
    });
  });

  test("task descriptor is stable and deduped per document task", () => {
    expect(
      readerWorkerTaskDescriptor({
        task: READER_WORKER_TASKS.PREVIEW,
        intent: READER_WORKER_INTENTS.UPLOAD,
        userId: 7,
        workspaceSlug: "workspace-a",
        readerDocumentId: "doc-1",
        requestId: "req-1",
      })
    ).toMatchObject({
      kind: "reader-worker",
      task: "preview",
      intent: "upload",
      userId: 7,
      workspaceSlug: "workspace-a",
      readerDocumentId: "doc-1",
      requestId: "req-1",
      priority: "P0",
      policy: "foreground",
      protected: true,
      emergency: true,
      dedupeKey: "reader-worker:workspace-a:doc-1:preview",
    });
  });

  test("reader worker events remain small broadcast events", () => {
    expect(
      readerWorkerEvent({
        type: READER_WORKER_EVENTS.PREVIEW_READY,
        workspaceSlug: "workspace-a",
        readerDocumentId: "doc-1",
        payload: { previewReady: true },
      })
    ).toEqual({
      namespace: "reader",
      type: "reader.preview.ready",
      eventPriority: "background",
      visibility: "reader",
      scope: { workspaceSlug: "workspace-a" },
      resource: { kind: "reader-document", id: "doc-1" },
      coalesceKey: "reader:reader.preview.ready:workspace-a:doc-1",
      payload: { previewReady: true },
    });
  });

  test("invalid descriptors fail closed", () => {
    expect(() =>
      readerWorkerTaskDescriptor({
        task: "unknown",
        readerDocumentId: "doc-1",
      })
    ).toThrow("Unsupported reader worker task");
    expect(() =>
      readerWorkerTaskDescriptor({ task: READER_WORKER_TASKS.PREVIEW })
    ).toThrow("readerDocumentId is required");
    expect(() =>
      readerWorkerEvent({
        type: "reader.full-content",
        readerDocumentId: "doc-1",
      })
    ).toThrow("Unsupported reader worker event");
  });
});
