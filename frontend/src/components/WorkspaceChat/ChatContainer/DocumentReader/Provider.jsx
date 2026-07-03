import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReaderDocument from "@/models/readerDocument";
import showToast from "@/utils/toast";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import { AuthContext } from "@/AuthContext";
import { getAuthToken } from "@/utils/authTokenStorage";
import {
  clearDeletedReaderDocumentIdsFromAllStorage,
  compactDocumentForStorage,
  clearReaderHistory as clearStoredReaderHistory,
  deleteReaderHistoryItem as deleteStoredReaderHistoryItem,
  deleteReaderBookshelfItems as deleteStoredReaderBookshelfItems,
  createReaderBookshelfCategory,
  deleteReaderBookshelfCategory,
  deleteReaderProgressBackup,
  fallbackReaderCategory,
  readDeletedReaderDocumentIds,
  hasSignificantProgressChange,
  hydrateReaderLibraryNow,
  manualReaderCategory,
  migrateReaderStorage,
  normalizeBookTitle,
  normalizeReaderCategoryPatch,
  normalizedReaderProgress,
  pendingReaderCategory,
  readerTextSourceKey,
  readReaderBookshelf,
  readReaderBookshelfCategories,
  readReaderCurrentDocument,
  readReaderHistory,
  readReaderSources,
  READER_BOOKSHELF_CATEGORIES_STORAGE_KEY,
  READER_BOOKSHELF_STORAGE_KEY,
  READER_HISTORY_STORAGE_KEY,
  READER_SOURCES_STORAGE_KEY,
  readerItemWithLatestBookMemory,
  rememberDeletedReaderDocumentIds,
  registerReaderBookMemoryAlias,
  readerStorageKey,
  renameReaderBookshelfCategory,
  READER_EVENT_ASSOCIATE_SELECTION,
  READER_EVENT_CONSUME_TEXT_SOURCES,
  READER_EVENT_OPEN_DRAWER,
  READER_EVENT_TURN_COMPLETED,
  tempTextSourceFromSelection,
  updateReaderBookshelfItem,
  updateReaderHistoryItem,
  upsertReaderBookMemory,
  upsertReaderProgressBackup,
  upsertReaderBookshelfItems,
  upsertReaderHistory,
  validateReaderFile,
  writeReaderCurrentDocument,
  writeReaderSources,
} from "./storage";
import {
  parseDocxFile,
  parseEpubFile,
  parseMarkdownFile,
  parsePdfFile,
  parseXlsxFile,
} from "./parsers";
import {
  dedupeReaderTextSources,
  readerTextSourceIdentity,
} from "@/utils/chat/readerTextSources";
import { readerProgressFromPdfTargetSource } from "@/utils/chat/readerPdfTarget";
import {
  readerLibraryItemKey,
  removableBookshelfKeysAfterReaderDelete,
} from "@/utils/chat/readerLibraryPersistence";
import {
  clearReaderCurrentDocumentClearMarker,
  clearReaderCurrentDocumentStorage,
  isReaderCurrentDocumentFresh,
  readReaderCurrentDocumentClearedAt,
  readReaderDrawerState,
  readReaderDrawerOpenIntent,
  setReaderDrawerSection,
  setReaderDrawerOpenIntent,
} from "@/utils/chat/readerDrawerState";
import { readerOpenFailureDetails } from "@/utils/chat/readerOpenFailure";
import {
  deleteReaderLocalSources,
  openReaderLocalSource,
} from "@/utils/chat/readerLocalSources";
import { useWorkspaceLayout } from "@/contexts/WorkspaceLayoutProvider";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { markTaskPerformance } from "@/utils/tasks/taskScheduler";
import {
  nextReaderPostprocessDelay,
  readerPostprocessIsForeground,
  readerPostprocessLockKey,
  readerPostprocessPollTimeoutMs,
  readerPostprocessScheduleOptions,
} from "./postprocessScheduling";

const DocumentReaderContext = createContext(null);
const READER_CLOSE_SUPPRESSION_MS = 1_200;

function readerOpenTask(label, workspaceSlug = null, scope = {}) {
  return {
    label,
    kind: "reader",
    priority: "P0",
    policy: "foreground",
    resource: "network",
    emergency: true,
    intentRank: 0,
    scope: {
      route: "workspace-chat",
      surface: "reader-open",
      workspaceSlug: workspaceSlug || null,
      ...scope,
    },
  };
}

async function parseFileByType(file, readerDocumentId, documentType) {
  if (documentType === "markdown")
    return await parseMarkdownFile(file, readerDocumentId);
  if (documentType === "docx")
    return await parseDocxFile(file, readerDocumentId);
  if (documentType === "xlsx")
    return await parseXlsxFile(file, readerDocumentId);
  if (documentType === "pdf") return await parsePdfFile(file, readerDocumentId);
  if (documentType === "epub")
    return await parseEpubFile(file, readerDocumentId);
  return null;
}

function duplicateUploadPayload(error = {}) {
  const raw = error?.raw || null;
  if (raw?.code !== "READER_DUPLICATE") return null;
  return raw.duplicate || {};
}

async function confirmDuplicateReaderUpload(fileName = "", duplicate = {}) {
  return await showAppConfirm({
    tone: "warning",
    title: "检测到重复书籍",
    description: "这本书的名称和开头内容与书架中的已有书籍一致。",
    body: `已有书籍：${duplicate.title || "未命名书籍"}\n本次上传：${fileName}\n\n继续上传会创建一个带“重复”后缀的新副本。`,
    confirmText: "继续上传",
    cancelText: "取消上传",
  });
}

function readerDocumentTypeFromMetadata(metadata = {}) {
  const explicit =
    metadata?.documentType ||
    metadata?.stream?.documentType ||
    metadata?.contentSummary?.documentType;
  if (explicit) return explicit;

  const mimeType = String(
    metadata?.mimeType || metadata?.stream?.mimeType || ""
  )
    .trim()
    .toLowerCase();
  const filename = String(
    metadata?.storedName ||
      metadata?.originalName ||
      metadata?.localPath ||
      metadata?.previewPdfName ||
      ""
  ).toLowerCase();

  if (mimeType === "application/pdf" || filename.endsWith(".pdf")) return "pdf";
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    filename.endsWith(".docx")
  )
    return "docx";
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    filename.endsWith(".xlsx")
  )
    return "xlsx";
  if (mimeType === "application/epub+zip" || filename.endsWith(".epub"))
    return "epub";
  if (
    mimeType === "text/markdown" ||
    filename.endsWith(".md") ||
    filename.endsWith(".markdown")
  )
    return "markdown";
  return null;
}

function readerDocumentTypeFromData(data = {}, historyItem = null) {
  return (
    data?.content?.documentType ||
    data?.contentSummary?.documentType ||
    readerDocumentTypeFromMetadata(data?.metadata) ||
    historyItem?.documentType ||
    readerDocumentTypeFromMetadata(historyItem?.metadata) ||
    null
  );
}

function readerPdfStreamUrl(metadata = {}) {
  return (
    metadata?.stream?.streamUrl ||
    metadata?.stream?.url ||
    metadata?.originalUrl ||
    null
  );
}

function lightweightPdfContent(readerDocumentId) {
  return {
    schemaVersion: 1,
    readerDocumentId,
    documentType: "pdf",
    pages: [],
    streaming: true,
  };
}

function loadingMessageForDocumentType(documentType) {
  if (documentType === "docx") return "正在生成版式预览";
  if (documentType === "epub") return "正在准备 EPUB 阅读器...";
  return "正在上传并准备阅读...";
}

function uuid() {
  return crypto.randomUUID();
}

function serverReaderDocumentIds(item = {}) {
  return [item.readerDocumentId, item.backupReaderDocumentId].filter(
    (id, index, ids) => id && ids.indexOf(id) === index
  );
}

