const fs = require("fs");
const PQueue = require("p-queue").default;
const { atomicWriteJsonFile, safeReadJsonFile } = require("../../utils/safety");
const { publishBroadcastEvent } = require("../../utils/broadcast");
const { DataAccessCenter } = require("../../utils/dataAccess/dataAccessCenter");
const {
  READER_WORKER_INTENTS,
  READER_WORKER_TASKS,
  readerWorkerTaskDescriptor,
} = require("../../utils/readerWorker/contract");
const classificationPipeline = require("./classificationPipeline");
const documentsCore = require("./documentsCore");
const ingestCore = require("./ingestCore");
const pdfMedia = require("./pdfMedia");
const postprocessCore = require("./postprocessCore");
const previewPipeline = require("./previewPipeline");
const readerLinks = require("./readerLinks");

const SCHEMA_VERSION = 1;
const READER_POSTPROCESS_AUTO_POLL_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.READER_POSTPROCESS_AUTO_POLL_TIMEOUT_MS) || 45_000
);
const READER_POSTPROCESS_QUEUE_CONCURRENCY = Math.max(
  1,
  Number(process.env.READER_POSTPROCESS_QUEUE_CONCURRENCY) || 1
);

const readerPostprocessJobs = new Map();
const readerPostprocessCancelRequests = new Set();
const readerPostprocessQueue = new PQueue({
  concurrency: READER_POSTPROCESS_QUEUE_CONCURRENCY,
});

function isoNow() {
  return new Date().toISOString();
}

function readerPostprocessKey(workspace, readerDocumentId) {
  return postprocessCore.readerPostprocessKey(
    workspace?.readerStorageSegment
      ? workspace
      : {
          ...workspace,
          slug: documentsCore.safeSegment(workspace?.slug, "workspace slug"),
        },
    readerDocumentId,
    documentsCore.assertReaderDocumentId
  );
}

function readerPostprocessWasCancelled(workspace, readerDocumentId) {
  return readerPostprocessCancelRequests.has(
    readerPostprocessKey(workspace, readerDocumentId)
  );
}

function readReaderPostprocessStatus(documentRoot, readerDocumentId) {
  return postprocessCore.readReaderPostprocessStatus({
    fs,
    safeReadJsonFile,
    documentRoot,
    readerDocumentId,
    schemaVersion: SCHEMA_VERSION,
  });
}

function writeReaderPostprocessStatus(documentRoot, status) {
  return postprocessCore.writeReaderPostprocessStatus({
    atomicWriteJsonFile,
    documentRoot,
    status,
  });
}

function updateReaderPostprocessStatus(
  documentRoot,
  readerDocumentId,
  updater
) {
  return postprocessCore.updateReaderPostprocessStatus({
    readStatus: readReaderPostprocessStatus,
    writeStatus: writeReaderPostprocessStatus,
    documentRoot,
    readerDocumentId,
    updater,
  });
}

function sanitizedPostprocessTasks(tasks = []) {
  return classificationPipeline.sanitizedPostprocessTasks(tasks);
}

function readerAutoClassificationEnabled(env = process.env) {
  return String(env.READER_AUTO_CLASSIFICATION_ENABLED || "true") !== "false";
}

function taskIsComplete(task = null) {
  return ["complete", "skipped"].includes(task?.status);
}

function postprocessTasksComplete(status = {}, tasks = []) {
  if (!tasks.length) return true;
  return tasks.every((task) => taskIsComplete(status.tasks?.[task]));
}

function ensurePdfPreview({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
  fingerprint,
}) {
  return previewPipeline.ensurePdfPreview({
    workspace,
    readerDocumentId,
    metadata,
    originalPath,
    fingerprint,
    previewUrlForDocument: readerLinks.previewUrlForDocument,
  });
}

function publishReaderBroadcastEvent({
  workspace,
  userId = null,
  readerDocumentId,
  type,
  eventPriority = "normal",
  payload = {},
} = {}) {
  if (!readerDocumentId || !type) return null;
  const workspaceSlug =
    workspace?.slug === documentsCore.STANDALONE_READER_SCOPE.slug
      ? null
      : workspace?.slug;
  return publishBroadcastEvent({
    namespace: "reader",
    type,
    eventPriority,
    visibility: "reader",
    scope: {
      ...(userId ? { userId: Number(userId) } : {}),
      ...(workspaceSlug ? { workspaceSlug } : {}),
      readerDocumentId,
    },
    resource: {
      kind: "reader-document",
      id: readerDocumentId,
    },
    payload: {
      ...(workspaceSlug ? { workspaceSlug } : {}),
      readerDocumentId,
      ...payload,
    },
  });
}

