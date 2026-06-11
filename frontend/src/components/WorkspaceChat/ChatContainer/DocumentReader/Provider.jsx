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
import { safeJsonParse } from "@/utils/request";
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
  hasSignificantProgressChange,
  manualReaderCategory,
  migrateReaderStorage,
  normalizeBookTitle,
  normalizeReaderCategoryPatch,
  normalizedReaderProgress,
  pendingReaderCategory,
  readerTextSourceKey,
  readReaderBookshelf,
  readReaderBookshelfCategories,
  readReaderHistory,
  readerItemWithLatestProgressBackup,
  readerSourcesStorageKey,
  readerStorageKey,
  renameReaderBookshelfCategory,
  READER_EVENT_ASSOCIATE_SELECTION,
  READER_EVENT_CONSUME_TEXT_SOURCES,
  READER_EVENT_OPEN_DRAWER,
  READER_EVENT_TURN_COMPLETED,
  tempTextSourceFromSelection,
  updateReaderBookshelfItem,
  updateReaderHistoryItem,
  upsertReaderProgressBackup,
  upsertReaderBookshelfItems,
  upsertReaderHistory,
  validateReaderFile,
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

const DocumentReaderContext = createContext(null);

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

function loadingMessageForDocumentType(documentType) {
  if (documentType === "docx") return "正在生成版式预览";
  if (documentType === "epub") return "正在准备 EPUB 阅读器...";
  return "正在上传并准备阅读...";
}

function uuid() {
  return crypto.randomUUID();
}

function retryableReaderOpenFailure(response = null, error = null) {
  if (error) return true;
  const status = Number(response?.status || 0);
  return !status || status >= 500;
}