function hasServerReaderDocument(item = {}) {
  return serverReaderDocumentIds(item).length > 0;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function thumbnailDataUrlFromUrl(thumbnailUrl, options = {}) {
  if (!thumbnailUrl || /^(data:|blob:)/i.test(thumbnailUrl))
    return thumbnailUrl || null;
  try {
    const displayTask = options.profile === "display";
    const { response, blob } = await ReaderDocument.thumbnailBlob(
      thumbnailUrl,
      {
        communicationScene: displayTask
          ? "reader-visible"
          : "reader-maintenance",
        task: {
          label: displayTask
            ? "reader:thumbnail-display"
            : "reader:thumbnail-maintenance",
          kind: "reader-thumbnail",
          priority: displayTask ? "P1" : "P4",
          policy: displayTask ? "visible" : "maintenance",
          resource: displayTask ? "network" : "idle",
          abortable: true,
          scope: {
            route: "reader",
            surface: displayTask
              ? "reader-thumbnail-display"
              : "reader-thumbnail-maintenance",
          },
        },
      }
    );
    if (response.ok && blob?.size > 0) return await blobToDataUrl(blob);
  } catch {}
  return null;
}

export function DocumentReaderProvider({
  workspace,
  threadSlug = null,
  children,
}) {
  const auth = useContext(AuthContext);
  const authToken = auth?.store?.authToken || null;
  const storageKey = readerStorageKey(workspace?.slug, threadSlug);
  const initialDrawerState = readReaderDrawerState();
  const initialStoredDocument = readerItemWithLatestBookMemory(
    readReaderCurrentDocument(null)
  );
  const initialHasFreshDocument = isReaderCurrentDocumentFresh(
    initialStoredDocument,
    readReaderCurrentDocumentClearedAt()
  );
  const [drawerOpen, setDrawerOpen] = useState(
    initialHasFreshDocument || initialDrawerState.open
  );
  const [currentDocument, setCurrentDocument] = useState(null);
  const [, setPendingSelections] = useState([]);
  const [pendingReaderTextSources, setPendingReaderTextSources] = useState([]);
  const [focusedReaderTextSource, setFocusedReaderTextSource] = useState(null);
  const [sourcesByTurn, setSourcesByTurn] = useState({});
  const [readerHistory, setReaderHistory] = useState([]);
  const [readerBookshelf, setReaderBookshelf] = useState([]);
  const [readerCategories, setReaderCategories] = useState([]);
  const [bookshelfUploadQueue, setBookshelfUploadQueue] = useState([]);
  const [drawerInitialSection, setDrawerInitialSection] = useState(
    initialDrawerState.section
  );
  const drawerSectionRef = useRef(initialDrawerState.section);
  const [localFileConflict, setLocalFileConflict] = useState(null);
  const [docxPreviewStatus, setDocxPreviewStatus] = useState(null);
  const objectUrlRef = useRef(null);
  const readerClosingRef = useRef(false);
  const readerCloseSuppressionUntilRef = useRef(0);
  const readerCloseSuppressionTimerRef = useRef(null);
  const postprocessQueueRef = useRef(new Set());
  const uploadAbortControllersRef = useRef(new Map());
  const pendingSelectionsRef = useRef([]);
  const pendingReaderTextSourcesRef = useRef([]);
  const nextCitationNoRef = useRef(1);
  const lastCitedRef = useRef({ signature: "", at: 0 });
  const localFileConflictResolverRef = useRef(null);
  const pendingReaderOpenRef = useRef(null);
  const readerOpenSeqRef = useRef(0);
  const readerOpenAbortRef = useRef(null);
  const readerBookshelfServerSyncSeqRef = useRef(0);
  const readerRouteKeyRef = useRef(
    `${workspace?.slug || ""}:${threadSlug || ""}`
  );
  const workspaceLayout = useWorkspaceLayout();
  const dispatchLayoutEvent = workspaceLayout?.dispatchLayoutEvent;

  useEffect(() => {
    if (currentDocument) {
      dispatchLayoutEvent?.({
        type: "READER_OPENED",
        readerType: "document",
      });
      return;
    }
    if (drawerOpen) {
      dispatchLayoutEvent?.({
        type: "READER_OPENED",
        readerType: initialHasFreshDocument ? "document" : "drawer",
      });
      return;
    }
    dispatchLayoutEvent?.({ type: "READER_CLOSED" });
  }, [
    currentDocument,
    dispatchLayoutEvent,
    drawerOpen,
    initialHasFreshDocument,
  ]);

  const setReaderObjectUrl = useCallback((url = null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = url;
  }, []);

  const readerCloseSuppressed = useCallback(() => {
    return Date.now() < Number(readerCloseSuppressionUntilRef.current || 0);
  }, []);

  const clearReaderCloseSuppression = useCallback(() => {
    window.clearTimeout(readerCloseSuppressionTimerRef.current);
    readerCloseSuppressionTimerRef.current = null;
    readerCloseSuppressionUntilRef.current = 0;
    readerClosingRef.current = false;
  }, []);

  const beginReaderCloseSuppression = useCallback(() => {
    readerClosingRef.current = true;
    pendingReaderOpenRef.current = null;
    readerCloseSuppressionUntilRef.current =
      Date.now() + READER_CLOSE_SUPPRESSION_MS;
    window.clearTimeout(readerCloseSuppressionTimerRef.current);
    readerCloseSuppressionTimerRef.current = window.setTimeout(() => {
      if (!readerCloseSuppressed()) readerClosingRef.current = false;
    }, READER_CLOSE_SUPPRESSION_MS + 50);
  }, [readerCloseSuppressed]);

  const beginReaderOpen = useCallback(() => {
    const seq = readerOpenSeqRef.current + 1;
    readerOpenSeqRef.current = seq;
    readerOpenAbortRef.current?.abort();
    const controller = new AbortController();
    readerOpenAbortRef.current = controller;
    return { seq, signal: controller.signal };
  }, []);

  const readerOpenIsCurrent = useCallback((openContext = null) => {
    if (!openContext) return true;
    return (
      !openContext.signal?.aborted &&
      readerOpenSeqRef.current === openContext.seq
    );
  }, []);

  const abortReaderOpen = useCallback(() => {
    readerOpenSeqRef.current += 1;
    readerOpenAbortRef.current?.abort();
    readerOpenAbortRef.current = null;
    pendingReaderOpenRef.current = null;
  }, []);

  const patchBookshelfUpload = useCallback((id, patch = {}) => {
    if (!id) return;
    setBookshelfUploadQueue((queue) =>
      queue.map((entry) =>
        entry.id === id
          ? { ...entry, ...patch, updatedAt: new Date().toISOString() }
          : entry
      )
    );
  }, []);

  const removeBookshelfUpload = useCallback((id) => {
    uploadAbortControllersRef.current.get(id)?.abort();
    uploadAbortControllersRef.current.delete(id);
    setBookshelfUploadQueue((queue) =>
      queue.filter((entry) => entry.id !== id)
    );
  }, []);

  const setDrawerOpenPersisted = useCallback((open, options = {}) => {
    const nextState = setReaderDrawerOpenIntent(open, {
      section: options.section || drawerSectionRef.current,
    });
    drawerSectionRef.current = nextState.section;
    setDrawerInitialSection(nextState.section);
    setDrawerOpen(nextState.open);
    return nextState;
  }, []);

  const setDrawerSectionPersisted = useCallback(
    (section, options = {}) => {
      const nextState = setReaderDrawerSection(section, {
        open: options.open === undefined ? drawerOpen : options.open,
      });
      drawerSectionRef.current = nextState.section;
      setDrawerInitialSection(nextState.section);
      setDrawerOpen(nextState.open);
      return nextState;
    },
    [drawerOpen]
  );

  const queuePendingReaderOpen = useCallback(
    (pendingOpen, message, options = {}) => {
      pendingReaderOpenRef.current = {
        ...pendingOpen,
        queuedAt: Date.now(),
        lastRetryAt: 0,
      };
      if (options.silentRetry) return;
      showToast(
        `${message || "伴读文档暂时无法打开"}，已保留本地阅读位置，连接恢复后会自动重试。`,
        "warning"
      );
    },
    []
  );

  const clearPendingReaderOpen = useCallback((kind, readerDocumentId) => {
    const pending = pendingReaderOpenRef.current;
    if (!pending) return;
    if (pending.kind !== kind || pending.readerDocumentId !== readerDocumentId)
      return;
    pendingReaderOpenRef.current = null;
  }, []);

  const historyItemFromDocument = useCallback((doc) => {
    if (!doc) return null;
    return {
      source: doc.source,
      title: doc.title,
      bookKey: doc.bookKey || normalizeBookTitle(doc.title),
      branchId: doc.branchId || null,
      branchLabel: doc.branchLabel || null,
      documentType: doc.documentType,
      size: doc.metadata?.size ?? doc.file?.size ?? null,
      readerDocumentId: doc.readerDocumentId || null,
      backupReaderDocumentId: doc.backupReaderDocumentId || null,
      readerDocumentWorkspaceSlug:
        doc.readerDocumentWorkspaceSlug ||
        doc.metadata?.readerDocumentWorkspaceSlug ||
        doc.workspaceSlug ||
        null,
      workspaceDocPath: doc.workspaceDocPath || doc.metadata?.workspaceDocPath,
      localDocumentId: doc.localDocumentId || null,
      localPath: doc.localPath || doc.metadata?.localPath || null,
      localSourceId: doc.localSourceId || doc.metadata?.localSourceId || null,
      localSourceKind:
        doc.localSourceKind || doc.metadata?.localSourceKind || null,
      localFingerprint:
        doc.localFingerprint || doc.metadata?.localFingerprint || null,
      thumbnailDataUrl:
        doc.thumbnailDataUrl ||
        doc.thumbnailUrl ||
        doc.metadata?.thumbnailUrl ||
        doc.metadata?.thumbnailDataUrl ||
        null,
      uploaded: !!(doc.readerDocumentId || doc.backupReaderDocumentId),
      progress: doc.progress || { label: "阅读进度", percent: 0 },
    };
  }, []);

  const bookshelfItemFromDocument = useCallback(
    (doc) => {
      const item = historyItemFromDocument(doc);
      if (!item) return null;
      return {
        ...item,
        readerDocumentWorkspaceSlug:
          doc.readerDocumentWorkspaceSlug ||
          doc.metadata?.readerDocumentWorkspaceSlug ||
          null,
      };
    },
    [historyItemFromDocument]
  );

  const bookshelfItemFromServerData = useCallback((data) => {
    if (!data?.metadata) return null;
    const title = data.metadata.originalName;
    const documentType =
      data.content?.documentType ||
      data.contentSummary?.documentType ||
      readerDocumentTypeFromMetadata(data.metadata);
    if (!documentType) return null;
    return {
      source: data.metadata.source || "reader_upload",
      title,
      bookKey: normalizeBookTitle(title),
      branchId: null,
      branchLabel: null,
      documentType,
      size: data.metadata.size ?? null,
      metadata: {
        ...data.metadata,
        documentType,
      },
      pdfManifest: data.metadata.pdfManifest || null,
      readerDocumentId: data.metadata.readerDocumentId,
      backupReaderDocumentId: data.metadata.readerDocumentId,
      readerDocumentWorkspaceSlug:
        data.metadata.readerDocumentWorkspaceSlug || null,
      thumbnailUrl: data.metadata.thumbnailUrl || null,
      thumbnailDataUrl: data.metadata.thumbnailDataUrl || null,
      uploaded: true,
      category:
        data.postprocess?.tasks?.classification?.result?.category ||
        data.classification?.category ||
        null,
      postprocess: data.postprocess || null,
      addedAt: data.metadata.createdAt || data.metadata.updatedAt || null,
      updatedAt: data.metadata.updatedAt || data.metadata.createdAt || null,
      progress: { label: "阅读进度", percent: 0, updatedAt: null },
    };
  }, []);

  const rememberDocument = useCallback(
    (doc) => {
      const item = historyItemFromDocument(doc);
      if (!item) return;
      registerReaderBookMemoryAlias(item);
      setReaderHistory(upsertReaderHistory(null, null, item));
    },
    [historyItemFromDocument]
  );

  const addItemsToBookshelf = useCallback((items = []) => {
    const next = upsertReaderBookshelfItems(items);
    setReaderBookshelf(next);
    return next;
  }, []);

  const refreshLocalReaderLibraryState = useCallback(() => {
    setSourcesByTurn(readReaderSources({}) || {});
    setReaderHistory(readReaderHistory());
    setReaderBookshelf(readReaderBookshelf());
    setReaderCategories(readReaderBookshelfCategories());
  }, []);

  const syncAllServerBookshelves = useCallback(
    async (signal = null) => {
      if (!(authToken || getAuthToken())) return readReaderBookshelf();
      const syncSeq = ++readerBookshelfServerSyncSeqRef.current;
      const scopes = workspace?.slug ? [null, workspace.slug] : [null];
      const results = await Promise.all(
        scopes.map(async (scope) => {
          try {
            const { response, data } = await ReaderDocument.list(scope, {
              signal,
              task: false,
            });
            if (!response.ok || !data?.success) return [];
            return data.documents || [];
          } catch (error) {
            if (error?.name !== "AbortError") {
              console.warn("[DocumentReader] bookshelf scope sync failed", {
                scope: scope || "standalone",
                error: error.message,
              });
            }
            return [];
          }
        })
      );
      if (
        signal?.aborted ||
        syncSeq !== readerBookshelfServerSyncSeqRef.current
      )
        return readReaderBookshelf();

      const items = results
        .flat()
        .map((documentData) => bookshelfItemFromServerData(documentData))
        .filter(Boolean);
      if (!items.length) return readReaderBookshelf();
      const nextBookshelf = addItemsToBookshelf(items);
      items
        .filter((item) => item.thumbnailUrl && !item.thumbnailDataUrl)
        .forEach((item) => {
          void thumbnailDataUrlFromUrl(item.thumbnailUrl, {
            profile: "display",
          }).then((dataUrl) => {
            if (!dataUrl) return;
            setReaderBookshelf(
              updateReaderBookshelfItem(item, { thumbnailDataUrl: dataUrl })
            );
          });
        });
      return nextBookshelf;
    },
    [
      addItemsToBookshelf,
      authToken,
      bookshelfItemFromServerData,
      workspace?.slug,
    ]
  );

  const refreshReaderLibraryFromPersistentSources = useCallback(
    async (_reason = "refresh", signal = null) => {
      return await requestPriorityQueue.schedule(
        async () => {
          refreshLocalReaderLibraryState();
          try {
            await hydrateReaderLibraryNow();
          } catch {}
          if (signal?.aborted) return readReaderBookshelf();
          refreshLocalReaderLibraryState();
          const bookshelf = await syncAllServerBookshelves(signal);
          if (signal?.aborted) return bookshelf;
          refreshLocalReaderLibraryState();
          return bookshelf;
        },
        {
          priority: "P4",
          label: "reader:library-refresh",
          kind: "reader",
          scope: {
            route: "workspace-chat",
            workspaceSlug: workspace?.slug || null,
            surface: "reader-library",
          },
          policy: "maintenance",
          signal,
          dedupeKey: `reader:library-refresh:${workspace?.slug || "global"}`,
        }
      );
    },
    [refreshLocalReaderLibraryState, syncAllServerBookshelves, workspace?.slug]
  );

  const patchStoredCategoryForItem = useCallback((item, patch = {}) => {
    if (!item) return;
    const nextBookshelf = updateReaderBookshelfItem(item, patch);
    setReaderBookshelf(nextBookshelf);
    const nextHistory = updateReaderHistoryItem(null, null, item, patch);
    setReaderHistory(nextHistory);
  }, []);

  const markItemCategoryPending = useCallback(
    (item, stage = "extracting", reason = "正在提取分类文本") => {
      const patch = pendingReaderCategory(stage, reason);
      patchStoredCategoryForItem(item, patch);
      return patch;
    },
    [patchStoredCategoryForItem]
  );

  const patchHistoryForDocument = useCallback(
    (doc, patch = {}) => {
      if (!doc) return [];
      const item = historyItemFromDocument(doc);
      if (!item) return readReaderHistory();
      const next = updateReaderHistoryItem(null, null, item, patch);
      setReaderHistory(next);
      setReaderBookshelf(updateReaderBookshelfItem(item, patch));
      return next;
    },
    [historyItemFromDocument]
  );

  const backupCurrentDocumentProgress = useCallback(
    (progress = null) => {
      if (!currentDocument || !progress) return null;
      const item = historyItemFromDocument(currentDocument);
      if (!item) return null;
      upsertReaderBookMemory(item, progress, {
        source: progress.source,
        trustStartPosition: progress.trusted === true,
      });
      return upsertReaderProgressBackup(item, progress);
    },
    [currentDocument, historyItemFromDocument]
  );

  const patchStoredThumbnailForItem = useCallback((item, thumbnailSrc) => {
    if (!item || !thumbnailSrc) return;
    setReaderBookshelf(
      updateReaderBookshelfItem(item, { thumbnailDataUrl: thumbnailSrc })
    );
    const nextHistory = updateReaderHistoryItem(null, null, item, {
      thumbnailDataUrl: thumbnailSrc,
    });
    setReaderHistory(nextHistory);
  }, []);

  const thumbnailSrcForStorage = useCallback(async (thumbnailSrc) => {
    return await thumbnailDataUrlFromUrl(thumbnailSrc, {
      profile: "maintenance",
    });
  }, []);

  const applyPostprocessResult = useCallback(
    async (item, data = {}, options = {}) => {
      if (!item || !data?.success) return false;
      const key = item.key || `${item.bookKey}:main`;
      let latest = readReaderBookshelf().find((book) => book.key === key);
      if (!latest) return false;

      const thumbnailSrc = data.thumbnailUrl || data.thumbnailDataUrl || null;
      if (thumbnailSrc) {
        const storageThumbnailSrc = await thumbnailSrcForStorage(thumbnailSrc);
        if (storageThumbnailSrc)
          patchStoredThumbnailForItem(latest, storageThumbnailSrc);
        latest = readReaderBookshelf().find((book) => book.key === key);
        if (!latest) return false;
      }

      const classification =
        data.classification || data.tasks?.classification?.result || null;
      if (classification) {
        if (latest.category?.source === "manual") return true;
        patchStoredCategoryForItem(
          latest,
          normalizeReaderCategoryPatch(classification)
        );
        return true;
      }

      const classificationTask = data.tasks?.classification;
      if (
        options.trackClassification &&
        ["queued", "extracting", "classifying"].includes(
          classificationTask?.status
        ) &&
        latest.category?.source !== "manual"
      ) {
        markItemCategoryPending(
          latest,
          classificationTask.status === "queued"
            ? "extracting"
            : classificationTask.status,
          classificationTask.reason || "正在自动分类"
        );
      }
      return true;
    },
    [
      markItemCategoryPending,
      normalizeReaderCategoryPatch,
      patchStoredCategoryForItem,
      patchStoredThumbnailForItem,
      thumbnailSrcForStorage,
    ]
  );

  const queueBookshelfPostprocess = useCallback(
    async ({
      item,
      tasks = ["thumbnail", "classification"],
      uploadEntryId = null,
      intent = "maintenance",
    }) => {
      if (!item) return;
      const readerDocumentId =
        item.readerDocumentId || item.backupReaderDocumentId || null;
      if (!readerDocumentId) return;
      const requestedTasks =
        item.documentType === "pdf"
          ? [...new Set([...(tasks || []), "pdfManifest"])]
          : tasks;
      const readerDocumentWorkspaceSlug =
        item.readerDocumentWorkspaceSlug || item.workspaceSlug || null;
      const workspaceSlugForTask =
        readerDocumentWorkspaceSlug || workspace?.slug || null;
      const scheduleOptions = readerPostprocessScheduleOptions({
        intent,
        workspaceSlug: workspaceSlugForTask,
        readerDocumentId,
      });
      const key = readerPostprocessLockKey({
        workspaceSlug: workspaceSlugForTask,
        readerDocumentId,
      });
      if (postprocessQueueRef.current.has(key)) return;
      postprocessQueueRef.current.add(key);
      if (uploadEntryId) {
        patchBookshelfUpload(uploadEntryId, {
          status: "postprocessing",
          stage: "postprocessing",
          percent: 100,
          speedBps: 0,
        });
      }
      return await requestPriorityQueue.schedule(
        async ({ signal }) => {
          try {
            const bookshelfKey = item.key || `${item.bookKey}:main`;
            const foreground = readerPostprocessIsForeground(intent);
            const categoryTasks = requestedTasks.includes("classification");
            const keepClassificationPending = (
              reason = "后台自动分类仍在处理中"
            ) => {
              const latest = readReaderBookshelf().find(
                (book) => book.key === bookshelfKey
              );
              if (!latest || latest.category?.source === "manual") return;
              markItemCategoryPending(latest, "queued", reason);
            };
            const failClassification = (reason) => {
              const latest = readReaderBookshelf().find(
                (book) => book.key === bookshelfKey
              );
              if (!latest || latest.category?.source === "manual") return;
              if (!foreground) {
                keepClassificationPending("后台自动分类仍在处理中");
                return;
              }
              patchStoredCategoryForItem(
                latest,
                fallbackReaderCategory(reason)
              );
            };
            const current = readReaderBookshelf().find(
              (book) => book.key === bookshelfKey
            );
            if (!current) return;
            if (categoryTasks && current.category?.source !== "manual")
              markItemCategoryPending(
                current,
                "extracting",
                foreground ? "正在重新自动分类" : "等待后台自动分类"
              );

            const categories = readReaderBookshelfCategories().map(
              (category) => ({
                id: category.id,
                name: category.name,
              })
            );
            const { response, data } = await ReaderDocument.postprocess(
              readerDocumentWorkspaceSlug,
              readerDocumentId,
              {
                tasks: requestedTasks,
                categories,
                intent,
                force: foreground,
              },
              {
                signal,
                communicationScene: foreground
                  ? "reader-visible"
                  : "reader-maintenance",
                task: false,
              }
            );
            if (signal.aborted) return;
            if (!response.ok) {
              if (categoryTasks) failClassification("后台分类启动失败。");
              return;
            }

            const startedAt = Date.now();
            const pollTimeoutMs = readerPostprocessPollTimeoutMs({
              foreground,
              serverTimeoutMs: data?.postprocessConfig?.autoPollTimeoutMs,
            });
            let delayMs = foreground ? 700 : 1_200;
            let completed = false;
            while (!signal.aborted && Date.now() - startedAt < pollTimeoutMs) {
              await new Promise((resolve) =>
                window.setTimeout(resolve, delayMs)
              );
              if (signal.aborted) break;
              const { response: statusResponse, data } =
                await ReaderDocument.postprocessStatus(
                  readerDocumentWorkspaceSlug,
                  readerDocumentId,
                  {
                    signal,
                    communicationScene: foreground
                      ? "reader-visible"
                      : "reader-maintenance",
                    task: false,
                  }
                );
              if (signal.aborted) break;
              if (!statusResponse.ok || !data?.success) {
                if (categoryTasks) failClassification("后台分类状态读取失败。");
                break;
              }
              const stillExists = await applyPostprocessResult(current, data, {
                trackClassification: categoryTasks,
              });
              if (uploadEntryId) {
                const postprocessComplete = data.status === "complete";
                patchBookshelfUpload(uploadEntryId, {
                  status: postprocessComplete ? "complete" : "postprocessing",
                  stage: postprocessComplete ? "complete" : "postprocessing",
                  postprocessPercent: data.progress?.percent ?? null,
                  error: data.progress?.error || null,
                });
              }
              if (!stillExists) break;
              const pendingTasks = requestedTasks.some((task) =>
                ["queued", "processing", "extracting", "classifying"].includes(
                  data.tasks?.[task]?.status
                )
              );
              if (data.status === "complete" || !pendingTasks) {
                completed = true;
                break;
              }
              delayMs = nextReaderPostprocessDelay(delayMs, {
                foreground,
                hidden:
                  typeof document !== "undefined" &&
                  document.visibilityState === "hidden",
              });
            }
            if (!completed && categoryTasks) {
              if (foreground) failClassification("后台分类等待超时。");
              else keepClassificationPending("后台自动分类仍在处理中");
            }
            if (uploadEntryId && !completed) {
              patchBookshelfUpload(uploadEntryId, {
                status: foreground ? "failed" : "postprocessing",
                stage: foreground ? "failed" : "postprocessing",
                error: foreground ? "后台处理等待超时。" : "后台处理仍在继续。",
              });
            }
          } finally {
            postprocessQueueRef.current.delete(key);
          }
        },
        {
          priority: scheduleOptions.priority,
          label: scheduleOptions.label,
          kind: "reader",
          scope: {
            route: "workspace-chat",
            workspaceSlug: workspaceSlugForTask,
            readerDocumentId,
            surface: "reader-postprocess",
          },
          policy: scheduleOptions.policy,
          resource: scheduleOptions.resource,
          emergency: scheduleOptions.emergency,
          intentRank: scheduleOptions.intentRank,
          dedupeKey: scheduleOptions.dedupeKey,
          onAbort: () => postprocessQueueRef.current.delete(key),
        }
      );
    },
    [
      applyPostprocessResult,
      markItemCategoryPending,
      patchBookshelfUpload,
      patchStoredCategoryForItem,
      workspace?.slug,
    ]
  );

  const addHistoryItemsToBookshelf = useCallback(
    (items = []) => {
      const normalizedItems = (Array.isArray(items) ? items : [items])
        .filter(Boolean)
        .map((item) => ({
          ...item,
          readerDocumentWorkspaceSlug:
            item.readerDocumentWorkspaceSlug || item.workspaceSlug || null,
          ...(item.category?.source === "manual"
            ? {}
            : pendingReaderCategory("extracting", "等待自动分类")),
        }));
      if (!normalizedItems.length) return readerBookshelf;
      const next = addItemsToBookshelf(normalizedItems);
      showToast(`已加入书架 ${normalizedItems.length} 本书`, "success");
      normalizedItems.forEach((item) => {
        if (item.category?.source === "manual") return;
        void queueBookshelfPostprocess({
          item,
          tasks: item.thumbnailDataUrl
            ? ["classification"]
            : ["thumbnail", "classification"],
        });
      });
      return next;
    },
    [addItemsToBookshelf, queueBookshelfPostprocess, readerBookshelf]
  );

  const persistDocument = useCallback((doc) => {
    clearReaderCurrentDocumentClearMarker();
    writeReaderCurrentDocument(compactDocumentForStorage(doc));
  }, []);

  const persistSources = useCallback((nextSources) => {
    writeReaderSources(nextSources || {});
  }, []);

  const setSources = useCallback(
    (updater) => {
      setSourcesByTurn((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        persistSources(next);
        return next;
      });
    },
    [persistSources]
  );

  const setPendingSelectionSources = useCallback((updater) => {
    const current = pendingSelectionsRef.current || [];
    const next = typeof updater === "function" ? updater(current) : updater;
    pendingSelectionsRef.current = dedupeReaderTextSources(
      Array.isArray(next) ? next : []
    );
    setPendingSelections(pendingSelectionsRef.current);
  }, []);

  const setPendingTextSources = useCallback((updater) => {
    const current = pendingReaderTextSourcesRef.current || [];
    const next = typeof updater === "function" ? updater(current) : updater;
    pendingReaderTextSourcesRef.current = dedupeReaderTextSources(
      Array.isArray(next) ? next : []
    );
    setPendingReaderTextSources(pendingReaderTextSourcesRef.current);
  }, []);

  const upsertPendingReaderTextSource = useCallback(
    (source) => {
      if (!source?.sourceKey) return null;
      let nextSource = null;
      setPendingTextSources((current) => {
        const index = current.findIndex(
          (item) => item.sourceKey === source.sourceKey
        );
        if (index === -1) {
          nextSource = source;
          return [...current, source];
        }
        nextSource = { ...current[index], ...source };
        const next = current.slice();
        next[index] = nextSource;
        return next;
      });
      return nextSource;
    },
    [setPendingTextSources]
  );

  const removePendingReaderTextSource = useCallback(
    (sourceKeyOrSource) => {
      const sourceKey =
        typeof sourceKeyOrSource === "string"
          ? sourceKeyOrSource
          : sourceKeyOrSource?.sourceKey ||
            readerTextSourceKey(sourceKeyOrSource);
      if (!sourceKey) return;
      setPendingTextSources((current) =>
        current.filter((source) => source.sourceKey !== sourceKey)
      );
    },
    [setPendingTextSources]
  );

  const focusReaderTextSource = useCallback(
    (sourceKeyOrSource) => {
      const sourceKey =
        typeof sourceKeyOrSource === "string"
          ? sourceKeyOrSource
          : sourceKeyOrSource?.sourceKey ||
            readerTextSourceKey(sourceKeyOrSource);
      if (!sourceKey) return;
      setPendingTextSources((current) => {
        const index = current.findIndex(
          (source) => source.sourceKey === sourceKey
        );
        if (index <= 0) return current;
        const next = current.slice();
        const [target] = next.splice(index, 1);
        return [target, ...next];
      });
      setFocusedReaderTextSource({ sourceKey, pulse: Date.now() });
    },
    [setPendingTextSources]
  );

  const openServerDocumentData = useCallback(
    async (data, historyItem = null, options = {}) => {
      const openContext = options.openContext || beginReaderOpen();
      const isCurrentOpen = () => readerOpenIsCurrent(openContext);
      const initialDocumentType = readerDocumentTypeFromData(data, historyItem);
      const canStreamPdf =
        initialDocumentType === "pdf" && readerPdfStreamUrl(data?.metadata);
      if (!isCurrentOpen()) return null;
      if (!data?.content && data?.readerDocumentId && !canStreamPdf) {
        const readerDocumentWorkspaceSlug =
          data.metadata?.readerDocumentWorkspaceSlug ||
          historyItem?.readerDocumentWorkspaceSlug ||
          historyItem?.workspaceSlug ||
          null;
        const result = await requestPriorityQueue.schedule(
          () =>
            ReaderDocument.get(
              readerDocumentWorkspaceSlug,
              data.readerDocumentId,
              {
                detail: "content",
                signal: openContext.signal,
                task: false,
              }
            ),
          {
            priority: "P0",
            label: "reader:content-fallback",
            kind: "reader",
            scope: {
              route: "workspace-chat",
              workspaceSlug:
                readerDocumentWorkspaceSlug || workspace?.slug || null,
              readerDocumentId: data.readerDocumentId,
              surface: "reader-open",
            },
            policy: "foreground",
            emergency: true,
            intentRank: 0,
            signal: openContext.signal,
            dedupeKey: `reader:content:${
              readerDocumentWorkspaceSlug || workspace?.slug || "global"
            }:${data.readerDocumentId}`,
          }
        );
        if (!result) return null;
        if (!isCurrentOpen()) return null;
        if (result?.response?.ok && result?.data?.success) {
          return openServerDocumentData(result.data, historyItem, {
            openContext,
          });
        }
      }
      if (!data?.metadata || !isCurrentOpen()) return null;
      const readerDocumentId = data.metadata.readerDocumentId;
      const documentType = readerDocumentTypeFromData(data, historyItem);
      const content =
        data.content ||
        (documentType === "pdf" && readerPdfStreamUrl(data.metadata)
          ? lightweightPdfContent(readerDocumentId)
          : null);
      if (!content) return null;
      const progressItem = readerItemWithLatestBookMemory({
        ...historyItem,
        source: data.metadata.source || historyItem?.source || "reader_upload",
        title: historyItem?.title || data.metadata.originalName,
        bookKey:
          historyItem?.bookKey ||
          normalizeBookTitle(data.metadata.originalName),
        branchId: historyItem?.branchId || null,
        branchLabel: historyItem?.branchLabel || null,
        documentType: content.documentType,
        initialTargetSource: historyItem?.initialTargetSource || null,
        readerDocumentId:
          historyItem?.readerDocumentId || readerDocumentId || null,
        backupReaderDocumentId:
          historyItem?.backupReaderDocumentId || readerDocumentId || null,
        readerDocumentWorkspaceSlug:
          data.metadata.readerDocumentWorkspaceSlug ||
          historyItem?.readerDocumentWorkspaceSlug ||
          historyItem?.workspaceSlug ||
          null,
        localPath: data.metadata.localPath || historyItem?.localPath || null,
        progress: historyItem?.progress || {
          label: "阅读进度",
          percent: 0,
          updatedAt: null,
        },
      });
      let parsedContent = content;
      let objectUrl = null;
      let renderType = null;
      let previewWarning = data.warning || data.metadata.previewWarning || null;
      setReaderObjectUrl(null);
      if (content.documentType === "docx" && data.metadata?.previewPdfUrl) {
        const { response: previewResponse, blob: previewBlob } =
          await ReaderDocument.previewBlob(data.metadata.previewPdfUrl, {
            signal: openContext.signal,
            task: readerOpenTask(
              "reader:preview-blob",
              progressItem?.readerDocumentWorkspaceSlug ||
                workspace?.slug ||
                null,
              { readerDocumentId }
            ),
          });
        if (!isCurrentOpen()) return null;
        if (previewResponse.ok && previewBlob.size > 0) {
          objectUrl = URL.createObjectURL(previewBlob);
          setReaderObjectUrl(objectUrl);
          renderType = "pdf-preview";
          parsedContent = { ...data.content, previewMode: "pdf-preview" };
          previewWarning = null;
        } else {
          previewWarning =
            previewWarning || "版式预览生成失败，已切换为临时可读预览。";
        }
      }
      if (!renderType && data.metadata?.originalUrl) {
        if (content.documentType === "pdf") {
          objectUrl = readerPdfStreamUrl(data.metadata);
          renderType = "pdf-stream";
        } else {
          const { response: blobResponse, blob } =
            await ReaderDocument.originalBlob(data.metadata.originalUrl, {
              signal: openContext.signal,
              task: readerOpenTask(
                "reader:original-blob",
                progressItem?.readerDocumentWorkspaceSlug ||
                  workspace?.slug ||
                  null,
                { readerDocumentId }
              ),
            });
          if (!isCurrentOpen()) return null;
          if (blobResponse.ok) {
            objectUrl = URL.createObjectURL(blob);
            setReaderObjectUrl(objectUrl);
            const file = new File(
              [blob],
              data.metadata.originalName || "original",
              { type: data.metadata.mimeType }
            );
            parsedContent =
              (await parseFileByType(
                file,
                readerDocumentId,
                content?.documentType
              )) || content;
            if (!isCurrentOpen()) return null;
          }
        }
      }

      const doc = {
        source: data.metadata.source || "reader_upload",
        readerDocumentId,
        backupReaderDocumentId: readerDocumentId,
        documentType: parsedContent.documentType,
        renderType,
        title: data.metadata.originalName,
        bookKey:
          progressItem?.bookKey ||
          normalizeBookTitle(data.metadata.originalName),
        branchId: progressItem?.branchId || null,
        branchLabel: progressItem?.branchLabel || null,
        metadata: data.metadata,
        content: parsedContent,
        objectUrl,
        initialTargetSource: historyItem?.initialTargetSource || null,
        localPath: data.metadata.localPath || progressItem?.localPath || null,
        progress: normalizedReaderProgress(progressItem?.progress),
        thumbnailDataUrl: progressItem?.thumbnailDataUrl || null,
        readerDocumentWorkspaceSlug:
          data.metadata.readerDocumentWorkspaceSlug ||
          progressItem?.readerDocumentWorkspaceSlug ||
          progressItem?.workspaceSlug ||
          null,
        previewWarning,
      };
      if (!isCurrentOpen()) return null;
      clearReaderCloseSuppression();
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      setDrawerOpenPersisted(false);
      if (previewWarning) showToast(previewWarning, "warning");
      return doc;
    },
    [
      beginReaderOpen,
      clearReaderCloseSuppression,
      persistDocument,
      rememberDocument,
      readerOpenIsCurrent,
      setDrawerOpenPersisted,
      setReaderObjectUrl,
      workspace?.slug,
    ]
  );

  const openLocalSourceDocument = useCallback(
    async (historyItem = null, options = {}) => {
      const openContext = options.openContext || beginReaderOpen();
      const isCurrentOpen = () => readerOpenIsCurrent(openContext);
      if (!historyItem?.localSourceId) return { ok: false, reason: "missing" };
      const localSource = await openReaderLocalSource(historyItem);
      if (!isCurrentOpen()) return { ok: false, reason: "aborted" };
      if (!localSource.ok || !localSource.file) return localSource;

      const file = localSource.file;
      const validation = validateReaderFile(file);
      if (!validation.ok) {
        return {
          ok: false,
          reason: "invalid-file",
          message: validation.error,
        };
      }

      const objectUrl = URL.createObjectURL(file);
      setReaderObjectUrl(objectUrl);
      const progressItem = readerItemWithLatestBookMemory({
        ...historyItem,
        documentType: historyItem.documentType || validation.documentType,
        progress: historyItem.progress || {
          label: "阅读进度",
          percent: 0,
          updatedAt: null,
        },
      });
      const readerDocumentId =
        historyItem.readerDocumentId ||
        historyItem.backupReaderDocumentId ||
        historyItem.localSourceId;
      const content = await parseFileByType(
        file,
        readerDocumentId,
        validation.documentType
      );
      if (!isCurrentOpen()) return { ok: false, reason: "aborted" };
      const doc = {
        source: historyItem.source || "reader_upload",
        readerDocumentId: historyItem.readerDocumentId || null,
        backupReaderDocumentId: historyItem.backupReaderDocumentId || null,
        readerDocumentWorkspaceSlug:
          historyItem.readerDocumentWorkspaceSlug ||
          historyItem.workspaceSlug ||
          null,
        localSourceId: historyItem.localSourceId || null,
        localSourceKind: historyItem.localSourceKind || "file-handle",
        localFingerprint:
          localSource.source?.fingerprint ||
          historyItem.localFingerprint ||
          null,
        documentType: validation.documentType,
        title: historyItem.title || file.name,
        bookKey:
          progressItem?.bookKey ||
          historyItem.bookKey ||
          normalizeBookTitle(historyItem.title || file.name),
        branchId: progressItem?.branchId || historyItem.branchId || null,
        branchLabel:
          progressItem?.branchLabel || historyItem.branchLabel || null,
        metadata: {
          ...(historyItem.metadata || {}),
          source: historyItem.source || "reader_upload",
          originalName: historyItem.title || file.name,
          mimeType: file.type,
          size: file.size,
          localSourceKind: historyItem.localSourceKind || "file-handle",
          localFingerprint:
            localSource.source?.fingerprint ||
            historyItem.localFingerprint ||
            null,
          readerDocumentId: historyItem.readerDocumentId || null,
          readerDocumentWorkspaceSlug:
            historyItem.readerDocumentWorkspaceSlug ||
            historyItem.workspaceSlug ||
            null,
        },
        content,
        objectUrl,
        file,
        progress: normalizedReaderProgress(progressItem?.progress),
        thumbnailDataUrl: progressItem?.thumbnailDataUrl || null,
      };

      clearReaderCloseSuppression();
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      setDrawerOpenPersisted(false);
      return { ok: true, opened: doc };
    },
    [
      beginReaderOpen,
      clearReaderCloseSuppression,
      persistDocument,
      rememberDocument,
      readerOpenIsCurrent,
      setDrawerOpenPersisted,
      setReaderObjectUrl,
    ]
  );

  const openReaderDocument = useCallback(
    async (readerDocumentId, historyItem = null, options = {}) => {
      if (!readerDocumentId) return;
      const openContext = options.openContext || beginReaderOpen();
      const isCurrentOpen = () => readerOpenIsCurrent(openContext);
      const readerDocumentWorkspaceSlug =
        historyItem?.readerDocumentWorkspaceSlug ||
        historyItem?.workspaceSlug ||
        null;
      let response;
      let data;
      let requestError = null;
      const detail =
        historyItem?.documentType === "pdf" ||
        historyItem?.metadata?.documentType === "pdf"
          ? "metadata"
          : "content";
      try {
        const result = await requestPriorityQueue.schedule(
          () =>
            ReaderDocument.get(readerDocumentWorkspaceSlug, readerDocumentId, {
              detail,
              signal: openContext.signal,
              task: false,
            }),
          {
            priority: "P0",
            label: "reader:open-document",
            kind: "reader",
            scope: {
              route: "workspace-chat",
              workspaceSlug:
                readerDocumentWorkspaceSlug || workspace?.slug || null,
              readerDocumentId,
              surface: "reader-open",
            },
            policy: "foreground",
            emergency: true,
            intentRank: 0,
            signal: openContext.signal,
            dedupeKey: `reader:open:${
              readerDocumentWorkspaceSlug || workspace?.slug || "global"
            }:${readerDocumentId}`,
          }
        );
        if (!result) return null;
        response = result.response;
        data = result.data;
      } catch (error) {
        if (error?.name === "AbortError") return null;
        requestError = error;
      }
      if (!isCurrentOpen()) return null;
      if (!response?.ok || !data?.success) {
        const failure = readerOpenFailureDetails(
          response,
          data,
          requestError,
          "服务器伴读文档打开失败"
        );
        if (failure.retryable) {
          queuePendingReaderOpen(
            {
              kind: "server",
              readerDocumentId,
              historyItem,
            },
            failure.message,
            options
          );
        } else if (!options.suppressTerminalToast) {
          showToast(failure.message, "error");
        }
        return null;
      }
      try {
        const opened = await openServerDocumentData(data, historyItem, {
          openContext,
        });
        if (!isCurrentOpen()) return null;
        if (opened) {
          markTaskPerformance("reader_target_ready", {
            readerDocumentId,
            workspaceSlug: readerDocumentWorkspaceSlug || workspace?.slug,
          });
          clearPendingReaderOpen("server", readerDocumentId);
        }
        return opened;
      } catch (error) {
        if (error?.name === "AbortError") return null;
        if (!isCurrentOpen()) return null;
        const failure = readerOpenFailureDetails(
          null,
          null,
          error,
          "服务器伴读文档打开失败"
        );
        if (failure.retryable) {
          queuePendingReaderOpen(
            {
              kind: "server",
              readerDocumentId,
              historyItem,
            },
            failure.message,
            options
          );
        } else if (!options.suppressTerminalToast) {
          showToast(failure.message, "error");
        }
        return null;
      }
    },
    [
      beginReaderOpen,
      clearPendingReaderOpen,
      openServerDocumentData,
      queuePendingReaderOpen,
      readerOpenIsCurrent,
      workspace?.slug,
    ]
  );

  const reopenLocalPathDocument = useCallback(
    async (readerDocumentId, historyItem = null, options = {}) => {
      if (!readerDocumentId) return false;
      const openContext = options.openContext || beginReaderOpen();
      const isCurrentOpen = () => readerOpenIsCurrent(openContext);
      const readerDocumentWorkspaceSlug =
        historyItem?.readerDocumentWorkspaceSlug ||
        historyItem?.workspaceSlug ||
        null;
      let response;
      let data;
      let requestError = null;
      try {
        const result = await ReaderDocument.reopenLocalPath(
          readerDocumentWorkspaceSlug,
          readerDocumentId,
          {
            signal: openContext.signal,
            task: readerOpenTask(
              "reader:reopen-local-path",
              readerDocumentWorkspaceSlug || workspace?.slug || null,
              { readerDocumentId }
            ),
          }
        );
        response = result.response;
        data = result.data;
      } catch (error) {
        if (error?.name === "AbortError")
          return options.returnStatus
            ? { ok: false, retryable: false, reason: "aborted" }
            : false;
        requestError = error;
      }
      if (!isCurrentOpen())
        return options.returnStatus
          ? { ok: false, retryable: false, reason: "aborted" }
          : false;
      if (!response?.ok || !data?.success) {
        const failure = readerOpenFailureDetails(
          response,
          data,
          requestError,
          "本地路径文档打开失败"
        );
        if (failure.retryable) {
          queuePendingReaderOpen(
            {
              kind: "localPath",
              readerDocumentId,
              historyItem,
            },
            failure.message,
            options
          );
        } else if (!options.suppressTerminalToast) {
          showToast(failure.message, "warning");
        }
        return options.returnStatus ? { ok: false, ...failure } : false;
      }
      try {
        const opened = await openServerDocumentData(data, historyItem, {
          openContext,
        });
        if (!isCurrentOpen())
          return options.returnStatus
            ? { ok: false, retryable: false, reason: "aborted" }
            : false;
        if (opened) clearPendingReaderOpen("localPath", readerDocumentId);
        const result = {
          ok: !!opened,
          opened,
          status: response?.status || 200,
          retryable: false,
          terminal: false,
          message: null,
        };
        return options.returnStatus ? result : result.ok;
      } catch (error) {
        if (error?.name === "AbortError")
          return options.returnStatus
            ? { ok: false, retryable: false, reason: "aborted" }
            : false;
        if (!isCurrentOpen())
          return options.returnStatus
            ? { ok: false, retryable: false, reason: "aborted" }
            : false;
        const failure = readerOpenFailureDetails(
          null,
          null,
          error,
          "本地路径文档打开失败"
        );
        if (failure.retryable) {
          queuePendingReaderOpen(
            {
              kind: "localPath",
              readerDocumentId,
              historyItem,
            },
            failure.message,
            options
          );
        } else if (!options.suppressTerminalToast) {
          showToast(failure.message, "warning");
        }
        return options.returnStatus ? { ok: false, ...failure } : false;
      }
    },
    [
      beginReaderOpen,
      clearPendingReaderOpen,
      openServerDocumentData,
      queuePendingReaderOpen,
      readerOpenIsCurrent,
    ]
  );

  const openWorkspaceParsedDocument = useCallback(
    async (
      docPath,
      sourceWorkspaceSlug = workspace?.slug,
      historyItem = null,
      options = {}
    ) => {
      if (!sourceWorkspaceSlug || !docPath) return;
      const openContext = options.openContext || beginReaderOpen();
      const isCurrentOpen = () => readerOpenIsCurrent(openContext);
      if (!historyItem) setDrawerSectionPersisted("workspace");
      let response;
      let data;
      try {
        const result = await ReaderDocument.fromWorkspace(
          sourceWorkspaceSlug,
          docPath,
          {
            signal: openContext.signal,
            task: readerOpenTask(
              "reader:open-workspace-document",
              sourceWorkspaceSlug,
              {
                workspaceDocPath: docPath,
              }
            ),
          }
        );
        response = result.response;
        data = result.data;
      } catch (error) {
        if (error?.name === "AbortError") return;
        throw error;
      }
      if (!isCurrentOpen()) return;
      if (!response.ok || !data?.success) {
        showToast(data?.error || "解析文本预览打开失败", "error");
        return;
      }
      const progressItem = readerItemWithLatestBookMemory({
        ...historyItem,
        source: "workspace_parsed",
        title: historyItem?.title || data.metadata.originalName,
        bookKey:
          historyItem?.bookKey ||
          normalizeBookTitle(data.metadata.originalName),
        documentType: "markdown",
        readerDocumentId:
          historyItem?.readerDocumentId || data.metadata.readerDocumentId,
        workspaceDocPath: historyItem?.workspaceDocPath || docPath,
        readerDocumentWorkspaceSlug:
          historyItem?.readerDocumentWorkspaceSlug ||
          historyItem?.workspaceSlug ||
          sourceWorkspaceSlug,
        progress: historyItem?.progress || {
          label: "阅读进度",
          percent: 0,
          updatedAt: null,
        },
      });
      const doc = {
        source: "workspace_parsed",
        readerDocumentId: data.metadata.readerDocumentId,
        documentType: "markdown",
        title: data.metadata.originalName,
        bookKey:
          progressItem?.bookKey ||
          normalizeBookTitle(data.metadata.originalName),
        branchId: progressItem?.branchId || null,
        branchLabel: progressItem?.branchLabel || null,
        metadata: { ...data.metadata, workspaceDocPath: docPath },
        workspaceDocPath: docPath,
        readerDocumentWorkspaceSlug: sourceWorkspaceSlug,
        content: data.content,
        progress: normalizedReaderProgress(progressItem?.progress),
      };
      setReaderObjectUrl(null);
      if (!isCurrentOpen()) return;
      clearReaderCloseSuppression();
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      setDrawerOpenPersisted(false);
    },
    [
      beginReaderOpen,
      clearReaderCloseSuppression,
      persistDocument,
      rememberDocument,
      readerOpenIsCurrent,
      setDrawerSectionPersisted,
      setDrawerOpenPersisted,
      setReaderObjectUrl,
      workspace?.slug,
    ]
  );

  const retryPendingReaderOpen = useCallback(() => {
    const pending = pendingReaderOpenRef.current;
    if (
      !pending ||
      readerClosingRef.current ||
      readerCloseSuppressed() ||
      currentDocument
    )
      return;
    const now = Date.now();
    if (now - Number(pending.lastRetryAt || 0) < 1500) return;
    pendingReaderOpenRef.current = { ...pending, lastRetryAt: now };
    if (pending.kind === "localPath") {
      void reopenLocalPathDocument(
        pending.readerDocumentId,
        pending.historyItem,
        {
          silentRetry: true,
        }
      );
      return;
    }
    void openReaderDocument(pending.readerDocumentId, pending.historyItem, {
      silentRetry: true,
    });
  }, [
    currentDocument,
    openReaderDocument,
    readerCloseSuppressed,
    reopenLocalPathDocument,
  ]);

  useEffect(() => {
    const retryWhenVisible = () => {
      if (window.document.visibilityState === "visible")
        retryPendingReaderOpen();
    };
    window.addEventListener("online", retryPendingReaderOpen);
    window.addEventListener("focus", retryPendingReaderOpen);
    window.document.addEventListener("visibilitychange", retryWhenVisible);
    return () => {
      window.removeEventListener("online", retryPendingReaderOpen);
      window.removeEventListener("focus", retryPendingReaderOpen);
      window.document.removeEventListener("visibilitychange", retryWhenVisible);
    };
  }, [retryPendingReaderOpen]);

  useEffect(() => {
    const routeKey = `${workspace?.slug || ""}:${threadSlug || ""}`;
    if (readerRouteKeyRef.current === routeKey) return;
    readerRouteKeyRef.current = routeKey;
    abortReaderOpen();
    beginReaderCloseSuppression();
    setCurrentDocument(null);
    setPendingSelectionSources([]);
    setPendingTextSources([]);
    setFocusedReaderTextSource(null);
    clearReaderCurrentDocumentStorage();
    setDrawerOpenPersisted(false);
    setReaderObjectUrl(null);
  }, [
    abortReaderOpen,
    beginReaderCloseSuppression,
    setDrawerOpenPersisted,
    setPendingSelectionSources,
    setPendingTextSources,
    setReaderObjectUrl,
    threadSlug,
    workspace?.slug,
  ]);

  useEffect(() => {
    const ensureDocumentForJump = async (event) => {
      const source = event.detail || {};
      if (source.__readerJumpResolved || !source?.selectedText) return;
      if (readerCloseSuppressed()) return;
      const sourceReaderDocumentId =
        source.readerDocumentId || source.backupReaderDocumentId || null;
      const alreadyOpen =
        (sourceReaderDocumentId &&
          (currentDocument?.readerDocumentId === sourceReaderDocumentId ||
            currentDocument?.backupReaderDocumentId ===
              sourceReaderDocumentId)) ||
        (source.localDocumentId &&
          currentDocument?.localDocumentId === source.localDocumentId);
      if (alreadyOpen || !sourceReaderDocumentId) return;
      setDrawerOpenPersisted(true);
      const opened = await openReaderDocument(sourceReaderDocumentId, {
        title: source.documentTitle,
        documentType: source.documentType,
        readerDocumentId: source.readerDocumentId,
        backupReaderDocumentId: source.backupReaderDocumentId,
        initialTargetSource: source,
        progress: readerProgressFromPdfTargetSource(source),
      });
      if (!opened) return;
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("anythingllm-document-reader-jump", {
            detail: { ...source, __readerJumpResolved: true },
          })
        );
      }, 220);
    };
    window.addEventListener(
      "anythingllm-document-reader-jump",
      ensureDocumentForJump
    );
    return () =>
      window.removeEventListener(
        "anythingllm-document-reader-jump",
        ensureDocumentForJump
      );
  }, [
    currentDocument,
    openReaderDocument,
    readerCloseSuppressed,
    setDrawerOpenPersisted,
  ]);

  useEffect(() => {
    migrateReaderStorage(workspace?.slug, threadSlug);
    refreshLocalReaderLibraryState();
    void refreshReaderLibraryFromPersistentSources("route-open");

    const stored = readerItemWithLatestBookMemory(
      readReaderCurrentDocument(null)
    );
    if (
      !stored ||
      !isReaderCurrentDocumentFresh(
        stored,
        readReaderCurrentDocumentClearedAt()
      ) ||
      readerCloseSuppressed()
    ) {
      const restoredDrawerState = readReaderDrawerState();
      drawerSectionRef.current = restoredDrawerState.section;
      setDrawerInitialSection(restoredDrawerState.section);
      if (readReaderDrawerOpenIntent() && !readerCloseSuppressed())
        setDrawerOpen(true);
      return;
    }
    setDrawerOpen(true);
    if (stored.source === "workspace_parsed" && stored.workspaceDocPath) {
      openWorkspaceParsedDocument(
        stored.workspaceDocPath,
        stored.readerDocumentWorkspaceSlug || workspace?.slug,
        stored
      );
      return;
    }
    const storedServerId =
      stored.readerDocumentId || stored.backupReaderDocumentId;
    if (storedServerId) {
      if (["docx", "epub"].includes(stored.documentType)) {
        setDocxPreviewStatus({
          fileName: stored.title,
          message: loadingMessageForDocumentType(stored.documentType),
        });
      }
      openReaderDocument(storedServerId, {
        ...stored,
        localPath: null,
        localSourceId: null,
      }).finally(() => {
        if (["docx", "epub"].includes(stored.documentType))
          setDocxPreviewStatus(null);
      });
      return;
    }
    if (stored.source === "local") {
      showToast("本地文档不可恢复，请重新选择文件。", "warning");
      setDrawerOpenPersisted(true);
    }
  }, [
    openReaderDocument,
    openWorkspaceParsedDocument,
    readerCloseSuppressed,
    refreshLocalReaderLibraryState,
    refreshReaderLibraryFromPersistentSources,
    setDrawerOpenPersisted,
    storageKey,
    migrateReaderStorage,
    threadSlug,
    workspace?.slug,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    refreshReaderLibraryFromPersistentSources(
      "token-or-route",
      controller.signal
    );
    return () => controller.abort();
  }, [authToken, storageKey, refreshReaderLibraryFromPersistentSources]);

  useEffect(() => {
    if (!drawerOpen || readerBookshelf.length > 0) return;
    const controller = new AbortController();
    let stopped = false;
    const refreshEmptyBookshelf = (reason) => {
      if (stopped || controller.signal.aborted) return;
      refreshReaderLibraryFromPersistentSources(reason, controller.signal);
    };
    refreshEmptyBookshelf("drawer-open");
    const retry = window.setInterval(() => {
      refreshEmptyBookshelf("drawer-open-empty-retry");
    }, 5_000);
    return () => {
      stopped = true;
      window.clearInterval(retry);
      controller.abort();
    };
  }, [
    drawerOpen,
    readerBookshelf.length,
    refreshReaderLibraryFromPersistentSources,
  ]);

  useEffect(() => {
    const onReaderLocalCacheHydrated = (event) => {
      const hydratedKey = event?.detail?.key;
      const shouldRefreshLocalState =
        !hydratedKey ||
        hydratedKey === storageKey ||
        hydratedKey === READER_SOURCES_STORAGE_KEY ||
        hydratedKey === READER_HISTORY_STORAGE_KEY ||
        hydratedKey === READER_BOOKSHELF_STORAGE_KEY ||
        hydratedKey === READER_BOOKSHELF_CATEGORIES_STORAGE_KEY;

      if (shouldRefreshLocalState) {
        refreshLocalReaderLibraryState();
      }

      if (hydratedKey && hydratedKey !== storageKey) {
        return;
      }

      const stored = readerItemWithLatestBookMemory(
        readReaderCurrentDocument(null)
      );
      if (
        !stored ||
        !isReaderCurrentDocumentFresh(
          stored,
          readReaderCurrentDocumentClearedAt()
        ) ||
        readerCloseSuppressed()
      ) {
        return;
      }

      setDrawerOpen(true);
      if (stored.source === "workspace_parsed" && stored.workspaceDocPath) {
        openWorkspaceParsedDocument(
          stored.workspaceDocPath,
          stored.readerDocumentWorkspaceSlug || workspace?.slug,
          stored
        );
        return;
      }

      const storedServerId =
        stored.readerDocumentId || stored.backupReaderDocumentId;
      if (storedServerId) {
        openReaderDocument(storedServerId, {
          ...stored,
          localPath: null,
          localSourceId: null,
        });
        return;
      }

      if (stored.source === "local") {
        setCurrentDocument((current) => current || stored);
      }
    };

    window.addEventListener(
      "athena-reader-local-cache-hydrated",
      onReaderLocalCacheHydrated
    );
    return () =>
      window.removeEventListener(
        "athena-reader-local-cache-hydrated",
        onReaderLocalCacheHydrated
      );
  }, [
    openReaderDocument,
    openWorkspaceParsedDocument,
    readerCloseSuppressed,
    refreshLocalReaderLibraryState,
    storageKey,
    workspace?.slug,
  ]);

  useEffect(() => {
    return () => {
      window.clearTimeout(readerCloseSuppressionTimerRef.current);
      abortReaderOpen();
      setReaderObjectUrl(null);
    };
  }, [abortReaderOpen, setReaderObjectUrl]);

  useEffect(() => {
    const open = (event) => {
      const userOpenSources = new Set(["toolbar", "reader-source-card"]);
      const source = event?.detail?.source || null;
      if (event?.detail?.force && userOpenSources.has(source)) {
        clearReaderCloseSuppression();
      } else if (readerCloseSuppressed()) {
        return;
      }
      setDrawerOpenPersisted(true);
    };
    window.addEventListener(READER_EVENT_OPEN_DRAWER, open);
    return () => window.removeEventListener(READER_EVENT_OPEN_DRAWER, open);
  }, [
    clearReaderCloseSuppression,
    readerCloseSuppressed,
    setDrawerOpenPersisted,
  ]);

  useEffect(() => {
    const associate = (event) => {
      const { chatKey, clientGeneratedTurnId, turnId } = event.detail || {};
      const selections = pendingSelectionsRef.current || [];
      if (!chatKey || !selections.length || !clientGeneratedTurnId) return;
      const mapKey = `${chatKey}:${clientGeneratedTurnId || turnId}`;
      setSources((prev) => ({
        ...prev,
        [mapKey]: dedupeReaderTextSources([
          ...(prev[mapKey] || []),
          ...selections,
        ]),
      }));
      pendingSelectionsRef.current = [];
      setPendingSelections([]);
    };
    const complete = (event) => {
      const { chatKey, turnId, chatId } = event.detail || {};
      if (!chatKey || !turnId || !chatId) return;
      const fromKey = `${chatKey}:${turnId}`;
      const toKey = `${chatKey}:chat:${chatId}`;
      setSources((prev) => {
        const fromSources = prev[fromKey] || [];
        if (!fromSources.length) return prev;
        const next = { ...prev };
        next[toKey] = dedupeReaderTextSources([
          ...(prev[toKey] || []),
          ...fromSources.map((source) => ({ ...source, chatId })),
        ]);
        delete next[fromKey];
        return next;
      });
    };
    window.addEventListener(READER_EVENT_ASSOCIATE_SELECTION, associate);
    window.addEventListener(READER_EVENT_TURN_COMPLETED, complete);
    return () => {
      window.removeEventListener(READER_EVENT_ASSOCIATE_SELECTION, associate);
      window.removeEventListener(READER_EVENT_TURN_COMPLETED, complete);
    };
  }, [setSources]);

  useEffect(() => {
    const consume = (event) => {
      const sources = pendingReaderTextSourcesRef.current || [];
      const readySources = dedupeReaderTextSources(
        sources.filter(
          (source) =>
            source?.selectedText &&
            (!source.ocrStatus || source.ocrStatus === "ready")
        )
      );
      if (readySources.length) {
        setPendingSelectionSources((current) =>
          dedupeReaderTextSources([...current, ...readySources])
        );
        const readyIdentities = new Set(
          readySources.map(readerTextSourceIdentity).filter(Boolean)
        );
        setPendingTextSources((current) =>
          current.filter(
            (source) => !readyIdentities.has(readerTextSourceIdentity(source))
          )
        );
      }
      event.detail?.reply?.({ sources: readySources });
    };
    window.addEventListener(READER_EVENT_CONSUME_TEXT_SOURCES, consume);
    return () =>
      window.removeEventListener(READER_EVENT_CONSUME_TEXT_SOURCES, consume);
  }, [setPendingSelectionSources, setPendingTextSources]);

  const findUploadedHistoryForTitle = useCallback((title) => {
    const bookKey = normalizeBookTitle(title);
    return readReaderHistory().find(
      (item) =>
        item.bookKey === bookKey &&
        !item.branchId &&
        (item.readerDocumentId || item.backupReaderDocumentId || item.uploaded)
    );
  }, []);

  const openUploadedHistoryItem = useCallback(
    async (historyItem, options = {}) => {
      if (!historyItem) return false;
      const openContext = options.openContext || beginReaderOpen();
      const isCurrentOpen = () => readerOpenIsCurrent(openContext);
      const showDocumentLoadingStatus = ["docx", "epub"].includes(
        historyItem.documentType
      );
      if (showDocumentLoadingStatus) {
        setDocxPreviewStatus({
          fileName: historyItem.title,
          message: loadingMessageForDocumentType(historyItem.documentType),
        });
      }
      try {
        const serverDocumentIds = serverReaderDocumentIds(historyItem);

        for (const readerDocumentId of serverDocumentIds) {
          const opened = await openReaderDocument(
            readerDocumentId,
            { ...historyItem, localPath: null, localSourceId: null },
            { suppressTerminalToast: true, openContext }
          );
          if (!isCurrentOpen()) return false;
          if (!opened) continue;
          const nextBookshelf = updateReaderBookshelfItem(historyItem, {
            readerDocumentId: opened.readerDocumentId || readerDocumentId,
            backupReaderDocumentId:
              opened.backupReaderDocumentId || readerDocumentId,
            readerDocumentWorkspaceSlug:
              opened.readerDocumentWorkspaceSlug ||
              historyItem.readerDocumentWorkspaceSlug ||
              historyItem.workspaceSlug ||
              null,
            source: opened.source || historyItem.source,
            localPath: null,
            localSourceId: null,
            progress: opened.progress || historyItem.progress,
          });
          setReaderBookshelf(nextBookshelf);
          return true;
        }

        if (
          options.allowLocalFallback &&
          historyItem.localPath &&
          historyItem.readerDocumentId
        ) {
          const localPathResult = await reopenLocalPathDocument(
            historyItem.readerDocumentId,
            historyItem,
            {
              returnStatus: true,
              suppressTerminalToast: true,
              openContext,
            }
          );
          if (!isCurrentOpen()) return false;
          if (localPathResult.ok) return true;
          if (localPathResult.retryable) return false;
        }
        return false;
      } finally {
        if (showDocumentLoadingStatus) setDocxPreviewStatus(null);
      }
    },
    [
      beginReaderOpen,
      openReaderDocument,
      readerOpenIsCurrent,
      reopenLocalPathDocument,
    ]
  );

  const requestLocalFileConflictChoice = useCallback(
    (file, existingHistory) => {
      return new Promise((resolve) => {
        localFileConflictResolverRef.current = resolve;
        setLocalFileConflict({
          fileName: file.name,
          existingTitle: existingHistory.title,
        });
      });
    },
    []
  );

  const resolveLocalFileConflict = useCallback((choice) => {
    localFileConflictResolverRef.current?.(choice);
    localFileConflictResolverRef.current = null;
    setLocalFileConflict(null);
  }, []);

  const openLocalFile = useCallback(
    async (file, options = {}) => {
      const openContext = options.openContext || beginReaderOpen();
      const isCurrentOpen = () => readerOpenIsCurrent(openContext);
      if (!options.addToBookshelf) setDrawerSectionPersisted("history");
      const validation = validateReaderFile(file);
      if (!validation.ok) {
        showToast(validation.error, "error");
        return;
      }
      const bookKey = normalizeBookTitle(file.name);
      const existingUploaded = findUploadedHistoryForTitle(file.name);
      if (existingUploaded && !options.skipConflict && !options.branch) {
        const choice = await requestLocalFileConflictChoice(
          file,
          existingUploaded
        );
        if (!isCurrentOpen()) return;
        if (choice === "uploaded") {
          await openUploadedHistoryItem(existingUploaded, { openContext });
          if (!isCurrentOpen()) return;
          if (options.addToBookshelf) {
            const item = {
              ...existingUploaded,
              readerDocumentWorkspaceSlug:
                existingUploaded.readerDocumentWorkspaceSlug ||
                existingUploaded.workspaceSlug ||
                null,
              ...(existingUploaded.category?.source === "manual"
                ? {}
                : pendingReaderCategory("extracting", "等待自动分类")),
            };
            addItemsToBookshelf([item]);
            if (existingUploaded.category?.source !== "manual")
              void queueBookshelfPostprocess({
                item,
                tasks: item.thumbnailDataUrl
                  ? ["classification"]
                  : ["thumbnail", "classification"],
              });
          }
          return;
        }
        if (choice !== "branch") return;
        options = { ...options, branch: true, skipConflict: true };
      }
      const localDocumentId = uuid();
      const formData = new FormData();
      formData.append("file", file, file.name);
      setDocxPreviewStatus({
        fileName: file.name,
        message: loadingMessageForDocumentType(validation.documentType),
      });
      try {
        const uploadResult = await requestPriorityQueue.schedule(
          () =>
            ReaderDocument.upload(null, formData, {
              signal: openContext.signal,
              task: false,
            }),
          {
            priority: "P0",
            label: "reader:quick-upload",
            kind: "upload",
            scope: {
              route: "workspace-chat",
              workspaceSlug: workspace?.slug || null,
              surface: "reader-upload",
            },
            policy: "foreground",
            emergency: true,
            intentRank: 0,
            signal: openContext.signal,
            dedupeKey: `reader:quick-upload:${bookKey}:${
              options.branch ? "branch" : "main"
            }`,
          }
        );
        if (!uploadResult) return;
        const { response, data } = uploadResult;
        if (!isCurrentOpen()) return;
        if (!response.ok || !data?.success)
          throw new Error(data?.error || "自动上传失败");
        const doc = await openServerDocumentData(
          data,
          {
            bookKey,
            branchId: options.branch ? `local-${localDocumentId}` : null,
            branchLabel: options.branch ? "本地分支" : null,
            progress: { label: "阅读进度", percent: 0, updatedAt: null },
          },
          { openContext }
        );
        if (!isCurrentOpen()) return;
        if (options.addToBookshelf && doc) {
          const item = {
            ...bookshelfItemFromDocument(doc),
            ...pendingReaderCategory("extracting", "等待自动分类"),
          };
          addItemsToBookshelf([item]);
          void queueBookshelfPostprocess({
            item,
            tasks: ["thumbnail", "classification"],
          });
        }
        return doc;
      } catch (error) {
        if (error?.name === "AbortError" || !isCurrentOpen()) return;
        showToast(
          `${error.message || "自动上传失败"}，已临时本地预览。`,
          "warning"
        );
      } finally {
        setDocxPreviewStatus(null);
      }
      if (!isCurrentOpen()) return;
      const objectUrl = URL.createObjectURL(file);
      setReaderObjectUrl(objectUrl);
      const content = await parseFileByType(
        file,
        localDocumentId,
        validation.documentType
      );
      if (!isCurrentOpen()) return;
      const progressItem = readerItemWithLatestBookMemory({
        source: "local",
        title: file.name,
        bookKey,
        branchId: options.branch ? `local-${localDocumentId}` : null,
        branchLabel: options.branch ? "本地分支" : null,
        localDocumentId,
        documentType: validation.documentType,
        progress: { label: "阅读进度", percent: 0, updatedAt: null },
      });
      const doc = {
        source: "local",
        localDocumentId,
        documentType: validation.documentType,
        title: file.name,
        bookKey,
        branchId: options.branch ? `local-${localDocumentId}` : null,
        branchLabel: options.branch ? "本地分支" : null,
        metadata: {
          source: "local",
          originalName: file.name,
          mimeType: file.type,
          size: file.size,
          createdAt: new Date().toISOString(),
        },
        content,
        objectUrl,
        file,
        progress: normalizedReaderProgress(progressItem?.progress),
      };
      if (!isCurrentOpen()) return;
      clearReaderCloseSuppression();
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      if (options.addToBookshelf) {
        const item = {
          ...bookshelfItemFromDocument(doc),
        };
        addItemsToBookshelf([item]);
      }
      setDrawerOpenPersisted(false);
      return doc;
    },
    [
      addItemsToBookshelf,
      beginReaderOpen,
      bookshelfItemFromDocument,
      clearReaderCloseSuppression,
      findUploadedHistoryForTitle,
      openUploadedHistoryItem,
      openServerDocumentData,
      persistDocument,
      queueBookshelfPostprocess,
      readerOpenIsCurrent,
      rememberDocument,
      requestLocalFileConflictChoice,
      setDrawerSectionPersisted,
      setDrawerOpenPersisted,
      setReaderObjectUrl,
      workspace?.slug,
    ]
  );

  const uploadFilesToBookshelf = useCallback(
    async (files = [], options = {}) => {
      const selectedEntries = Array.from(files || [])
        .map((entry) =>
          entry?.file ? entry : { file: entry, handle: entry?.handle || null }
        )
        .filter((entry) => entry?.file);
      if (!selectedEntries.length) return [];
      const itemsToAdd = [];
      for (const [index, entry] of selectedEntries.entries()) {
        const { file } = entry;
        const entryId =
          options.retryEntryId && selectedEntries.length === 1
            ? options.retryEntryId
            : uuid();
        if (!options.retryEntryId) {
          setBookshelfUploadQueue((queue) => [
            ...queue,
            {
              id: entryId,
              file,
              fileName: file.name,
              size: file.size,
              status: "queued",
              stage: "preparing",
              percent: 0,
              postprocessPercent: null,
              speedBps: 0,
              error: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ]);
        } else {
          patchBookshelfUpload(entryId, {
            status: "queued",
            stage: "preparing",
            percent: 0,
            postprocessPercent: null,
            speedBps: 0,
            error: null,
          });
        }

        const validation = validateReaderFile(file);
        if (!validation.ok) {
          patchBookshelfUpload(entryId, {
            status: "failed",
            stage: "failed",
            error: validation.error,
          });
          showToast(`${file.name}：${validation.error}`, "error");
          continue;
        }
        patchBookshelfUpload(entryId, {
          documentType: validation.documentType,
          status: "uploading",
          stage: "uploading",
        });

        const controller = new AbortController();
        uploadAbortControllersRef.current.set(entryId, controller);
        try {
          let duplicateAction = null;
          let uploadResult = null;
          while (!uploadResult) {
            const formData = new FormData();
            formData.append("file", file, file.name);
            if (workspace?.slug)
              formData.append("workspaceSlug", workspace.slug);
            const ignoredIds = readDeletedReaderDocumentIds().map(
              (entry) => entry.id
            );
            if (ignoredIds.length)
              formData.append(
                "ignoredReaderDocumentIds",
                JSON.stringify(ignoredIds)
              );
            if (duplicateAction)
              formData.append("duplicateAction", duplicateAction);
            try {
              uploadResult = await requestPriorityQueue.schedule(
                () =>
                  ReaderDocument.upload(null, formData, {
                    signal: controller.signal,
                    task: false,
                    onUploadProgress: (progress) => {
                      const uploadComplete = progress.percent >= 100;
                      patchBookshelfUpload(entryId, {
                        status: "uploading",
                        stage: uploadComplete
                          ? "server_processing"
                          : "uploading",
                        percent: progress.percent,
                        speedBps:
                          progress.speedBps || progress.averageSpeedBps || 0,
                        loaded: progress.loaded,
                        total: progress.total,
                      });
                    },
                  }),
                {
                  priority: "P1",
                  label: "reader:bookshelf-upload",
                  kind: "upload",
                  scope: {
                    route: "workspace-chat",
                    workspaceSlug: workspace?.slug || null,
                    surface: "reader-upload",
                    uploadEntryId: entryId,
                  },
                  policy: "visible",
                  signal: controller.signal,
                  dedupeKey: `reader:upload:${entryId}`,
                }
              );
              if (!uploadResult) {
                const error = new Error("Upload aborted");
                error.name = "AbortError";
                throw error;
              }
            } catch (error) {
              const duplicate = duplicateUploadPayload(error);
              if (!duplicate || duplicateAction === "continue") throw error;
              const confirmed = await confirmDuplicateReaderUpload(
                file.name,
                duplicate
              );
              if (!confirmed) {
                patchBookshelfUpload(entryId, {
                  status: "failed",
                  stage: "failed",
                  error: "已取消重复上传。",
                });
                uploadResult = { cancelled: true };
                break;
              }
              duplicateAction = "continue";
              patchBookshelfUpload(entryId, {
                status: "uploading",
                stage: "uploading",
                percent: 0,
                speedBps: 0,
                error: null,
              });
            }
          }
          if (uploadResult?.cancelled) continue;
          const { response, data } = uploadResult;
          patchBookshelfUpload(entryId, {
            status: "server_processing",
            stage: "server_processing",
            percent: 100,
            speedBps: 0,
          });
          if (!response.ok || !data?.success)
            throw new Error(data?.error || "上传失败");
          const item = bookshelfItemFromServerData(data);
          if (item) {
            const itemForAdd = {
              ...item,
              localPath: null,
              localSourceId: null,
              ...pendingReaderCategory("extracting", "等待自动分类"),
            };
            itemsToAdd.push(itemForAdd);
            addItemsToBookshelf([itemForAdd]);
            patchBookshelfUpload(entryId, {
              status: "postprocessing",
              stage: "postprocessing",
              readerDocumentId: itemForAdd.readerDocumentId,
              postprocess: data.postprocess || null,
            });
            void queueBookshelfPostprocess({
              item: itemForAdd,
              tasks: ["thumbnail", "classification"],
              uploadEntryId: entryId,
            });
          } else {
            patchBookshelfUpload(entryId, {
              status: "failed",
              stage: "failed",
              error: "上传成功，但书籍元数据不可用。",
            });
          }
        } catch (error) {
          const aborted = error?.name === "AbortError";
          patchBookshelfUpload(entryId, {
            status: "failed",
            stage: "failed",
            error: aborted ? "上传已取消。" : error.message || "上传失败",
          });
          showToast(`${file.name}：${error.message || "上传失败"}`, "error");
        } finally {
          uploadAbortControllersRef.current.delete(entryId);
        }
        if (index < selectedEntries.length - 1)
          await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      if (!itemsToAdd.length) return [];
      const next = addItemsToBookshelf(itemsToAdd);
      const addedKeys = new Set(
        itemsToAdd.map((item) =>
          item.branchId
            ? `${item.bookKey}:branch:${item.branchId}`
            : `${item.bookKey}:main`
        )
      );
      showToast(`已加入书架 ${itemsToAdd.length} 本书`, "success");
      return next.filter((item) => addedKeys.has(item.key));
    },
    [
      addItemsToBookshelf,
      bookshelfItemFromServerData,
      patchBookshelfUpload,
      queueBookshelfPostprocess,
      workspace?.slug,
    ]
  );

  const retryBookshelfUpload = useCallback(
    async (entryId) => {
      const entry = bookshelfUploadQueue.find((item) => item.id === entryId);
      if (!entry?.file) return [];
      return await uploadFilesToBookshelf([entry.file], {
        retryEntryId: entryId,
      });
    },
    [bookshelfUploadQueue, uploadFilesToBookshelf]
  );

  const uploadCurrentDocument = useCallback(async () => {
    if (!currentDocument?.file) {
      showToast("当前文档没有可上传的本地文件。", "warning");
      return;
    }
    const formData = new FormData();
    formData.append("file", currentDocument.file, currentDocument.file.name);
    const showUploadStatus = true;
    if (showUploadStatus)
      setDocxPreviewStatus({
        fileName: currentDocument.title,
        message: loadingMessageForDocumentType(currentDocument.documentType),
      });
    let response;
    let data;
    try {
      const result = await requestPriorityQueue.schedule(
        ({ signal }) =>
          ReaderDocument.upload(null, formData, {
            signal,
            task: false,
          }),
        {
          priority: "P1",
          label: "reader:current-document-upload",
          kind: "upload",
          scope: {
            route: "workspace-chat",
            workspaceSlug: workspace?.slug || null,
            surface: "reader-upload",
            localDocumentId: currentDocument.localDocumentId || null,
          },
          policy: "visible",
          dedupeKey: `reader:current-upload:${
            currentDocument.localDocumentId ||
            currentDocument.bookKey ||
            currentDocument.title
          }`,
        }
      );
      if (!result) return;
      response = result.response;
      data = result.data;
    } finally {
      if (showUploadStatus) setDocxPreviewStatus(null);
    }
    if (!response.ok || !data?.success) {
      showToast(data?.error || "上传服务器备份失败", "error");
      return;
    }
    await openServerDocumentData(data, {
      bookKey:
        currentDocument.bookKey || normalizeBookTitle(currentDocument.title),
      branchId: currentDocument.branchId || null,
      branchLabel: currentDocument.branchLabel || null,
      progress: currentDocument.progress,
      thumbnailDataUrl: currentDocument.thumbnailDataUrl,
    });
    showToast("已上传到服务器备份", "success");
  }, [currentDocument, openServerDocumentData, workspace?.slug]);

  const bindCurrentDocumentLocalPath = useCallback(
    async (absolutePath) => {
      if (!absolutePath?.trim()) return;
      const pathDocumentType = /\.docx$/i.test(absolutePath.trim())
        ? "docx"
        : /\.epub$/i.test(absolutePath.trim())
          ? "epub"
          : null;
      if (pathDocumentType) {
        setDocxPreviewStatus({
          fileName: absolutePath.trim().split(/[\\/]/).pop(),
          message: loadingMessageForDocumentType(pathDocumentType),
        });
      }
      let response;
      let data;
      try {
        const result = await ReaderDocument.fromLocalPath(
          null,
          absolutePath.trim()
        );
        response = result.response;
        data = result.data;
      } finally {
        if (pathDocumentType) setDocxPreviewStatus(null);
      }
      if (!response.ok || !data?.success) {
        showToast(data?.error || "绑定本地路径失败", "error");
        return;
      }
      const previous = currentDocument;
      if (previous?.source === "local") {
        deleteStoredReaderHistoryItem(
          null,
          null,
          historyItemFromDocument(previous)
        );
      }
      const doc = await openServerDocumentData(data, {
        progress: previous?.progress,
        thumbnailDataUrl: previous?.thumbnailDataUrl,
      });
      if (doc) {
        rememberDocument({
          ...doc,
          thumbnailDataUrl: previous?.thumbnailDataUrl || doc.thumbnailDataUrl,
        });
        showToast("已绑定本地路径", "success");
      }
    },
    [
      currentDocument,
      openServerDocumentData,
      historyItemFromDocument,
      rememberDocument,
    ]
  );

  const recordCurrentProgress = useCallback(
    (progress = null, options = {}) => {
      if (!currentDocument) return;
      const nextProgress = normalizedReaderProgress({
        ...progress,
        source: progress?.source || options.source || null,
        trusted:
          progress?.trusted === true || options.trustStartPosition === true,
        updatedAt: progress?.updatedAt || new Date().toISOString(),
      });
      upsertReaderBookMemory(
        historyItemFromDocument(currentDocument),
        nextProgress,
        {
          source: nextProgress.source,
          trustStartPosition: nextProgress.trusted === true,
        }
      );
      backupCurrentDocumentProgress(nextProgress);
      if (
        !options.force &&
        !hasSignificantProgressChange(currentDocument.progress, nextProgress)
      ) {
        return;
      }
      patchHistoryForDocument(currentDocument, { progress: nextProgress });
      if (readerClosingRef.current || options.skipCurrentDocumentPersist) {
        return;
      }
      const nextDocument = { ...currentDocument, progress: nextProgress };
      setCurrentDocument(nextDocument);
      persistDocument(nextDocument);
    },
    [
      backupCurrentDocumentProgress,
      currentDocument,
      historyItemFromDocument,
      patchHistoryForDocument,
      persistDocument,
    ]
  );

  const exitCurrentDocument = useCallback(
    (progress = null) => {
      abortReaderOpen();
      beginReaderCloseSuppression();
      if (currentDocument && progress)
        recordCurrentProgress(progress, {
          force: true,
          skipCurrentDocumentPersist: true,
        });
      setCurrentDocument(null);
      setPendingSelectionSources([]);
      setPendingTextSources([]);
      setFocusedReaderTextSource(null);
      clearReaderCurrentDocumentStorage();
      setDrawerOpenPersisted(true);
      setReaderObjectUrl(null);
    },
    [
      abortReaderOpen,
      beginReaderCloseSuppression,
      currentDocument,
      recordCurrentProgress,
      setDrawerOpenPersisted,
      setReaderObjectUrl,
      setPendingSelectionSources,
      setPendingTextSources,
    ]
  );

  const closeReader = useCallback(
    (progress = null) => {
      abortReaderOpen();
      beginReaderCloseSuppression();
      if (currentDocument && progress)
        recordCurrentProgress(progress, {
          force: true,
          skipCurrentDocumentPersist: true,
        });
      setDrawerOpenPersisted(false);
      setCurrentDocument(null);
      setPendingSelectionSources([]);
      setPendingTextSources([]);
      setFocusedReaderTextSource(null);
      clearReaderCurrentDocumentStorage();
      setReaderObjectUrl(null);
    },
    [
      abortReaderOpen,
      beginReaderCloseSuppression,
      currentDocument,
      recordCurrentProgress,
      setDrawerOpenPersisted,
      setReaderObjectUrl,
      setPendingSelectionSources,
      setPendingTextSources,
    ]
  );

  const openHistoryDocument = useCallback(
    async (historyItem, options = {}) => {
      if (!historyItem) return { ok: false };
      const rememberedItem = readerItemWithLatestBookMemory(historyItem);
      setDrawerSectionPersisted(options.origin || "history");
      const hasServerBackup = hasServerReaderDocument(rememberedItem);
      if (hasServerBackup) {
        const ok = await openUploadedHistoryItem(rememberedItem);
        if (ok) return { ok: true };
      }

      let localSourceFailed = false;
      if (!hasServerBackup && rememberedItem.localSourceId) {
        const localResult = await openLocalSourceDocument(rememberedItem);
        if (localResult.ok) return { ok: true };
        localSourceFailed = true;
      }
      if (
        !hasServerBackup &&
        (rememberedItem.localPath ||
          ["reader_upload", "local_path"].includes(rememberedItem.source))
      ) {
        const ok = await openUploadedHistoryItem(rememberedItem, {
          serverFallbackToast: localSourceFailed
            ? "本地文件不可用，已使用云端备份打开。"
            : null,
          allowLocalFallback: true,
        });
        if (ok) return { ok: true };
      }
      if (
        rememberedItem.source === "workspace_parsed" &&
        rememberedItem.workspaceDocPath
      ) {
        await openWorkspaceParsedDocument(
          rememberedItem.workspaceDocPath,
          rememberedItem.readerDocumentWorkspaceSlug ||
            rememberedItem.workspaceSlug ||
            workspace?.slug,
          rememberedItem
        );
        return { ok: true };
      }
      if (hasServerBackup) {
        showToast("云端文档暂时不可用，请稍后重试。", "warning");
        return { ok: false };
      }
      showToast("本地文档不可恢复，请重新选择文件。", "warning");
      return { ok: false, needsLocalFile: true };
    },
    [
      openReaderDocument,
      openLocalSourceDocument,
      openUploadedHistoryItem,
      openWorkspaceParsedDocument,
      setDrawerSectionPersisted,
      workspace?.slug,
    ]
  );

  const openBookshelfDocument = useCallback(
    async (bookshelfItem) => {
      if (!bookshelfItem) return { ok: false };
      setDrawerSectionPersisted("bookshelf");
      return await openHistoryDocument(bookshelfItem, { origin: "bookshelf" });
    },
    [openHistoryDocument, setDrawerSectionPersisted]
  );

  const clearReaderHistory = useCallback(() => {
    deleteReaderProgressBackup(readReaderHistory());
    setReaderHistory(clearStoredReaderHistory());
    showToast("已清空伴读历史记录", "success");
  }, []);

  const deleteReaderHistoryItem = useCallback((historyItem) => {
    deleteReaderProgressBackup(historyItem);
    setReaderHistory(deleteStoredReaderHistoryItem(null, null, historyItem));
    showToast("已删除历史记录", "success");
  }, []);

  const deleteReaderBookshelfItems = useCallback(
    async (items = []) => {
      const selectedItems = (Array.isArray(items) ? items : [items]).filter(
        Boolean
      );
      if (!selectedItems.length) return;

      const idsByWorkspace = new Map();
      for (const item of selectedItems) {
        const targetWorkspaceSlug =
          item.readerDocumentWorkspaceSlug || item.workspaceSlug || null;
        for (const readerDocumentId of [
          item.readerDocumentId,
          item.backupReaderDocumentId,
        ]) {
          if (!readerDocumentId) continue;
          if (!idsByWorkspace.has(targetWorkspaceSlug))
            idsByWorkspace.set(targetWorkspaceSlug, new Set());
          idsByWorkspace.get(targetWorkspaceSlug).add(readerDocumentId);
        }
      }

      const deleteTargets = Array.from(idsByWorkspace.entries()).flatMap(
        ([targetWorkspaceSlug, ids]) =>
          Array.from(ids).map((readerDocumentId) => ({
            targetWorkspaceSlug,
            readerDocumentId,
          }))
      );
      const optimisticDeletedIds = deleteTargets.map(
        (target) => target.readerDocumentId
      );
      rememberDeletedReaderDocumentIds(optimisticDeletedIds);
      const removableKeys = removableBookshelfKeysAfterReaderDelete(
        selectedItems,
        optimisticDeletedIds
      );
      const removableKeySet = new Set(removableKeys);
      const removableItems = selectedItems.filter((item) =>
        removableKeySet.has(readerLibraryItemKey(item))
      );

      if (removableKeys.length) {
        const nextBookshelf = deleteStoredReaderBookshelfItems(removableKeys);
        deleteReaderProgressBackup(removableItems);
        setReaderBookshelf(nextBookshelf);
      }

      if (optimisticDeletedIds.length) {
        const { bookshelf } =
          clearDeletedReaderDocumentIdsFromAllStorage(optimisticDeletedIds);
        setReaderBookshelf(bookshelf);

        if (
          currentDocument &&
          (optimisticDeletedIds.includes(currentDocument.readerDocumentId) ||
            optimisticDeletedIds.includes(
              currentDocument.backupReaderDocumentId
            ))
        ) {
          const readerDocumentId = optimisticDeletedIds.includes(
            currentDocument.readerDocumentId
          )
            ? null
            : currentDocument.readerDocumentId || null;
          const backupReaderDocumentId = optimisticDeletedIds.includes(
            currentDocument.backupReaderDocumentId
          )
            ? null
            : currentDocument.backupReaderDocumentId || null;
          const nextDocument = {
            ...currentDocument,
            readerDocumentId,
            backupReaderDocumentId,
            uploaded: !!(readerDocumentId || backupReaderDocumentId),
          };
          setCurrentDocument(nextDocument);
          persistDocument(nextDocument);
        }
      }

      for (const item of removableItems) {
        deleteStoredReaderHistoryItem(null, null, item);
      }
      await deleteReaderLocalSources(removableItems);
      setReaderHistory(readReaderHistory());

      const deleteResults = await Promise.all(
        deleteTargets.map(async ({ targetWorkspaceSlug, readerDocumentId }) => {
          try {
            const { response, data } = await ReaderDocument.delete(
              targetWorkspaceSlug,
              readerDocumentId,
              { timeoutMs: 15_000 }
            );
            if (response.ok && data?.success)
              return { ok: true, readerDocumentId };
            if (response.status === 404)
              return { ok: true, readerDocumentId, missing: true };
            return {
              ok: false,
              readerDocumentId,
              error: data?.error || readerDocumentId,
            };
          } catch (error) {
            if (error?.status === 404) {
              return { ok: true, readerDocumentId, missing: true };
            }
            return {
              ok: false,
              readerDocumentId,
              error: error?.message || readerDocumentId,
            };
          }
        })
      );
      const failedDeletes = deleteResults.filter((result) => !result.ok);

      if (failedDeletes.length) {
        showToast(
          `部分服务器备份删除失败，已先从本机书架隐藏 ${failedDeletes.length} 本书，后台稍后可重试。`,
          "warning"
        );
      } else {
        showToast(`已删除 ${removableItems.length} 本书`, "success");
      }
    },
    [currentDocument, persistDocument]
  );

  const createBookshelfCategory = useCallback((name) => {
    setReaderCategories(createReaderBookshelfCategory(name));
  }, []);

  const renameBookshelfCategory = useCallback((categoryId, name) => {
    setReaderCategories(renameReaderBookshelfCategory(categoryId, name));
  }, []);

  const deleteBookshelfCategory = useCallback((categoryId) => {
    const result = deleteReaderBookshelfCategory(
      categoryId,
      readReaderBookshelf()
    );
    setReaderCategories(result.categories);
    if (!result.ok) showToast(result.error, "warning");
    else showToast("已删除分类", "success");
    return result;
  }, []);

  const updateBookshelfItemCategory = useCallback(
    (item, categoryId) => {
      if (!item || !categoryId) return;
      const patch = manualReaderCategory(categoryId);
      patchStoredCategoryForItem(item, patch);
      showToast("已修改分类", "success");
    },
    [patchStoredCategoryForItem]
  );

  const reclassifyBookshelfItem = useCallback(
    (item) => {
      if (!item) return;
      const patch = pendingReaderCategory("extracting", "等待重新自动分类");
      patchStoredCategoryForItem(item, patch);
      void queueBookshelfPostprocess({
        item: { ...item, ...patch },
        tasks: ["classification"],
        intent: "manual",
      });
    },
    [patchStoredCategoryForItem, queueBookshelfPostprocess]
  );

  const updateCurrentDocumentThumbnail = useCallback(
    (thumbnailDataUrl) => {
      if (!thumbnailDataUrl || !currentDocument) return;
      if (readerClosingRef.current) return;
      const nextDocument = { ...currentDocument, thumbnailDataUrl };
      setCurrentDocument(nextDocument);
      persistDocument(nextDocument);
      patchHistoryForDocument(currentDocument, { thumbnailDataUrl });
    },
    [currentDocument, patchHistoryForDocument, persistDocument]
  );

  const citeSelection = useCallback(
    (selection) => {
      if (!selection?.selectedText) return;
      const signature = [
        selection.documentTitle,
        selection.locatorLabel,
        selection.textHash,
        selection.selectedText,
      ].join(":");
      const now = Date.now();
      if (
        signature === lastCitedRef.current.signature &&
        now - lastCitedRef.current.at < 1500
      ) {
        return;
      }
      lastCitedRef.current = { signature, at: now };
      let citedSource = null;
      setPendingTextSources((current) => {
        const sourceKey = readerTextSourceKey(selection);
        const existing = current.find(
          (source) => source.sourceKey === sourceKey
        );
        if (existing) {
          citedSource = existing;
          return current;
        }
        const textSource = tempTextSourceFromSelection(
          { ...selection, sourceKey },
          nextCitationNoRef.current
        );
        if (!textSource) return current;
        nextCitationNoRef.current += 1;
        citedSource = textSource;
        return [...current, textSource];
      });
      if (citedSource) showToast("已添加为临时 TXT 引用", "success");
      return citedSource;
    },
    [setPendingTextSources]
  );

  const value = useMemo(
    () => ({
      currentDocument,
      drawerOpen,
      setDrawerOpen,
      setDrawerSection: setDrawerSectionPersisted,
      openLocalFile,
      uploadCurrentDocument,
      bindCurrentDocumentLocalPath,
      openWorkspaceParsedDocument,
      citeSelection,
      closeReader,
      exitCurrentDocument,
      recordCurrentProgress,
      backupCurrentDocumentProgress,
      readerHistory,
      readerBookshelf,
      bookshelfUploadQueue,
      readerCategories,
      drawerInitialSection,
      openHistoryDocument,
      openBookshelfDocument,
      addHistoryItemsToBookshelf,
      uploadFilesToBookshelf,
      retryBookshelfUpload,
      removeBookshelfUpload,
      deleteReaderBookshelfItems,
      createBookshelfCategory,
      renameBookshelfCategory,
      deleteBookshelfCategory,
      updateBookshelfItemCategory,
      reclassifyBookshelfItem,
      localFileConflict,
      resolveLocalFileConflict,
      docxPreviewStatus,
      clearReaderHistory,
      deleteReaderHistoryItem,
      updateCurrentDocumentThumbnail,
      pendingReaderTextSources,
      hasPendingReaderTextSources: pendingReaderTextSources.some(
        (source) => source?.ocrStatus === "processing"
      ),
      focusedReaderTextSource,
      focusReaderTextSource,
      removePendingReaderTextSource,
      upsertPendingReaderTextSource,
      sourcesByTurn,
      workspace,
      threadSlug,
    }),
    [
      currentDocument,
      drawerOpen,
      setDrawerSectionPersisted,
      bindCurrentDocumentLocalPath,
      openLocalFile,
      addHistoryItemsToBookshelf,
      uploadCurrentDocument,
      openWorkspaceParsedDocument,
      citeSelection,
      clearReaderHistory,
      closeReader,
      backupCurrentDocumentProgress,
      deleteReaderHistoryItem,
      createBookshelfCategory,
      deleteReaderBookshelfItems,
      deleteBookshelfCategory,
      exitCurrentDocument,
      openBookshelfDocument,
      openHistoryDocument,
      recordCurrentProgress,
      readerHistory,
      readerBookshelf,
      bookshelfUploadQueue,
      readerCategories,
      reclassifyBookshelfItem,
      renameBookshelfCategory,
      retryBookshelfUpload,
      removeBookshelfUpload,
      drawerInitialSection,
      sourcesByTurn,
      localFileConflict,
      resolveLocalFileConflict,
      docxPreviewStatus,
      pendingReaderTextSources,
      focusedReaderTextSource,
      focusReaderTextSource,
      removePendingReaderTextSource,
      upsertPendingReaderTextSource,
      updateCurrentDocumentThumbnail,
      updateBookshelfItemCategory,
      workspace,
      threadSlug,
    ]
  );

  return (
    <DocumentReaderContext.Provider value={value}>
      {children}
    </DocumentReaderContext.Provider>
  );
}

export function useDocumentReader() {
  return useContext(DocumentReaderContext);
}