async function runReaderPostprocessJob({
  workspace,
  readerDocumentId,
  tasks,
  categories,
  userId = null,
}) {
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  if (!fs.existsSync(documentRoot)) return;
  if (documentsCore.readerDocumentIsDeleted(documentRoot)) return;
  updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) => ({
    ...status,
    status: "processing",
    startedAt: status.startedAt || isoNow(),
    completedAt: null,
  }));

  let { content, metadata } = documentsCore.readReaderContentAndMetadata(
    documentRoot,
    {
      readerDocumentId,
      phase: "postprocess",
    }
  );
  const originalPath = await documentsCore.originalPathForReaderDocument({
    documentRoot,
    metadata,
  });

  if (readerPostprocessWasCancelled(workspace, readerDocumentId)) {
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) => ({
      ...status,
      status: "cancelled",
      completedAt: isoNow(),
    }));
    return;
  }

  if (tasks.includes("preview")) {
    if (readerPostprocessWasCancelled(workspace, readerDocumentId)) return;
    const needsPdfPreview = previewPipeline.metadataNeedsPdfPreview(metadata);
    const previewLabel = previewPipeline.previewDocumentLabel(metadata);
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
      postprocessCore.postprocessTaskPatch(status, "preview", {
        status: needsPdfPreview ? "processing" : "skipped",
        reason: needsPdfPreview
          ? `正在生成 ${previewLabel} 版式预览`
          : "该文档无需生成版式预览。",
      })
    );
    if (needsPdfPreview) {
      try {
        if (!originalPath) throw new Error(`${previewLabel} 原始文件不可用。`);
        const fingerprint =
          metadata.originalFingerprint ||
          ingestCore.fingerprintForBuffer(fs.readFileSync(originalPath));
        const finalMetadata = await ensurePdfPreview({
          workspace,
          readerDocumentId,
          metadata,
          originalPath,
          fingerprint,
        });
        metadata = finalMetadata;
        documentsCore.writeReaderJsonFile(
          documentRoot,
          "metadata.json",
          finalMetadata
        );
        updateReaderPostprocessStatus(
          documentRoot,
          readerDocumentId,
          (status) =>
            postprocessCore.postprocessTaskPatch(status, "preview", {
              status: finalMetadata.previewPdfUrl ? "complete" : "failed",
              reason: finalMetadata.previewPdfUrl
                ? ""
                : finalMetadata.previewLastError ||
                  finalMetadata.previewWarning ||
                  `${previewLabel} 版式预览生成失败。`,
              result: finalMetadata.previewPdfUrl
                ? {
                    previewPdfName: finalMetadata.previewPdfName,
                    previewGeneratedAt:
                      finalMetadata.previewGeneratedAt || null,
                    previewSource: finalMetadata.previewSource || null,
                    previewEngineVersion:
                      finalMetadata.previewEngineVersion || null,
                  }
                : null,
            })
        );
        publishReaderBroadcastEvent({
          workspace,
          userId: userId || metadata?.ownerUserId,
          readerDocumentId,
          type: finalMetadata.previewPdfUrl
            ? "preview.ready"
            : "preview.failed",
          eventPriority: finalMetadata.previewPdfUrl ? "normal" : "background",
          payload: finalMetadata.previewPdfUrl
            ? {
                previewReady: true,
                previewGeneratedAt:
                  finalMetadata.previewGeneratedAt || isoNow(),
              }
            : {
                previewReady: false,
                reason:
                  finalMetadata.previewLastError ||
                  finalMetadata.previewWarning ||
                  `${previewLabel} 版式预览生成失败。`,
              },
        });
      } catch (error) {
        updateReaderPostprocessStatus(
          documentRoot,
          readerDocumentId,
          (status) =>
            postprocessCore.postprocessTaskPatch(status, "preview", {
              status: "failed",
              reason: error.message || `${previewLabel} 版式预览生成失败。`,
            })
        );
        publishReaderBroadcastEvent({
          workspace,
          userId: userId || metadata?.ownerUserId,
          readerDocumentId,
          type: "preview.failed",
          eventPriority: "background",
          payload: {
            previewReady: false,
            reason: error.message || `${previewLabel} 版式预览生成失败。`,
          },
        });
      }
    }
  }

  if (tasks.includes("pdfManifest")) {
    if (readerPostprocessWasCancelled(workspace, readerDocumentId)) return;
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
      postprocessCore.postprocessTaskPatch(status, "pdfManifest", {
        status: "processing",
        reason: "正在建立 PDF 页面索引",
      })
    );
    try {
      const manifest = originalPath
        ? await pdfMedia.prepareReaderPdfForFastOpen({
            workspace,
            readerDocumentId,
            metadata,
            originalPath,
            prewarmPage: 1,
          })
        : null;
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessCore.postprocessTaskPatch(status, "pdfManifest", {
          status: manifest ? "complete" : "skipped",
          reason: manifest ? "" : "非 PDF 或原文件不可用。",
          result: manifest,
        })
      );
    } catch (error) {
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessCore.postprocessTaskPatch(status, "pdfManifest", {
          status: "failed",
          reason: error.message || "PDF 页面索引建立失败。",
        })
      );
    }
  }

  if (tasks.includes("thumbnail")) {
    if (readerPostprocessWasCancelled(workspace, readerDocumentId)) return;
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
      postprocessCore.postprocessTaskPatch(status, "thumbnail", {
        status: "processing",
        reason: "正在生成封面",
      })
    );
    try {
      const thumbnail = originalPath
        ? await pdfMedia.generateReaderDocumentThumbnail({
            workspace,
            readerDocumentId,
            content,
            metadata,
            originalPath,
          })
        : null;
      if (thumbnail?.metadata) metadata = thumbnail.metadata;
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessCore.postprocessTaskPatch(status, "thumbnail", {
          status: thumbnail?.thumbnailUrl ? "complete" : "failed",
          reason: thumbnail?.thumbnailUrl ? "" : "缩略图生成失败。",
          generatedAt: thumbnail?.metadata?.thumbnailGeneratedAt || null,
        })
      );
      if (thumbnail?.thumbnailUrl) {
        publishReaderBroadcastEvent({
          workspace,
          userId: userId || metadata?.ownerUserId,
          readerDocumentId,
          type: "thumbnail.ready",
          eventPriority: "background",
          payload: {
            thumbnailReady: true,
            thumbnailGeneratedAt:
              thumbnail?.metadata?.thumbnailGeneratedAt || isoNow(),
          },
        });
      }
    } catch {
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessCore.postprocessTaskPatch(status, "thumbnail", {
          status: "failed",
          reason: "缩略图生成失败。",
        })
      );
    }
  }

  if (tasks.includes("classification")) {
    if (readerPostprocessWasCancelled(workspace, readerDocumentId)) return;
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
      postprocessCore.postprocessTaskPatch(status, "classification", {
        status: "extracting",
        reason: "正在提取分类文本",
      })
    );
    try {
      let result = null;
      if (originalPath) {
        const text =
          await classificationPipeline.extractReaderClassificationText({
            documentType: content.documentType,
            originalPath,
          });
        const samplePayload =
          classificationPipeline.buildReaderClassificationSamples(text);
        if (!samplePayload.ok) {
          result = classificationPipeline.unknownClassificationCategory(
            classificationPipeline.sanitizedClassificationCategories(
              categories
            ),
            samplePayload.reason
          );
        } else {
          updateReaderPostprocessStatus(
            documentRoot,
            readerDocumentId,
            (status) =>
              postprocessCore.postprocessTaskPatch(status, "classification", {
                status: "classifying",
                reason: "正在自动分类",
              })
          );
          result =
            await classificationPipeline.classifyReaderDocumentWithDeepSeek({
              title: metadata.originalName,
              documentType: content.documentType,
              categories,
              ...samplePayload,
            });
        }
      } else {
        result = classificationPipeline.unknownClassificationCategory(
          classificationPipeline.sanitizedClassificationCategories(categories),
          "读取不到可用于分类的正文。"
        );
      }
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessCore.postprocessTaskPatch(status, "classification", {
          status: "complete",
          reason: result.reason || result.categoryReason || "",
          result,
        })
      );
      publishReaderBroadcastEvent({
        workspace,
        userId: userId || metadata?.ownerUserId,
        readerDocumentId,
        type: "classification.ready",
        eventPriority: "background",
        payload: {
          classificationReady: true,
          categoryId: result.categoryId || result.primaryCategoryId || null,
          categoryName:
            result.categoryName || result.primaryCategoryName || null,
          source: result.source || null,
        },
      });
    } catch {
      const result = classificationPipeline.unknownClassificationCategory(
        classificationPipeline.sanitizedClassificationCategories(categories),
        classificationPipeline.safeClassificationReason("failed")
      );
      updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
        postprocessCore.postprocessTaskPatch(status, "classification", {
          status: "complete",
          reason: result.reason || result.categoryReason || "",
          result,
        })
      );
      publishReaderBroadcastEvent({
        workspace,
        userId: userId || metadata?.ownerUserId,
        readerDocumentId,
        type: "classification.ready",
        eventPriority: "background",
        payload: {
          classificationReady: true,
          categoryId: result.categoryId || result.primaryCategoryId || null,
          categoryName:
            result.categoryName || result.primaryCategoryName || null,
          source: result.source || "fallback",
        },
      });
    }
  }

  updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) => ({
    ...status,
    status: "complete",
    completedAt: isoNow(),
  }));
  publishReaderBroadcastEvent({
    workspace,
    userId: userId || metadata?.ownerUserId,
    readerDocumentId,
    type: "postprocess.completed",
    eventPriority: "normal",
    payload: {
      requestedTasks: tasks,
      completedAt: isoNow(),
    },
  });
}