export function DocumentReaderProvider({
  workspace,
  threadSlug = null,
  children,
}) {
  const storageKey = readerStorageKey(workspace?.slug, threadSlug);
  const sourcesKey = readerSourcesStorageKey(workspace?.slug, threadSlug);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [currentDocument, setCurrentDocument] = useState(null);
  const [, setPendingSelections] = useState([]);
  const [pendingReaderTextSources, setPendingReaderTextSources] = useState([]);
  const [focusedReaderTextSource, setFocusedReaderTextSource] = useState(null);
  const [sourcesByTurn, setSourcesByTurn] = useState({});
  const [readerHistory, setReaderHistory] = useState([]);
  const [readerBookshelf, setReaderBookshelf] = useState([]);
  const [readerCategories, setReaderCategories] = useState([]);
  const [drawerInitialSection, setDrawerInitialSection] = useState("history");
  const [localFileConflict, setLocalFileConflict] = useState(null);
  const [docxPreviewStatus, setDocxPreviewStatus] = useState(null);
  const objectUrlRef = useRef(null);
  const readerClosingRef = useRef(false);
  const postprocessQueueRef = useRef(new Set());
  const pendingSelectionsRef = useRef([]);
  const pendingReaderTextSourcesRef = useRef([]);
  const nextCitationNoRef = useRef(1);
  const lastCitedRef = useRef({ signature: "", at: 0 });
  const localFileConflictResolverRef = useRef(null);
  const pendingReaderOpenRef = useRef(null);

  const setReaderObjectUrl = useCallback((url = null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = url;
  }, []);

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
      thumbnailDataUrl:
        doc.thumbnailDataUrl || doc.metadata?.thumbnailDataUrl || null,
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
    if (!data?.content || !data?.metadata) return null;
    const title = data.metadata.originalName;
    return {
      source: data.metadata.source || "reader_upload",
      title,
      bookKey: normalizeBookTitle(title),
      branchId: null,
      branchLabel: null,
      documentType: data.content.documentType,
      size: data.metadata.size ?? null,
      readerDocumentId: data.metadata.readerDocumentId,
      backupReaderDocumentId: data.metadata.readerDocumentId,
      readerDocumentWorkspaceSlug:
        data.metadata.readerDocumentWorkspaceSlug || null,
      uploaded: true,
      progress: { label: "阅读进度", percent: 0, updatedAt: null },
    };
  }, []);

  const rememberDocument = useCallback(
    (doc) => {
      const item = historyItemFromDocument(doc);
      if (!item) return;
      setReaderHistory(upsertReaderHistory(null, null, item));
    },
    [historyItemFromDocument]
  );

  const addItemsToBookshelf = useCallback((items = []) => {
    const next = upsertReaderBookshelfItems(items);
    setReaderBookshelf(next);
    return next;
  }, []);

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
      return upsertReaderProgressBackup(item, progress);
    },
    [currentDocument, historyItemFromDocument]
  );

  const patchStoredThumbnailForItem = useCallback((item, thumbnailDataUrl) => {
    if (!item || !thumbnailDataUrl) return;
    setReaderBookshelf(updateReaderBookshelfItem(item, { thumbnailDataUrl }));
    const nextHistory = updateReaderHistoryItem(null, null, item, {
      thumbnailDataUrl,
    });
    setReaderHistory(nextHistory);
  }, []);

  const applyPostprocessResult = useCallback(
    (item, data = {}, options = {}) => {
      if (!item || !data?.success) return false;
      const key = item.key || `${item.bookKey}:main`;
      let latest = readReaderBookshelf().find((book) => book.key === key);
      if (!latest) return false;

      if (data.thumbnailDataUrl) {
        patchStoredThumbnailForItem(latest, data.thumbnailDataUrl);
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
    ]
  );

  const queueBookshelfPostprocess = useCallback(
    async ({ item, tasks = ["thumbnail", "classification"] }) => {
      if (!item) return;
      const readerDocumentId =
        item.readerDocumentId || item.backupReaderDocumentId || null;
      if (!readerDocumentId) return;
      const readerDocumentWorkspaceSlug =
        item.readerDocumentWorkspaceSlug || item.workspaceSlug || null;
      const key = `${readerDocumentId}:${tasks.slice().sort().join(",")}`;
      if (postprocessQueueRef.current.has(key)) return;
      postprocessQueueRef.current.add(key);
      try {
        const bookshelfKey = item.key || `${item.bookKey}:main`;
        const failClassification = (reason) => {
          const latest = readReaderBookshelf().find(
            (book) => book.key === bookshelfKey
          );
          if (!latest || latest.category?.source === "manual") return;
          patchStoredCategoryForItem(latest, fallbackReaderCategory(reason));
        };
        const current = readReaderBookshelf().find(
          (book) => book.key === bookshelfKey
        );
        if (!current) return;
        const categoryTasks = tasks.includes("classification");
        if (categoryTasks && current.category?.source !== "manual")
          markItemCategoryPending(current, "extracting", "等待后台自动分类");

        const categories = readReaderBookshelfCategories().map((category) => ({
          id: category.id,
          name: category.name,
        }));
        const { response } = await ReaderDocument.postprocess(
          readerDocumentWorkspaceSlug,
          readerDocumentId,
          { tasks, categories }
        );
        if (!response.ok) {
          if (categoryTasks) failClassification("后台分类启动失败。");
          return;
        }

        const startedAt = Date.now();
        let delayMs = 700;
        let completed = false;
        while (Date.now() - startedAt < 120_000) {
          await new Promise((resolve) => window.setTimeout(resolve, delayMs));
          const { response: statusResponse, data } =
            await ReaderDocument.postprocessStatus(
              readerDocumentWorkspaceSlug,
              readerDocumentId
            );
          if (!statusResponse.ok || !data?.success) {
            if (categoryTasks) failClassification("后台分类状态读取失败。");
            break;
          }
          const stillExists = applyPostprocessResult(current, data, {
            trackClassification: categoryTasks,
          });
          if (!stillExists) break;
          const pendingTasks = tasks.some((task) =>
            ["queued", "processing", "extracting", "classifying"].includes(
              data.tasks?.[task]?.status
            )
          );
          if (data.status === "complete" || !pendingTasks) {
            completed = true;
            break;
          }
          delayMs = Math.min(2_500, Math.floor(delayMs * 1.35));
        }
        if (!completed && categoryTasks)
          failClassification("后台分类等待超时。");
      } finally {
        postprocessQueueRef.current.delete(key);
      }
    },
    [
      applyPostprocessResult,
      markItemCategoryPending,
      patchStoredCategoryForItem,
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

  const persistDocument = useCallback(
    (doc) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify(compactDocumentForStorage(doc))
      );
    },
    [storageKey]
  );

  const persistSources = useCallback(
    (nextSources) => {
      localStorage.setItem(sourcesKey, JSON.stringify(nextSources || {}));
    },
    [sourcesKey]
  );

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
    async (data, historyItem = null) => {
      if (!data?.content || !data?.metadata) return null;
      readerClosingRef.current = false;
      const progressItem = readerItemWithLatestProgressBackup(historyItem);
      const readerDocumentId = data.metadata.readerDocumentId;
      let parsedContent = data.content;
      let objectUrl = null;
      let renderType = null;
      let previewWarning = data.warning || data.metadata.previewWarning || null;
      setReaderObjectUrl(null);
      if (
        data.content.documentType === "docx" &&
        data.metadata?.previewPdfUrl
      ) {
        const { response: previewResponse, blob: previewBlob } =
          await ReaderDocument.previewBlob(data.metadata.previewPdfUrl);
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
        const { response: blobResponse, blob } =
          await ReaderDocument.originalBlob(data.metadata.originalUrl);
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
              data.content?.documentType
            )) || data.content;
        }
      }

      const doc = {
        source: data.metadata.source || "reader_upload",
        readerDocumentId,
        backupReaderDocumentId: readerDocumentId,
        documentType: data.content.documentType,
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
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      setDrawerOpen(false);
      if (previewWarning) showToast(previewWarning, "warning");
      return doc;
    },
    [persistDocument, rememberDocument, setReaderObjectUrl]
  );

  const openReaderDocument = useCallback(
    async (readerDocumentId, historyItem = null, options = {}) => {
      if (!readerDocumentId) return;
      const readerDocumentWorkspaceSlug =
        historyItem?.readerDocumentWorkspaceSlug ||
        historyItem?.workspaceSlug ||
        null;
      let response;
      let data;
      let requestError = null;
      try {
        const result = await ReaderDocument.get(
          readerDocumentWorkspaceSlug,
          readerDocumentId
        );
        response = result.response;
        data = result.data;
      } catch (error) {
        requestError = error;
      }
      if (!response?.ok || !data?.success) {
        const message =
          data?.error || requestError?.message || "服务器伴读文档打开失败";
        if (retryableReaderOpenFailure(response, requestError)) {
          queuePendingReaderOpen(
            {
              kind: "server",
              readerDocumentId,
              historyItem,
            },
            message,
            options
          );
        } else {
          showToast(message, "error");
        }
        return null;
      }
      try {
        const opened = await openServerDocumentData(data, historyItem);
        if (opened) clearPendingReaderOpen("server", readerDocumentId);
        return opened;
      } catch (error) {
        queuePendingReaderOpen(
          {
            kind: "server",
            readerDocumentId,
            historyItem,
          },
          error.message || "服务器伴读文档打开失败",
          options
        );
        return null;
      }
    },
    [clearPendingReaderOpen, openServerDocumentData, queuePendingReaderOpen]
  );

  const reopenLocalPathDocument = useCallback(
    async (readerDocumentId, historyItem = null, options = {}) => {
      if (!readerDocumentId) return false;
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
          readerDocumentId
        );
        response = result.response;
        data = result.data;
      } catch (error) {
        requestError = error;
      }
      if (!response?.ok || !data?.success) {
        const message =
          data?.error || requestError?.message || "本地路径文档打开失败";
        if (retryableReaderOpenFailure(response, requestError)) {
          queuePendingReaderOpen(
            {
              kind: "localPath",
              readerDocumentId,
              historyItem,
            },
            message,
            options
          );
        } else {
          showToast(message, "warning");
        }
        return false;
      }
      try {
        const opened = await openServerDocumentData(data, historyItem);
        if (opened) clearPendingReaderOpen("localPath", readerDocumentId);
        return !!opened;
      } catch (error) {
        queuePendingReaderOpen(
          {
            kind: "localPath",
            readerDocumentId,
            historyItem,
          },
          error.message || "本地路径文档打开失败",
          options
        );
        return false;
      }
    },
    [clearPendingReaderOpen, openServerDocumentData, queuePendingReaderOpen]
  );

  const retryPendingReaderOpen = useCallback(() => {
    const pending = pendingReaderOpenRef.current;
    if (!pending || readerClosingRef.current || currentDocument) return;
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
  }, [currentDocument, openReaderDocument, reopenLocalPathDocument]);

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
    const ensureDocumentForJump = async (event) => {
      const source = event.detail || {};
      if (source.__readerJumpResolved || !source?.selectedText) return;
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
      setDrawerOpen(true);
      const opened = await openReaderDocument(sourceReaderDocumentId, {
        title: source.documentTitle,
        documentType: source.documentType,
        readerDocumentId: source.readerDocumentId,
        backupReaderDocumentId: source.backupReaderDocumentId,
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
  }, [currentDocument, openReaderDocument]);

  useEffect(() => {
    migrateReaderStorage(workspace?.slug, threadSlug);
    const storedSources = safeJsonParse(localStorage.getItem(sourcesKey), {});
    setSourcesByTurn(storedSources || {});
    setReaderHistory(readReaderHistory());
    setReaderBookshelf(readReaderBookshelf());
    setReaderCategories(readReaderBookshelfCategories());

    const stored = readerItemWithLatestProgressBackup(
      safeJsonParse(localStorage.getItem(storageKey), null)
    );
    if (!stored) return;
    if (stored.source === "local") {
      if (stored.backupReaderDocumentId) {
        showToast("本地文档不可恢复，已尝试使用服务器备份打开。", "info");
        openReaderDocument(stored.backupReaderDocumentId, stored);
      } else {
        showToast("本地文档不可恢复，请重新选择文件。", "warning");
        setDrawerOpen(true);
      }
      return;
    }
    if (stored.localPath && stored.readerDocumentId) {
      if (["docx", "epub"].includes(stored.documentType)) {
        setDocxPreviewStatus({
          fileName: stored.title,
          message: loadingMessageForDocumentType(stored.documentType),
        });
      }
      reopenLocalPathDocument(stored.readerDocumentId, stored).finally(() => {
        if (["docx", "epub"].includes(stored.documentType))
          setDocxPreviewStatus(null);
      });
      return;
    }
    if (stored.readerDocumentId) {
      if (["docx", "epub"].includes(stored.documentType)) {
        setDocxPreviewStatus({
          fileName: stored.title,
          message: loadingMessageForDocumentType(stored.documentType),
        });
      }
      openReaderDocument(stored.readerDocumentId, stored).finally(() => {
        if (["docx", "epub"].includes(stored.documentType))
          setDocxPreviewStatus(null);
      });
    }
  }, [
    openReaderDocument,
    reopenLocalPathDocument,
    sourcesKey,
    storageKey,
    migrateReaderStorage,
    threadSlug,
    workspace?.slug,
  ]);

  useEffect(() => {
    return () => {
      setReaderObjectUrl(null);
    };
  }, [setReaderObjectUrl]);

  useEffect(() => {
    const open = () => {
      readerClosingRef.current = false;
      setDrawerOpen(true);
    };
    window.addEventListener(READER_EVENT_OPEN_DRAWER, open);
    return () => window.removeEventListener(READER_EVENT_OPEN_DRAWER, open);
  }, []);

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
    async (historyItem) => {
      if (!historyItem) return false;
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
        if (historyItem.localPath && historyItem.readerDocumentId) {
          return await reopenLocalPathDocument(
            historyItem.readerDocumentId,
            historyItem
          );
        }
        if (historyItem.readerDocumentId) {
          const opened = await openReaderDocument(
            historyItem.readerDocumentId,
            historyItem
          );
          return !!opened;
        }
        if (historyItem.backupReaderDocumentId) {
          const opened = await openReaderDocument(
            historyItem.backupReaderDocumentId,
            historyItem
          );
          return !!opened;
        }
        return false;
      } finally {
        if (showDocumentLoadingStatus) setDocxPreviewStatus(null);
      }
    },
    [openReaderDocument, reopenLocalPathDocument]
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
      if (!options.addToBookshelf) setDrawerInitialSection("history");
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
        if (choice === "uploaded") {
          await openUploadedHistoryItem(existingUploaded);
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
        const { response, data } = await ReaderDocument.upload(null, formData);
        if (!response.ok || !data?.success)
          throw new Error(data?.error || "自动上传失败");
        const doc = await openServerDocumentData(data, {
          bookKey,
          branchId: options.branch ? `local-${localDocumentId}` : null,
          branchLabel: options.branch ? "本地分支" : null,
          progress: { label: "阅读进度", percent: 0, updatedAt: null },
        });
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
        showToast(
          `${error.message || "自动上传失败"}，已临时本地预览。`,
          "warning"
        );
      } finally {
        setDocxPreviewStatus(null);
      }
      const objectUrl = URL.createObjectURL(file);
      setReaderObjectUrl(objectUrl);
      const content = await parseFileByType(
        file,
        localDocumentId,
        validation.documentType
      );
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
        progress: { label: "阅读进度", percent: 0, updatedAt: null },
      };
      readerClosingRef.current = false;
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      if (options.addToBookshelf) {
        const item = {
          ...bookshelfItemFromDocument(doc),
        };
        addItemsToBookshelf([item]);
      }
      setDrawerOpen(false);
      return doc;
    },
    [
      addItemsToBookshelf,
      bookshelfItemFromDocument,
      findUploadedHistoryForTitle,
      openUploadedHistoryItem,
      openServerDocumentData,
      persistDocument,
      queueBookshelfPostprocess,
      rememberDocument,
      requestLocalFileConflictChoice,
      setReaderObjectUrl,
    ]
  );

  const uploadFilesToBookshelf = useCallback(
    async (files = []) => {
      const selectedFiles = Array.from(files || []).filter(Boolean);
      if (!selectedFiles.length) return [];
      const itemsToAdd = [];
      const postprocessTasks = [];
      for (const file of selectedFiles) {
        const validation = validateReaderFile(file);
        if (!validation.ok) {
          showToast(`${file.name}：${validation.error}`, "error");
          continue;
        }

        const bookKey = normalizeBookTitle(file.name);
        const existingItem = readReaderBookshelf().find(
          (item) => item.bookKey === bookKey && !item.branchId
        );
        if (
          existingItem?.readerDocumentId ||
          existingItem?.backupReaderDocumentId
        ) {
          const itemForAdd =
            existingItem.category?.source === "manual"
              ? existingItem
              : {
                  ...existingItem,
                  ...pendingReaderCategory("extracting", "等待自动分类"),
                };
          itemsToAdd.push(itemForAdd);
          const tasks = [];
          if (!existingItem.thumbnailDataUrl) tasks.push("thumbnail");
          if (existingItem.category?.source !== "manual")
            tasks.push("classification");
          if (tasks.length) postprocessTasks.push({ item: itemForAdd, tasks });
          continue;
        }

        const formData = new FormData();
        formData.append("file", file, file.name);
        setDocxPreviewStatus({
          fileName: file.name,
          message: loadingMessageForDocumentType(validation.documentType),
        });
        try {
          const { response, data } = await ReaderDocument.upload(
            null,
            formData
          );
          if (!response.ok || !data?.success)
            throw new Error(data?.error || "上传失败");
          const item = bookshelfItemFromServerData(data);
          if (item) {
            const itemForAdd = {
              ...item,
              ...pendingReaderCategory("extracting", "等待自动分类"),
            };
            itemsToAdd.push(itemForAdd);
            postprocessTasks.push({
              item: itemForAdd,
              tasks: ["thumbnail", "classification"],
            });
          }
        } catch (error) {
          showToast(`${file.name}：${error.message || "上传失败"}`, "error");
        } finally {
          setDocxPreviewStatus(null);
        }
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
      postprocessTasks.forEach((task) => {
        void queueBookshelfPostprocess(task);
      });
      return next.filter((item) => addedKeys.has(item.key));
    },
    [
      addItemsToBookshelf,
      bookshelfItemFromServerData,
      queueBookshelfPostprocess,
    ]
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
      const result = await ReaderDocument.upload(null, formData);
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
  }, [currentDocument, openServerDocumentData]);

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
        updatedAt: progress?.updatedAt || new Date().toISOString(),
      });
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
      patchHistoryForDocument,
      persistDocument,
    ]
  );

  const exitCurrentDocument = useCallback(
    (progress = null) => {
      readerClosingRef.current = true;
      if (currentDocument && progress)
        recordCurrentProgress(progress, {
          force: true,
          skipCurrentDocumentPersist: true,
        });
      setCurrentDocument(null);
      setPendingSelectionSources([]);
      setPendingTextSources([]);
      setFocusedReaderTextSource(null);
      setDrawerOpen(true);
      localStorage.removeItem(storageKey);
      setReaderObjectUrl(null);
    },
    [
      currentDocument,
      recordCurrentProgress,
      setReaderObjectUrl,
      setPendingSelectionSources,
      setPendingTextSources,
      storageKey,
    ]
  );

  const closeReader = useCallback(
    (progress = null) => {
      readerClosingRef.current = true;
      if (currentDocument && progress)
        recordCurrentProgress(progress, {
          force: true,
          skipCurrentDocumentPersist: true,
        });
      setDrawerOpen(false);
      setCurrentDocument(null);
      setPendingSelectionSources([]);
      setPendingTextSources([]);
      setFocusedReaderTextSource(null);
      localStorage.removeItem(storageKey);
      setReaderObjectUrl(null);
    },
    [
      currentDocument,
      recordCurrentProgress,
      setReaderObjectUrl,
      setPendingSelectionSources,
      setPendingTextSources,
      storageKey,
    ]
  );

  const openWorkspaceParsedDocument = useCallback(
    async (
      docPath,
      sourceWorkspaceSlug = workspace?.slug,
      historyItem = null
    ) => {
      if (!sourceWorkspaceSlug || !docPath) return;
      setDrawerInitialSection("history");
      const { response, data } = await ReaderDocument.fromWorkspace(
        sourceWorkspaceSlug,
        docPath
      );
      if (!response.ok || !data?.success) {
        showToast(data?.error || "解析文本预览打开失败", "error");
        return;
      }
      const progressItem = readerItemWithLatestProgressBackup(historyItem);
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
      readerClosingRef.current = false;
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      setDrawerOpen(false);
    },
    [persistDocument, rememberDocument, setReaderObjectUrl, workspace?.slug]
  );

  const openHistoryDocument = useCallback(
    async (historyItem, options = {}) => {
      if (!historyItem) return { ok: false };
      setDrawerInitialSection(options.origin || "history");
      if (
        historyItem.localPath ||
        ["reader_upload", "local_path"].includes(historyItem.source)
      ) {
        const ok = await openUploadedHistoryItem(historyItem);
        if (ok) return { ok: true };
      }
      if (
        historyItem.source === "workspace_parsed" &&
        historyItem.workspaceDocPath
      ) {
        await openWorkspaceParsedDocument(
          historyItem.workspaceDocPath,
          historyItem.readerDocumentWorkspaceSlug ||
            historyItem.workspaceSlug ||
            workspace?.slug,
          historyItem
        );
        return { ok: true };
      }
      if (
        historyItem.source === "local" &&
        historyItem.backupReaderDocumentId
      ) {
        await openReaderDocument(
          historyItem.backupReaderDocumentId,
          historyItem
        );
        return { ok: true };
      }
      showToast("本地文档不可恢复，请重新选择文件。", "warning");
      return { ok: false, needsLocalFile: true };
    },
    [
      openReaderDocument,
      openUploadedHistoryItem,
      openWorkspaceParsedDocument,
      workspace?.slug,
    ]
  );

  const openBookshelfDocument = useCallback(
    async (bookshelfItem) => {
      if (!bookshelfItem) return { ok: false };
      setDrawerInitialSection("bookshelf");
      return await openHistoryDocument(bookshelfItem, { origin: "bookshelf" });
    },
    [openHistoryDocument]
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

      const deletedIds = [];
      const failedDeletes = [];
      for (const [targetWorkspaceSlug, ids] of idsByWorkspace.entries()) {
        for (const readerDocumentId of ids) {
          const { response, data } = await ReaderDocument.delete(
            targetWorkspaceSlug,
            readerDocumentId
          );
          if (response.ok && data?.success) {
            deletedIds.push(readerDocumentId);
          } else {
            failedDeletes.push(data?.error || readerDocumentId);
          }
        }
      }

      const nextBookshelf = deleteStoredReaderBookshelfItems(
        selectedItems.map((item) => item.key)
      );
      deleteReaderProgressBackup(selectedItems);
      setReaderBookshelf(nextBookshelf);

      if (deletedIds.length) {
        const { bookshelf } =
          clearDeletedReaderDocumentIdsFromAllStorage(deletedIds);
        setReaderBookshelf(bookshelf);

        if (
          currentDocument &&
          (deletedIds.includes(currentDocument.readerDocumentId) ||
            deletedIds.includes(currentDocument.backupReaderDocumentId))
        ) {
          const readerDocumentId = deletedIds.includes(
            currentDocument.readerDocumentId
          )
            ? null
            : currentDocument.readerDocumentId || null;
          const backupReaderDocumentId = deletedIds.includes(
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

      for (const item of selectedItems) {
        deleteStoredReaderHistoryItem(null, null, item);
      }
      setReaderHistory(readReaderHistory());

      if (failedDeletes.length) {
        showToast(
          `已从书架移除，${failedDeletes.length} 个服务器备份删除失败。`,
          "warning"
        );
      } else {
        showToast(`已删除 ${selectedItems.length} 本书`, "success");
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
      readerCategories,
      drawerInitialSection,
      openHistoryDocument,
      openBookshelfDocument,
      addHistoryItemsToBookshelf,
      uploadFilesToBookshelf,
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
      readerCategories,
      reclassifyBookshelfItem,
      renameBookshelfCategory,
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