function readerWorkerQueueEnabled() {
  return String(process.env.ATHENA_READER_WORKER_QUEUE || "false") === "true";
}

function readerWorkspaceSlugForWorker(workspace) {
  return workspace?.slug === documentsCore.STANDALONE_READER_SCOPE.slug
    ? null
    : workspace?.slug || null;
}

function durableReaderPostprocessJobId({
  workspace,
  readerDocumentId,
  tasks = [],
}) {
  return [
    "reader-postprocess",
    readerWorkspaceSlugForWorker(workspace) || "standalone",
    readerDocumentId,
    [...tasks].sort().join("+"),
  ].join(":");
}

function scheduleInMemoryReaderPostprocessJob({
  key,
  workspace,
  readerDocumentId,
  tasks,
  categories,
  userId,
}) {
  const job = readerPostprocessQueue
    .add(() =>
      runReaderPostprocessJob({
        workspace,
        readerDocumentId,
        tasks,
        categories,
        userId,
      })
    )
    .catch(() => null)
    .finally(() => {
      readerPostprocessJobs.delete(key);
      readerPostprocessCancelRequests.delete(key);
    });
  readerPostprocessJobs.set(key, job);
}

async function enqueueDurableReaderPostprocessJob({
  workspace,
  readerDocumentId,
  tasks,
  categories,
  userId,
  intent,
  queuedStatus,
}) {
  const descriptor = readerWorkerTaskDescriptor({
    task: READER_WORKER_TASKS.POSTPROCESS,
    intent,
    userId,
    workspaceSlug: readerWorkspaceSlugForWorker(workspace),
    readerDocumentId,
    source: "reader-postprocess",
  });
  const job = await DataAccessCenter.readerWorkerJob.enqueue({
    jobId: durableReaderPostprocessJobId({
      workspace,
      readerDocumentId,
      tasks,
    }),
    task: READER_WORKER_TASKS.POSTPROCESS,
    priority: descriptor.priority,
    intent,
    userId,
    workspaceSlug: descriptor.workspaceSlug,
    readerDocumentId,
    payload: {
      tasks,
      categories,
      userId,
      taskMetadata: descriptor,
    },
  });
  if (!job) {
    const error = new Error("Reader worker durable queue enqueue failed.");
    error.code = "READER_WORKER_ENQUEUE_FAILED";
    throw error;
  }
  return {
    ...queuedStatus,
    durableQueue: {
      mode: "reader-worker",
      jobId: job.jobId,
      status: job.status,
      priority: job.priority,
      intent: job.intent,
    },
  };
}

function enqueueReaderPostprocessJob({
  workspace,
  readerDocumentId,
  tasks,
  categories,
  force = false,
  userId = null,
  intent = READER_WORKER_INTENTS.MAINTENANCE,
}) {
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  const originalTasks = sanitizedPostprocessTasks(tasks);
  const autoClassificationDisabled =
    originalTasks.includes("classification") &&
    !force &&
    !readerAutoClassificationEnabled();
  const requestedTasks = autoClassificationDisabled
    ? originalTasks.filter((task) => task !== "classification")
    : originalTasks;
  if (autoClassificationDisabled) {
    updateReaderPostprocessStatus(documentRoot, readerDocumentId, (status) =>
      postprocessCore.postprocessTaskPatch(status, "classification", {
        status: "skipped",
        reason: "自动分类已关闭。",
      })
    );
  }
  if (!requestedTasks.length) {
    return readReaderPostprocessStatus(documentRoot, readerDocumentId);
  }

  const key = readerPostprocessKey(workspace, readerDocumentId);
  if (readerPostprocessJobs.has(key))
    return readReaderPostprocessStatus(documentRoot, readerDocumentId);

  const currentStatus = readReaderPostprocessStatus(
    documentRoot,
    readerDocumentId
  );
  if (!force && postprocessTasksComplete(currentStatus, requestedTasks))
    return currentStatus;

  const queuedAt = isoNow();
  const queuedStatus = writeReaderPostprocessStatus(documentRoot, {
    ...currentStatus,
    status: "queued",
    requestedTasks,
    queuedAt,
    completedAt: null,
    tasks: requestedTasks.reduce(
      (tasksByName, task) => {
        tasksByName[task] = {
          ...(tasksByName[task] || {}),
          status: "queued",
          reason: "等待后台处理",
          queuedAt,
          updatedAt: queuedAt,
        };
        return tasksByName;
      },
      { ...currentStatus.tasks }
    ),
  });

  if (readerWorkerQueueEnabled()) {
    return enqueueDurableReaderPostprocessJob({
      workspace,
      readerDocumentId,
      tasks: requestedTasks,
      categories,
      userId,
      intent,
      queuedStatus,
    }).catch((error) => {
      console.warn(
        "[ReaderWorker] durable enqueue failed; falling back to in-process queue:",
        error.message
      );
      scheduleInMemoryReaderPostprocessJob({
        key,
        workspace,
        readerDocumentId,
        tasks: requestedTasks,
        categories,
        userId,
      });
      return {
        ...queuedStatus,
        durableQueue: {
          mode: "fallback-in-process",
          error: error.code || "enqueue_failed",
        },
      };
    });
  }

  scheduleInMemoryReaderPostprocessJob({
    key,
    workspace,
    readerDocumentId,
    tasks: requestedTasks,
    categories,
    userId,
  });
  return queuedStatus;
}

function cancelReaderPostprocessJob({ workspace, readerDocumentId }) {
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  const key = readerPostprocessKey(workspace, readerDocumentId);
  readerPostprocessCancelRequests.add(key);
  readerPostprocessJobs.delete(key);
  return updateReaderPostprocessStatus(
    documentRoot,
    readerDocumentId,
    (status) => ({
      ...status,
      status: "cancelled",
      completedAt: isoNow(),
      tasks: Object.fromEntries(
        Object.entries(status.tasks || {}).map(([task, value]) => [
          task,
          ["complete", "skipped"].includes(value?.status)
            ? value
            : {
                ...value,
                status: "cancelled",
                reason: "已由 Developer Control 取消。",
                updatedAt: isoNow(),
              },
        ])
      ),
    })
  );
}

function readerPostprocessResponse(workspace, readerDocumentId) {
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  const status = readReaderPostprocessStatus(documentRoot, readerDocumentId);
  const classification = status.tasks?.classification?.result || null;
  const progress = postprocessCore.readerPostprocessProgress(status);
  let metadata = null;
  try {
    metadata = readerLinks.metadataWithOriginalUrl(
      workspace,
      readerDocumentId,
      documentsCore.readReaderMetadata(documentRoot, {
        readerDocumentId,
        endpoint: "postprocess.response",
      })
    );
  } catch {
    metadata = null;
  }
  return {
    success: true,
    status: status.status,
    postprocess: status,
    progress,
    stage: progress.stage,
    tasks: status.tasks || {},
    postprocessConfig: {
      autoPollTimeoutMs: READER_POSTPROCESS_AUTO_POLL_TIMEOUT_MS,
    },
    thumbnailUrl: readerLinks.existingThumbnailUrlForDocument(
      workspace,
      readerDocumentId
    ),
    classification,
    ...(metadata ? { metadata } : {}),
  };
}

module.exports = {
  ...postprocessCore,
  cancelReaderPostprocessJob,
  enqueueReaderPostprocessJob,
  publishReaderBroadcastEvent,
  readerAutoClassificationEnabled,
  readerPostprocessKey,
  readerPostprocessResponse,
  readReaderPostprocessStatus,
  runReaderPostprocessJob,
  sanitizedPostprocessTasks,
  updateReaderPostprocessStatus,
  writeReaderPostprocessStatus,
};
