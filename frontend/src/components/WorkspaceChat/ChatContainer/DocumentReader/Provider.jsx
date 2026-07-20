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
import ReaderLibrary from "@/models/readerLibrary";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import { AuthContext } from "@/AuthContext";
import { getAuthToken } from "@/utils/authTokenStorage";
import {
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
  writeReaderBookshelf,
  writeReaderAuthorityLibraryState,
  writeReaderBookshelfCategories,
  writeReaderCurrentDocument,
  writeReaderHistory,
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
  normalizeReaderDocumentLinks,
  normalizeReaderStorageItemLinks,
  parseReaderDocumentUrl,
} from "@/utils/chat/readerLinkMaintenance";
import { readerLibraryItemKey } from "@/utils/chat/readerLibraryPersistence";
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
import {
  readerOpenFailureDetails,
  readerOpenFailureResult,
} from "@/utils/chat/readerOpenFailure";
import { openReaderLocalSource } from "@/utils/chat/readerLocalSources";
import { useWorkspaceLayout } from "@/contexts/WorkspaceLayoutProvider";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { markTaskPerformance } from "@/utils/tasks/taskScheduler";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";
import { navigationLifecycle } from "@/utils/navigationLifecycle";
import {
  nextReaderPostprocessDelay,
  readerPostprocessIsForeground,
  readerPostprocessLockKey,
  readerPostprocessPollTimeoutMs,
  readerPostprocessScheduleOptions,
} from "./postprocessScheduling";

const DocumentReaderContext = createContext(null);
const READER_CLOSE_SUPPRESSION_MS = 1_200;
const READER_VISIBLE_THUMBNAIL_COUNT = 6;
const READER_DEV_CONTROL_EVENT = "athena-dev-control-reader-command";
const READER_DEV_CONTROL_RESULT_EVENT = "athena-dev-control-reader-result";
const READER_DEBUG_ACCESS_HEADER = "X-Athena-Reader-Debug-Grant";
const READER_DEV_CONTROL_ALLOWED_COMMANDS = new Set([
  "reader.ui.openDrawer",
  "reader.ui.openDocument",
  "reader.ui.jumpToPage",
  "reader.ui.refreshLibrary",
  "reader.ui.snapshot",
  "reader.library.hideMissing",
  "reader.memory.setPage",
  "reader.memory.clear",
  "reader.scope.cancelTasks",
  "reader.scope.markStale",
  "reader.cache.invalidate",
]);

function readerOpenDebug(stage, detail = {}) {
  if (typeof window === "undefined") return;
  const payload = {
    stage,
    at: Math.round(window.performance?.now?.() || Date.now()),
    ...detail,
  };
  window.dispatchEvent(
    new CustomEvent("athena-reader-open-stage", { detail: payload })
  );
  const debugEnabled =
    window.__ATHENA_READER_DEBUG__ === true ||
    window.localStorage?.getItem?.("athenaReaderDebug") === "true" ||
    window.location?.search?.includes("athenaReaderDebug=1");
  if (debugEnabled) console.debug("[reader:open]", payload);
}

function bestReaderOpenFailure(failures = []) {
  const usable = failures.filter(Boolean);
  return (
    usable.find(
      (failure) =>
        failure.status &&
        failure.status !== 404 &&
        failure.reason !== "aborted" &&
        failure.reason !== "stale-open"
    ) ||
    usable.find(
      (failure) =>
        failure.reason !== "aborted" && failure.reason !== "stale-open"
    ) ||
    usable[usable.length - 1] ||
    null
  );
}

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

function readerPostprocessNetworkTask({
  scheduleOptions,
  label,
  workspaceSlug = null,
  readerDocumentId = null,
  foreground = false,
}) {
  return {
    label,
    kind: "reader",
    priority: scheduleOptions.priority,
    policy: scheduleOptions.policy,
    resource: "network",
    emergency: scheduleOptions.emergency,
    intentRank: scheduleOptions.intentRank,
    protected: foreground,
    abortable: !foreground,
    dedupeKey: `${scheduleOptions.dedupeKey}:${label}`,
    scope: {
      route: "workspace-chat",
      workspaceSlug: workspaceSlug || null,
      readerDocumentId,
      surface: "reader-postprocess",
    },
  };
}

function readerPdfPreviewLabel(documentType = "docx") {
  return documentType === "markdown" ? "Markdown" : "DOCX";
}

function readerLibraryReconcileDebug(detail = {}) {
  if (typeof window === "undefined") return;
  const payload = {
    at: Math.round(window.performance?.now?.() || Date.now()),
    ...detail,
  };
  window.dispatchEvent(
    new CustomEvent("athena-reader-library-reconcile", { detail: payload })
  );
  const debugEnabled =
    window.__ATHENA_READER_DEBUG__ === true ||
    window.localStorage?.getItem?.("athenaReaderDebug") === "true" ||
    window.location?.search?.includes("athenaReaderDebug=1");
  if (debugEnabled) console.debug("[reader:library-reconcile]", payload);
}

function readerLifecycleScope(
  workspaceSlug = null,
  threadSlug = null,
  document = null
) {
  return {
    kind: "reader",
    route: "reader",
    surface: "reader",
    workspaceSlug: workspaceSlug || null,
    threadSlug: threadSlug || null,
    readerDocumentId:
      document?.readerDocumentId || document?.backupReaderDocumentId || null,
  };
}

function isValidReaderDevControlCommand(detail = {}) {
  if (detail?.center !== "developer-control") return false;
  if (!READER_DEV_CONTROL_ALLOWED_COMMANDS.has(detail?.command)) return false;
  const expiresAt = Number(detail.expiresAt || 0);
  if (expiresAt && Date.now() > expiresAt) return false;
  return true;
}

function readerDevDocumentId(scope = {}, params = {}) {
  return (
    scope.readerDocumentId ||
    params.readerDocumentId ||
    params.backupReaderDocumentId ||
    params.documentId ||
    null
  );
}

function readerDevPage(params = {}) {
  const raw = params.page || params.currentPage || params.pageNumber;
  const page = Math.max(1, Math.round(Number(raw) || 0));
  return Number.isFinite(page) && page > 0 ? page : null;
}

function readerDevDebugGrantHeaders(params = {}) {
  const debugGrantId =
    params.debugGrantId || params.readerDebugGrantId || params.grantId || null;
  return debugGrantId ? { [READER_DEBUG_ACCESS_HEADER]: debugGrantId } : null;
}

function readerDevJumpSource(document = {}, page = null, params = {}) {
  if (!page) return null;
  return {
    __devControl: true,
    readerDocumentId: document.readerDocumentId || params.readerDocumentId,
    backupReaderDocumentId:
      document.backupReaderDocumentId || params.backupReaderDocumentId,
    documentTitle: document.title || params.title || "",
    documentType: document.documentType || params.documentType || "pdf",
    selectedText: params.selectedText || "",
    locator: {
      type: "pdf-page",
      page,
      pageOffsetRatio: Number(params.pageOffsetRatio || 0) || 0,
    },
    locatorLabel: params.locatorLabel || `page ${page}`,
    position: {
      pageNumber: page,
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

function lightweightDocxPreviewContent(
  readerDocumentId,
  status = "pending",
  documentType = "docx"
) {
  return {
    schemaVersion: 1,
    readerDocumentId,
    documentType,
    blocks: [],
    previewMode: "pdf-preview-required",
    previewStatus: status,
  };
}

function loadingMessageForDocumentType(documentType) {
  if (documentType === "docx" || documentType === "markdown")
    return "正在生成版式预览";
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

function readerDocumentWorkspaceCandidates(item = {}, currentWorkspaceSlug) {
  const metadata = item?.metadata || {};
  const parsedUrl = [
    metadata?.originalUrl,
    metadata?.stream?.url,
    metadata?.stream?.streamUrl,
    metadata?.thumbnailUrl,
    item?.thumbnailUrl,
  ]
    .map(parseReaderDocumentUrl)
    .find(Boolean);
  const explicitWorkspaceSlug =
    item?.readerDocumentWorkspaceSlug ||
    item?.workspaceSlug ||
    metadata?.readerDocumentWorkspaceSlug ||
    parsedUrl?.workspaceSlug ||
    null;
  const knownStandalone =
    parsedUrl?.namespace === "standalone" && !explicitWorkspaceSlug;
  const candidates = knownStandalone
    ? [null, currentWorkspaceSlug]
    : [explicitWorkspaceSlug, currentWorkspaceSlug, null];
  const seen = new Set();
  return candidates
    .map((value) => value || null)
    .filter((value) => {
      const key = value || "__global__";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function readerCandidateFailureFromError(error) {
  const status = Number(
    error?.status ||
      error?.response?.status ||
      error?.details?.status ||
      error?.raw?.status ||
      0
  );
  const responseStatus = status >= 200 && status <= 599 ? status : 500;
  const raw = error?.raw && typeof error.raw === "object" ? error.raw : null;
  return {
    response: new Response(null, { status: responseStatus }),
    data: {
      success: false,
      error: raw?.error || raw?.message || error?.message || "request_failed",
      status: responseStatus,
    },
    error,
  };
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
    const uploadTask = options.profile === "upload";
    const displayTask = options.profile === "display";
    const prefetchTask = options.profile === "prefetch";
    const taskSurface = uploadTask
      ? "reader-thumbnail-upload-first"
      : displayTask
        ? "reader-thumbnail-display"
        : prefetchTask
          ? "reader-thumbnail-prefetch"
          : "reader-thumbnail-maintenance";
    const taskLabel = uploadTask
      ? "reader:thumbnail-upload-first"
      : displayTask
        ? "reader:thumbnail-display"
        : prefetchTask
          ? "reader:thumbnail-prefetch"
          : "reader:thumbnail-maintenance";
    const taskPriority = uploadTask
      ? "P0"
      : displayTask
        ? "P1"
        : prefetchTask
          ? "P3"
          : "P4";
    const taskPolicy = uploadTask
      ? "foreground"
      : displayTask
        ? "visible"
        : prefetchTask
          ? "prefetch"
          : "maintenance";
    const { response, blob } = await ReaderDocument.thumbnailBlob(
      thumbnailUrl,
      {
        communicationScene:
          uploadTask || displayTask || prefetchTask
            ? "reader-visible"
            : "reader-maintenance",
        task: {
          label: taskLabel,
          kind: "reader-thumbnail",
          priority: taskPriority,
          policy: taskPolicy,
          resource:
            uploadTask || displayTask || prefetchTask ? "network" : "idle",
          emergency: uploadTask,
          intentRank: uploadTask ? 2 : displayTask ? 3 : undefined,
          abortable: true,
          scope: {
            route: "reader",
            surface: taskSurface,
          },
        },
      }
    );
    if (response.ok && blob?.size > 0) return await blobToDataUrl(blob);
  } catch {}
  return null;
}

function valuesDiffer(a, b) {
  try {
    return JSON.stringify(a) !== JSON.stringify(b);
  } catch {
    return true;
  }
}

function normalizeReaderStoredItemsForLinks(items = [], workspaceSlug = null) {
  return (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .map((item) => normalizeReaderStorageItemLinks(item, workspaceSlug));
}

function repairReaderStoredLinks(workspaceSlug = null) {
  const bookshelf = readReaderBookshelf();
  const normalizedBookshelf = normalizeReaderStoredItemsForLinks(
    bookshelf,
    workspaceSlug
  );
  if (valuesDiffer(bookshelf, normalizedBookshelf))
    writeReaderBookshelf(normalizedBookshelf);

  const history = readReaderHistory();
  const normalizedHistory = normalizeReaderStoredItemsForLinks(
    history,
    workspaceSlug
  );
  if (valuesDiffer(history, normalizedHistory))
    writeReaderHistory(null, null, normalizedHistory);

  const currentDocument = readReaderCurrentDocument(null);
  if (currentDocument) {
    const normalizedCurrent = normalizeReaderStorageItemLinks(
      currentDocument,
      workspaceSlug
    );
    if (valuesDiffer(currentDocument, normalizedCurrent))
      writeReaderCurrentDocument(normalizedCurrent);
  }
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
    normalizeReaderStorageItemLinks(
      readReaderCurrentDocument(null),
      workspace?.slug || null
    )
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
  const [readerHistory, setReaderHistory] = useState(() => {
    repairReaderStoredLinks(workspace?.slug || null);
    return readReaderHistory();
  });
  const [readerBookshelf, setReaderBookshelf] = useState(() => {
    repairReaderStoredLinks(workspace?.slug || null);
    return readReaderBookshelf();
  });
  const [readerCategories, setReaderCategories] = useState(() =>
    readReaderBookshelfCategories()
  );
  const [bookshelfLoading, setBookshelfLoading] = useState(false);
  const [bookshelfUploadQueue, setBookshelfUploadQueue] = useState([]);
  const [drawerInitialSection, setDrawerInitialSection] = useState(
    initialDrawerState.section
  );
  const [workspaceDocuments, setWorkspaceDocuments] = useState(() =>
    Array.isArray(workspace?.documents) ? workspace.documents : null
  );
  const [workspaceDocumentsLoading, setWorkspaceDocumentsLoading] =
    useState(false);
  const [workspaceDocumentsError, setWorkspaceDocumentsError] = useState(null);
  const drawerSectionRef = useRef(initialDrawerState.section);
  const [localFileConflict, setLocalFileConflict] = useState(null);
  const [docxPreviewStatus, setDocxPreviewStatus] = useState(null);
  const objectUrlRef = useRef(null);
  const currentDocumentRef = useRef(null);
  const readerClosingRef = useRef(false);
  const readerCloseSuppressionUntilRef = useRef(0);
  const readerCloseSuppressionTimerRef = useRef(null);
  const postprocessQueueRef = useRef(new Map());
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
  const readerLibraryVisibleRefreshCountRef = useRef(0);
  const readerRouteKeyRef = useRef(
    `${workspace?.slug || ""}:${threadSlug || ""}`
  );
  const workspaceDocumentsRequestRef = useRef(0);
  const workspaceLayout = useWorkspaceLayout();
  const dispatchLayoutEvent = workspaceLayout?.dispatchLayoutEvent;

  useEffect(() => {
    currentDocumentRef.current = currentDocument;
  }, [currentDocument]);

  useEffect(() => {
    workspaceDocumentsRequestRef.current += 1;
    setWorkspaceDocuments(
      Array.isArray(workspace?.documents) ? workspace.documents : null
    );
    setWorkspaceDocumentsLoading(false);
    setWorkspaceDocumentsError(null);
  }, [workspace?.slug]);

  useEffect(() => {
    if (!Array.isArray(workspace?.documents)) return;
    setWorkspaceDocuments(workspace.documents);
    setWorkspaceDocumentsError(null);
  }, [workspace?.documents]);

  const loadWorkspaceDocuments = useCallback(async () => {
    const workspaceSlug = workspace?.slug || null;
    if (!workspaceSlug) return [];
    if (Array.isArray(workspaceDocuments)) return workspaceDocuments;

    const requestId = workspaceDocumentsRequestRef.current + 1;
    workspaceDocumentsRequestRef.current = requestId;
    setWorkspaceDocumentsLoading(true);
    setWorkspaceDocumentsError(null);
    try {
      const detail = await Workspace.bySlug(workspaceSlug, {
        communicationScene: "reader-open",
        task: readerOpenTask(
          "reader:hydrate-workspace-documents",
          workspaceSlug,
          { surface: "workspace-document-picker" }
        ),
      });
      if (
        workspaceDocumentsRequestRef.current !== requestId ||
        workspace?.slug !== workspaceSlug
      ) {
        return [];
      }
      if (!Array.isArray(detail?.documents)) {
        throw new Error("工作区文档列表暂时不可用");
      }
      setWorkspaceDocuments(detail.documents);
      return detail.documents;
    } catch (error) {
      if (workspaceDocumentsRequestRef.current !== requestId) return [];
      const message = error?.message || "工作区文档加载失败";
      setWorkspaceDocumentsError(message);
      return [];
    } finally {
      if (workspaceDocumentsRequestRef.current === requestId) {
        setWorkspaceDocumentsLoading(false);
      }
    }
  }, [workspace?.slug, workspaceDocuments]);

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
    navigationLifecycle.enter(
      readerLifecycleScope(workspace?.slug, threadSlug),
      {
        reason: "open-reader",
        active: false,
      }
    );
    const seq = readerOpenSeqRef.current + 1;
    readerOpenSeqRef.current = seq;
    readerOpenAbortRef.current?.abort();
    const controller = new AbortController();
    readerOpenAbortRef.current = controller;
    return { seq, signal: controller.signal };
  }, [threadSlug, workspace?.slug]);

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

  const historyItemFromDocument = useCallback(
    (doc) => {
      if (!doc) return null;
      const normalizedDoc = normalizeReaderStorageItemLinks(
        doc,
        workspace?.slug || null
      );
      return {
        source: normalizedDoc.source,
        title: normalizedDoc.title,
        bookKey:
          normalizedDoc.bookKey || normalizeBookTitle(normalizedDoc.title),
        branchId: normalizedDoc.branchId || null,
        branchLabel: normalizedDoc.branchLabel || null,
        documentType: normalizedDoc.documentType,
        size: normalizedDoc.metadata?.size ?? normalizedDoc.file?.size ?? null,
        readerDocumentId: normalizedDoc.readerDocumentId || null,
        backupReaderDocumentId: normalizedDoc.backupReaderDocumentId || null,
        readerDocumentWorkspaceSlug:
          normalizedDoc.readerDocumentWorkspaceSlug ||
          normalizedDoc.metadata?.readerDocumentWorkspaceSlug ||
          normalizedDoc.workspaceSlug ||
          null,
        workspaceDocPath:
          normalizedDoc.workspaceDocPath ||
          normalizedDoc.metadata?.workspaceDocPath,
        localDocumentId: normalizedDoc.localDocumentId || null,
        localPath:
          normalizedDoc.localPath || normalizedDoc.metadata?.localPath || null,
        localSourceId:
          normalizedDoc.localSourceId ||
          normalizedDoc.metadata?.localSourceId ||
          null,
        localSourceKind:
          normalizedDoc.localSourceKind ||
          normalizedDoc.metadata?.localSourceKind ||
          null,
        localFingerprint:
          normalizedDoc.localFingerprint ||
          normalizedDoc.metadata?.localFingerprint ||
          null,
        thumbnailDataUrl:
          normalizedDoc.thumbnailDataUrl ||
          normalizedDoc.thumbnailUrl ||
          normalizedDoc.metadata?.thumbnailUrl ||
          normalizedDoc.metadata?.thumbnailDataUrl ||
          null,
        uploaded: !!(
          normalizedDoc.readerDocumentId || normalizedDoc.backupReaderDocumentId
        ),
        progress: normalizedDoc.progress || { label: "阅读进度", percent: 0 },
      };
    },
    [workspace?.slug]
  );

  const bookshelfItemFromDocument = useCallback(
    (doc) => {
      const item = historyItemFromDocument(doc);
      if (!item) return null;
      return {
        ...item,
        readerDocumentWorkspaceSlug:
          item.readerDocumentWorkspaceSlug ||
          doc.readerDocumentWorkspaceSlug ||
          doc.metadata?.readerDocumentWorkspaceSlug ||
          null,
      };
    },
    [historyItemFromDocument]
  );

  const bookshelfItemFromServerData = useCallback((data) => {
    const normalizedData = normalizeReaderDocumentLinks(data, {
      workspaceSlug:
        data?.metadata?.readerDocumentWorkspaceSlug ||
        data?.readerDocumentWorkspaceSlug ||
        null,
    });
    if (!normalizedData?.metadata) return null;
    const title = normalizedData.metadata.originalName;
    const documentType =
      normalizedData.content?.documentType ||
      normalizedData.contentSummary?.documentType ||
      readerDocumentTypeFromMetadata(normalizedData.metadata);
    if (!documentType) return null;
    const classificationResult =
      normalizedData.postprocess?.tasks?.classification?.result ||
      normalizedData.classification ||
      null;
    const categoryPatch = classificationResult?.category
      ? normalizeReaderCategoryPatch(classificationResult)
      : {};
    const postprocessComplete =
      normalizedData.postprocess?.status === "complete";
    return {
      source: normalizedData.metadata.source || "reader_upload",
      title,
      bookKey: normalizeBookTitle(title),
      branchId: null,
      branchLabel: null,
      documentType,
      size: normalizedData.metadata.size ?? null,
      metadata: {
        ...normalizedData.metadata,
        documentType,
      },
      pdfManifest: normalizedData.metadata.pdfManifest || null,
      readerDocumentId: normalizedData.metadata.readerDocumentId,
      backupReaderDocumentId: normalizedData.metadata.readerDocumentId,
      readerDocumentWorkspaceSlug:
        normalizedData.metadata.readerDocumentWorkspaceSlug ||
        normalizedData.readerDocumentWorkspaceSlug ||
        null,
      thumbnailUrl: normalizedData.metadata.thumbnailUrl || null,
      thumbnailDataUrl: normalizedData.metadata.thumbnailDataUrl || null,
      uploaded: true,
      ...categoryPatch,
      category:
        categoryPatch.category || classificationResult?.category || null,
      postprocess: normalizedData.postprocess || null,
      postprocessPercent: postprocessComplete ? null : undefined,
      addedAt:
        normalizedData.metadata.createdAt ||
        normalizedData.metadata.updatedAt ||
        null,
      updatedAt:
        normalizedData.metadata.updatedAt ||
        normalizedData.metadata.createdAt ||
        null,
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

  const addItemsToBookshelf = useCallback(
    (items = []) => {
      const normalizedItems = Array.isArray(items) ? items : [items];
      const next = upsertReaderBookshelfItems(normalizedItems);
      setReaderBookshelf(next);
      if (normalizedItems.some((item) => item?.readerDocumentId)) {
        void ReaderLibrary.bootstrap(
          {
            bookshelf: normalizedItems,
            categories: readReaderBookshelfCategories(),
          },
          {
            priority: "P0",
            intentRank: 2,
            label: "reader:library-add-item",
            scope: {
              workspaceSlug: workspace?.slug || null,
              surface: "reader-library-add",
            },
          }
        ).then((result) => {
          if (!result?.data?.success) return;
          const authorityState = writeReaderAuthorityLibraryState(result.data);
          setReaderCategories(authorityState.categories);
          setReaderBookshelf(authorityState.bookshelf);
        });
      }
      return next;
    },
    [workspace?.slug]
  );

  const refreshLocalReaderLibraryState = useCallback(() => {
    repairReaderStoredLinks(workspace?.slug || null);
    setSourcesByTurn(readReaderSources({}) || {});
    setReaderHistory(readReaderHistory());
    setReaderBookshelf(readReaderBookshelf());
    setReaderCategories(readReaderBookshelfCategories());
  }, [workspace?.slug]);

  const syncAllServerBookshelves = useCallback(
    async (signal = null, options = {}) => {
      if (!(authToken || getAuthToken())) return readReaderBookshelf();
      const syncSeq = ++readerBookshelfServerSyncSeqRef.current;
      const localBookshelfBeforeReconcile = readReaderBookshelf();
      const localCategoriesBeforeReconcile = readReaderBookshelfCategories();
      const visible = options.visible === true;
      const taskOptions = {
        signal,
        priority: visible ? "P0" : "P4",
        policy: visible ? "foreground" : "maintenance",
        intentRank: visible ? 1 : undefined,
        emergency: visible,
        resource: visible ? "network" : "idle",
        label: "reader:library-authority",
        scope: {
          workspaceSlug: workspace?.slug || null,
          reason: options.reason || "reader-library-refresh",
        },
      };

      let result = await ReaderLibrary.list(taskOptions);
      if (
        !signal?.aborted &&
        syncSeq === readerBookshelfServerSyncSeqRef.current &&
        result?.data?.success &&
        !result.data.bookshelf.length &&
        localBookshelfBeforeReconcile.length
      ) {
        result = await ReaderLibrary.bootstrap(
          {
            bookshelf: localBookshelfBeforeReconcile,
            categories: localCategoriesBeforeReconcile,
          },
          {
            ...taskOptions,
            label: "reader:library-bootstrap",
          }
        );
      }

      if (
        signal?.aborted ||
        syncSeq !== readerBookshelfServerSyncSeqRef.current
      )
        return readReaderBookshelf();

      if (!result?.response?.ok || !result?.data?.success) {
        return readReaderBookshelf();
      }

      const authorityState = writeReaderAuthorityLibraryState(result.data);
      setReaderCategories(authorityState.categories);
      setReaderBookshelf(authorityState.bookshelf);
      const nextBookshelf = authorityState.bookshelf;
      readerLibraryReconcileDebug({
        reason: "authority-sync",
        workspaceSlug: workspace?.slug || null,
        localCount: localBookshelfBeforeReconcile.length,
        serverGlobalCount: 0,
        serverWorkspaceCount: 0,
        authorityCount: nextBookshelf.length,
        revision: result.data.revision || null,
        successfulScopes: ["reader-library-db"],
        normalizedCount: nextBookshelf.length,
        missingCount: nextBookshelf.filter(
          (item) => item.availability === "missing"
        ).length,
      });
      nextBookshelf
        .filter((item) => item.thumbnailUrl && !item.thumbnailDataUrl)
        .forEach((item, index) => {
          void thumbnailDataUrlFromUrl(item.thumbnailUrl, {
            profile:
              index < READER_VISIBLE_THUMBNAIL_COUNT ? "display" : "prefetch",
          }).then((dataUrl) => {
            if (!dataUrl) return;
            setReaderBookshelf(
              updateReaderBookshelfItem(item, { thumbnailDataUrl: dataUrl })
            );
          });
        });
      return nextBookshelf;
    },
    [authToken, workspace?.slug]
  );

  const refreshReaderLibraryFromPersistentSources = useCallback(
    async (reason = "refresh", signal = null) => {
      const visibleRefresh = [
        "route-open",
        "token-or-route",
        "drawer-open",
        "drawer-open-empty-retry",
      ].includes(reason);
      if (visibleRefresh) {
        readerLibraryVisibleRefreshCountRef.current += 1;
        setBookshelfLoading(true);
      }
      try {
        return await requestPriorityQueue.schedule(
          async () => {
            refreshLocalReaderLibraryState();
            try {
              await hydrateReaderLibraryNow();
            } catch {}
            if (signal?.aborted) return readReaderBookshelf();
            refreshLocalReaderLibraryState();
            const bookshelf = await syncAllServerBookshelves(signal, {
              visible: visibleRefresh,
              reason,
            });
            if (signal?.aborted) return bookshelf;
            refreshLocalReaderLibraryState();
            return bookshelf;
          },
          {
            priority: visibleRefresh ? "P0" : "P4",
            label: "reader:library-refresh",
            kind: "reader",
            scope: {
              route: "workspace-chat",
              workspaceSlug: workspace?.slug || null,
              surface: "reader-library",
            },
            policy: visibleRefresh ? "foreground" : "maintenance",
            intentRank: visibleRefresh ? 1 : undefined,
            emergency: visibleRefresh,
            resource: visibleRefresh ? "network" : "idle",
            communicationScene: visibleRefresh
              ? "reader-visible"
              : "reader-maintenance",
            signal,
            dedupeKey: `reader:library-refresh:${workspace?.slug || "global"}:${visibleRefresh ? "visible" : "maintenance"}`,
          }
        );
      } finally {
        if (visibleRefresh) {
          readerLibraryVisibleRefreshCountRef.current = Math.max(
            0,
            readerLibraryVisibleRefreshCountRef.current - 1
          );
          if (readerLibraryVisibleRefreshCountRef.current === 0) {
            setBookshelfLoading(false);
          }
        }
      }
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

  const thumbnailSrcForStorage = useCallback(
    async (thumbnailSrc, options = {}) => {
      return await thumbnailDataUrlFromUrl(thumbnailSrc, {
        profile: options.profile || "maintenance",
      });
    },
    []
  );

  const applyPostprocessResult = useCallback(
    async (item, data = {}, options = {}) => {
      if (!item || !data?.success) return false;
      const key = item.key || `${item.bookKey}:main`;
      let latest = readReaderBookshelf().find((book) => book.key === key);
      if (!latest) return false;

      const thumbnailSrc = data.thumbnailUrl || data.thumbnailDataUrl || null;
      if (thumbnailSrc) {
        const storageThumbnailSrc = await thumbnailSrcForStorage(thumbnailSrc, {
          profile: options.thumbnailProfile || "maintenance",
        });
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
      const baseTasks = Array.isArray(tasks) ? tasks : [];
      const previewCapable = ["docx", "markdown"].includes(item.documentType);
      const requestedTasks =
        item.documentType === "pdf"
          ? [...new Set([...baseTasks, "pdfManifest"])]
          : previewCapable &&
              (intent === "upload" ||
                intent === "open" ||
                baseTasks.includes("thumbnail"))
            ? [...new Set(["preview", ...baseTasks])]
            : baseTasks;
      const workspaceCandidates = readerDocumentWorkspaceCandidates(
        item,
        workspace?.slug
      );
      const workspaceSlugForTask = workspaceCandidates[0] || null;
      const scheduleOptions = readerPostprocessScheduleOptions({
        intent,
        workspaceSlug: workspaceSlugForTask,
        readerDocumentId,
      });
      const key = readerPostprocessLockKey({
        workspaceSlug: workspaceSlugForTask,
        readerDocumentId,
      });
      const foreground = readerPostprocessIsForeground(intent);
      const existingEntry = postprocessQueueRef.current.get(key);
      if (existingEntry) {
        if (!foreground || existingEntry.foreground)
          return existingEntry.promise;
        existingEntry.superseded = true;
        postprocessQueueRef.current.delete(key);
      }
      const queueEntry = {
        foreground,
        intent,
        promise: null,
        superseded: false,
      };
      postprocessQueueRef.current.set(key, queueEntry);
      const queueEntryIsCurrent = () =>
        postprocessQueueRef.current.get(key) === queueEntry;
      if (uploadEntryId) {
        patchBookshelfUpload(uploadEntryId, {
          status: "postprocessing",
          stage: "postprocessing",
          percent: 100,
          speedBps: 0,
        });
      }
      const queuePromise = requestPriorityQueue.schedule(
        async ({ signal }) => {
          try {
            const bookshelfKey = item.key || `${item.bookKey}:main`;
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
            let activePostprocessWorkspaceSlug = workspaceSlugForTask;
            let postprocessResult = null;
            for (const candidateWorkspaceSlug of workspaceCandidates) {
              postprocessResult = await ReaderDocument.postprocess(
                candidateWorkspaceSlug,
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
                  task: readerPostprocessNetworkTask({
                    scheduleOptions,
                    label: `${scheduleOptions.label}:start`,
                    workspaceSlug: candidateWorkspaceSlug,
                    readerDocumentId,
                    foreground,
                  }),
                }
              );
              if (postprocessResult?.response?.ok) {
                activePostprocessWorkspaceSlug = candidateWorkspaceSlug;
                break;
              }
              if (postprocessResult?.response?.status !== 404) break;
            }
            const { response, data } = postprocessResult || {};
            if (signal.aborted) return;
            if (!queueEntryIsCurrent()) return;
            if (!response?.ok) {
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
              if (!queueEntryIsCurrent()) return;
              const { response: statusResponse, data } =
                await ReaderDocument.postprocessStatus(
                  activePostprocessWorkspaceSlug,
                  readerDocumentId,
                  {
                    signal,
                    communicationScene: foreground
                      ? "reader-visible"
                      : "reader-maintenance",
                    task: readerPostprocessNetworkTask({
                      scheduleOptions,
                      label: `${scheduleOptions.label}:status`,
                      workspaceSlug: activePostprocessWorkspaceSlug,
                      readerDocumentId,
                      foreground,
                    }),
                  }
                );
              if (signal.aborted) break;
              if (!queueEntryIsCurrent()) return;
              if (!statusResponse.ok || !data?.success) {
                if (categoryTasks) failClassification("后台分类状态读取失败。");
                break;
              }
              const stillExists = await applyPostprocessResult(current, data, {
                trackClassification: categoryTasks,
                thumbnailProfile: intent === "upload" ? "upload" : undefined,
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
            if (postprocessQueueRef.current.get(key) === queueEntry)
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
          protected: foreground,
          abortable: !foreground,
          dedupeKey: scheduleOptions.dedupeKey,
          onAbort: () => {
            if (postprocessQueueRef.current.get(key) === queueEntry)
              postprocessQueueRef.current.delete(key);
          },
        }
      );
      queueEntry.promise = queuePromise;
      return await queuePromise;
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
            item.readerDocumentWorkspaceSlug ||
            item.workspaceSlug ||
            workspace?.slug ||
            null,
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
    [
      addItemsToBookshelf,
      queueBookshelfPostprocess,
      readerBookshelf,
      workspace?.slug,
    ]
  );

  const persistDocument = useCallback(
    (doc) => {
      const normalizedDoc = normalizeReaderStorageItemLinks(
        doc,
        workspace?.slug || null
      );
      clearReaderCurrentDocumentClearMarker();
      writeReaderCurrentDocument(compactDocumentForStorage(normalizedDoc));
    },
    [workspace?.slug]
  );

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
      data = normalizeReaderDocumentLinks(data, {
        readerDocumentId:
          data?.metadata?.readerDocumentId ||
          data?.readerDocumentId ||
          historyItem?.readerDocumentId ||
          historyItem?.backupReaderDocumentId ||
          null,
        workspaceSlug:
          data?.metadata?.readerDocumentWorkspaceSlug ||
          data?.readerDocumentWorkspaceSlug ||
          historyItem?.readerDocumentWorkspaceSlug ||
          historyItem?.workspaceSlug ||
          null,
      });
      const openContext = options.openContext || beginReaderOpen();
      const isCurrentOpen = () => readerOpenIsCurrent(openContext);
      const initialDocumentType = readerDocumentTypeFromData(data, historyItem);
      const canStreamPdf =
        initialDocumentType === "pdf" && readerPdfStreamUrl(data?.metadata);
      readerOpenDebug("server-data-start", {
        readerDocumentId:
          data?.metadata?.readerDocumentId ||
          data?.readerDocumentId ||
          historyItem?.readerDocumentId ||
          historyItem?.backupReaderDocumentId ||
          null,
        documentType: initialDocumentType,
        hasMetadata: !!data?.metadata,
        hasContent: !!data?.content,
        canStreamPdf: !!canStreamPdf,
        originalUrl: data?.metadata?.originalUrl || null,
        workspaceSlug:
          data?.metadata?.readerDocumentWorkspaceSlug ||
          data?.readerDocumentWorkspaceSlug ||
          historyItem?.readerDocumentWorkspaceSlug ||
          historyItem?.workspaceSlug ||
          null,
      });
      if (!isCurrentOpen()) return null;
      if (!data?.content && data?.readerDocumentId && !canStreamPdf) {
        const readerDocumentWorkspaceSlug =
          data.metadata?.readerDocumentWorkspaceSlug ||
          historyItem?.readerDocumentWorkspaceSlug ||
          historyItem?.workspaceSlug ||
          null;
        readerOpenDebug("server-data-content-fallback-start", {
          readerDocumentId: data.readerDocumentId,
          workspaceSlug: readerDocumentWorkspaceSlug,
        });
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
        if (!result) {
          readerOpenDebug("server-data-content-fallback-empty", {
            readerDocumentId: data.readerDocumentId,
            workspaceSlug: readerDocumentWorkspaceSlug,
          });
          return null;
        }
        if (!isCurrentOpen()) return null;
        if (result?.response?.ok && result?.data?.success) {
          readerOpenDebug("server-data-content-fallback-success", {
            readerDocumentId: data.readerDocumentId,
            workspaceSlug: readerDocumentWorkspaceSlug,
          });
          return openServerDocumentData(result.data, historyItem, {
            openContext,
          });
        }
        readerOpenDebug("server-data-content-fallback-failure", {
          readerDocumentId: data.readerDocumentId,
          workspaceSlug: readerDocumentWorkspaceSlug,
          status: result?.response?.status || 0,
          error: result?.data?.error || result?.data?.message || null,
        });
      }
      if (!data?.metadata || !isCurrentOpen()) {
        readerOpenDebug("server-data-missing-metadata", {
          hasMetadata: !!data?.metadata,
          isCurrent: isCurrentOpen(),
        });
        return null;
      }
      const readerDocumentId = data.metadata.readerDocumentId;
      const documentType = readerDocumentTypeFromData(data, historyItem);
      const content =
        data.content ||
        (documentType === "pdf" && readerPdfStreamUrl(data.metadata)
          ? lightweightPdfContent(readerDocumentId)
          : documentType === "docx"
            ? lightweightDocxPreviewContent(readerDocumentId, "pending")
            : null);
      if (!content) {
        readerOpenDebug("server-data-missing-content", {
          readerDocumentId,
          documentType,
          canStreamPdf: !!canStreamPdf,
          originalUrl: data?.metadata?.originalUrl || null,
        });
        return null;
      }
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
      readerOpenDebug("server-data-progress-item", {
        readerDocumentId,
        documentType,
        readerDocumentWorkspaceSlug:
          progressItem?.readerDocumentWorkspaceSlug || null,
        originalUrl: data?.metadata?.originalUrl || null,
        pagePreviewUrl: data?.metadata?.pagePreviewUrl || null,
        thumbnailUrl: data?.metadata?.thumbnailUrl || null,
      });
      let parsedContent = content;
      let objectUrl = null;
      let pdfData = null;
      let renderType = null;
      let previewWarning = data.warning || data.metadata.previewWarning || null;
      setReaderObjectUrl(null);
      const isPdfPreviewDocument = ["docx", "markdown"].includes(
        content.documentType
      );
      const previewLabel = readerPdfPreviewLabel(content.documentType);
      const previewWorkspaceSlug =
        progressItem?.readerDocumentWorkspaceSlug || workspace?.slug || null;
      const readerDebugHeaders = options.readerDebugHeaders || null;

      const loadPdfPreviewData = async (previewPdfUrl) => {
        if (!previewPdfUrl) return false;
        try {
          const { response: previewResponse, data: previewBytes } =
            await ReaderDocument.previewData(previewPdfUrl, {
              signal: openContext.signal,
              headers: readerDebugHeaders,
              task: readerOpenTask(
                "reader:preview-data",
                previewWorkspaceSlug,
                { readerDocumentId }
              ),
            });
          if (!isCurrentOpen()) return false;
          if (previewResponse.ok && previewBytes?.byteLength > 0) {
            pdfData = previewBytes;
            renderType = "pdf-preview";
            parsedContent = { ...content, previewMode: "pdf-preview" };
            previewWarning = null;
            return true;
          }
          previewWarning =
            previewWarning ||
            `${previewLabel} 版式预览文件暂不可用，正在重新生成。`;
          return false;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          readerOpenDebug("pdf-preview-data-failed", {
            readerDocumentId,
            documentType: content.documentType,
            status: error?.status || error?.response?.status || null,
            code: error?.code || null,
            message: error?.message || String(error),
          });
          previewWarning =
            previewWarning ||
            `${previewLabel} 版式预览暂不可用，正在重新生成。`;
          return false;
        }
      };

      const ensurePdfPreviewForOpen = async () => {
        if (!isPdfPreviewDocument) return null;
        setDocxPreviewStatus({
          fileName: data.metadata.originalName,
          message: `正在生成 ${previewLabel} 版式预览`,
        });
        try {
          const startResult = await ReaderDocument.postprocess(
            previewWorkspaceSlug,
            readerDocumentId,
            {
              tasks: ["preview"],
              intent: "open",
              force: true,
            },
            {
              signal: openContext.signal,
              communicationScene: "reader-visible",
              task: readerOpenTask(
                "reader:docx-preview-start",
                previewWorkspaceSlug,
                { readerDocumentId }
              ),
            }
          );
          if (!isCurrentOpen()) return null;
          if (!startResult?.response?.ok || !startResult?.data?.success) {
            previewWarning =
              startResult?.data?.error ||
              startResult?.data?.progress?.error ||
              startResult?.data?.metadata?.previewLastError ||
              startResult?.data?.metadata?.previewWarning ||
              previewWarning ||
              `${previewLabel} 版式预览生成启动失败。`;
            return null;
          }
          if (startResult?.data?.metadata?.previewPdfUrl)
            return startResult.data.metadata;

          const startedAt = Date.now();
          const pollTimeoutMs = readerPostprocessPollTimeoutMs({
            foreground: true,
            serverTimeoutMs:
              startResult?.data?.postprocessConfig?.autoPollTimeoutMs,
          });
          let delayMs = 700;
          while (
            !openContext.signal.aborted &&
            Date.now() - startedAt < pollTimeoutMs
          ) {
            await new Promise((resolve) => window.setTimeout(resolve, delayMs));
            if (!isCurrentOpen()) return null;
            const { response, data: statusData } =
              await ReaderDocument.postprocessStatus(
                previewWorkspaceSlug,
                readerDocumentId,
                {
                  signal: openContext.signal,
                  communicationScene: "reader-visible",
                  task: readerOpenTask(
                    "reader:docx-preview-status",
                    previewWorkspaceSlug,
                    { readerDocumentId }
                  ),
                }
              );
            if (!isCurrentOpen()) return null;
            if (!response.ok || !statusData?.success) {
              previewWarning =
                statusData?.error ||
                statusData?.metadata?.previewLastError ||
                statusData?.metadata?.previewWarning ||
                previewWarning ||
                `${previewLabel} 版式预览状态读取失败。`;
              return null;
            }
            if (statusData?.metadata?.previewPdfUrl) return statusData.metadata;
            const previewTask = statusData?.tasks?.preview;
            if (previewTask?.status === "failed") {
              previewWarning =
                previewTask?.error ||
                previewTask?.reason ||
                statusData?.metadata?.previewLastError ||
                statusData?.metadata?.previewWarning ||
                statusData?.progress?.error ||
                previewWarning ||
                `${previewLabel} 版式预览生成失败。`;
              return null;
            }
            if (statusData.status === "complete") break;
            delayMs = nextReaderPostprocessDelay(delayMs, {
              foreground: true,
              hidden:
                typeof document !== "undefined" &&
                document.visibilityState === "hidden",
            });
          }
          previewWarning =
            previewWarning ||
            `${previewLabel} 版式预览仍在生成中，请稍后重试。`;
          return null;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          previewWarning =
            error?.message ||
            previewWarning ||
            `${previewLabel} 版式预览生成失败。`;
          readerOpenDebug("pdf-preview-generation-failed", {
            readerDocumentId,
            documentType: content.documentType,
            status: error?.status || error?.response?.status || null,
            code: error?.code || null,
            message: error?.message || String(error),
          });
          return null;
        }
      };

      if (isPdfPreviewDocument) {
        await loadPdfPreviewData(data.metadata?.previewPdfUrl);
        if (!renderType) {
          const previewMetadata = await ensurePdfPreviewForOpen();
          if (previewMetadata?.previewPdfUrl) {
            data.metadata = {
              ...data.metadata,
              ...previewMetadata,
            };
            await loadPdfPreviewData(data.metadata.previewPdfUrl);
          }
        }
        if (!renderType) {
          const failed = Boolean(previewWarning);
          parsedContent = lightweightDocxPreviewContent(
            readerDocumentId,
            failed ? "failed" : "pending",
            content.documentType
          );
          renderType = failed ? "docx-preview-failed" : "docx-preview-pending";
          previewWarning =
            previewWarning || `正在生成 ${previewLabel} 版式预览，请稍后重试。`;
        }
      }

      if (!renderType && !isPdfPreviewDocument && data.metadata?.originalUrl) {
        if (content.documentType === "pdf") {
          objectUrl = readerPdfStreamUrl(data.metadata);
          renderType = "pdf-stream";
        } else {
          const { response: blobResponse, blob } =
            await ReaderDocument.originalBlob(data.metadata.originalUrl, {
              signal: openContext.signal,
              headers: readerDebugHeaders,
              task: readerOpenTask(
                "reader:original-blob",
                previewWorkspaceSlug,
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
        pdfData,
        pdfHeaders: readerDebugHeaders,
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
      readerOpenDebug("server-data-opened", {
        readerDocumentId,
        documentType: doc.documentType,
        renderType: doc.renderType || null,
        readerDocumentWorkspaceSlug: doc.readerDocumentWorkspaceSlug || null,
        originalUrl: doc.metadata?.originalUrl || null,
        objectUrl: doc.objectUrl || null,
      });
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

      let objectUrl = null;
      let renderType = null;
      let previewWarning = null;
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
      const content =
        validation.documentType === "docx"
          ? lightweightDocxPreviewContent(readerDocumentId, "failed")
          : await parseFileByType(
              file,
              readerDocumentId,
              validation.documentType
            );
      if (!isCurrentOpen()) return { ok: false, reason: "aborted" };
      if (validation.documentType === "docx") {
        previewWarning =
          "本地 DOCX 需要生成 PDF 版式预览后打开，请重新上传或重试云端打开。";
        renderType = "docx-preview-failed";
      } else {
        objectUrl = URL.createObjectURL(file);
        setReaderObjectUrl(objectUrl);
      }
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
        renderType,
        objectUrl,
        file,
        progress: normalizedReaderProgress(progressItem?.progress),
        thumbnailDataUrl: progressItem?.thumbnailDataUrl || null,
        previewWarning,
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
      const returnStatus = options.returnStatus === true;
      const openFailure = (failureOptions = {}) => {
        const failure = readerOpenFailureResult({
          readerDocumentId,
          workspaceSlug: workspace?.slug || null,
          ...failureOptions,
        });
        readerOpenDebug("failure", failure);
        return returnStatus ? failure : null;
      };
      if (!readerDocumentId)
        return openFailure({
          stage: "missing-reader-document-id",
          reason: "missing-reader-document-id",
          fallback: "服务器伴读文档缺少文档 ID",
        });
      const openContext = options.openContext || beginReaderOpen();
      const isCurrentOpen = () => readerOpenIsCurrent(openContext);
      const workspaceCandidates = readerDocumentWorkspaceCandidates(
        historyItem,
        workspace?.slug
      );
      let openedReaderDocumentWorkspaceSlug = workspaceCandidates[0] || null;
      let response;
      let data;
      let requestError = null;
      const detail =
        historyItem?.documentType === "pdf" ||
        historyItem?.metadata?.documentType === "pdf"
          ? "metadata"
          : "content";
      readerOpenDebug("start", {
        readerDocumentId,
        detail,
        workspaceCandidates,
        title: historyItem?.title || null,
      });
      try {
        const result = await requestPriorityQueue.schedule(
          async () => {
            let lastResult = null;
            let lastCandidateWorkspaceSlug = workspaceCandidates[0] || null;
            for (const candidateWorkspaceSlug of workspaceCandidates) {
              lastCandidateWorkspaceSlug = candidateWorkspaceSlug || null;
              readerOpenDebug("candidate-start", {
                readerDocumentId,
                detail,
                candidateWorkspaceSlug: candidateWorkspaceSlug || null,
              });
              try {
                lastResult = await ReaderDocument.get(
                  candidateWorkspaceSlug,
                  readerDocumentId,
                  {
                    detail,
                    freshSensitiveSession: detail === "metadata",
                    staleWhileRevalidate: detail !== "metadata",
                    signal: openContext.signal,
                    task: false,
                  }
                );
              } catch (error) {
                if (error?.name === "AbortError") throw error;
                lastResult = readerCandidateFailureFromError(error);
                readerOpenDebug("candidate-exception", {
                  readerDocumentId,
                  detail,
                  candidateWorkspaceSlug: candidateWorkspaceSlug || null,
                  status: lastResult.response.status,
                  error: lastResult.data.error || null,
                  fallbackToNextCandidate:
                    lastResult.response.status === 404 &&
                    workspaceCandidates.indexOf(candidateWorkspaceSlug) <
                      workspaceCandidates.length - 1,
                });
              }
              if (lastResult?.response?.ok && lastResult?.data?.success) {
                readerOpenDebug("candidate-success", {
                  readerDocumentId,
                  detail,
                  candidateWorkspaceSlug: candidateWorkspaceSlug || null,
                  status: lastResult.response.status || 200,
                  hasMetadata: !!lastResult.data?.metadata,
                  hasContent: !!lastResult.data?.content,
                });
                return {
                  ...lastResult,
                  readerDocumentWorkspaceSlug: candidateWorkspaceSlug,
                };
              }
              readerOpenDebug("candidate-failure", {
                readerDocumentId,
                detail,
                candidateWorkspaceSlug: candidateWorkspaceSlug || null,
                status: lastResult?.response?.status || 0,
                error: lastResult?.data?.error || null,
                success: lastResult?.data?.success === true,
              });
              if (lastResult?.response?.status !== 404) break;
            }
            return {
              ...lastResult,
              readerDocumentWorkspaceSlug: lastCandidateWorkspaceSlug,
            };
          },
          {
            priority: "P0",
            label: "reader:open-document",
            kind: "reader",
            scope: {
              route: "workspace-chat",
              workspaceSlug: workspaceCandidates[0] || workspace?.slug || null,
              readerDocumentId,
              surface: "reader-open",
            },
            policy: "foreground",
            emergency: true,
            intentRank: 0,
            signal: openContext.signal,
            dedupeKey: `reader:open:${
              workspaceCandidates[0] || workspace?.slug || "global"
            }:${readerDocumentId}`,
          }
        );
        if (!result)
          return openFailure({
            stage: "scheduler-empty-result",
            reason: "scheduler-empty-result",
            fallback: "服务器伴读文档请求没有返回结果",
          });
        response = result.response;
        data = result.data;
        openedReaderDocumentWorkspaceSlug =
          result.readerDocumentWorkspaceSlug || null;
      } catch (error) {
        if (error?.name === "AbortError")
          return openFailure({
            stage: "aborted",
            reason: "aborted",
            error,
            extra: { retryable: false, terminal: false },
            fallback: "服务器伴读文档打开已取消",
          });
        requestError = error;
      }
      if (!isCurrentOpen())
        return openFailure({
          stage: "stale-open",
          reason: "stale-open",
          extra: { retryable: false, terminal: false },
          fallback: "服务器伴读文档打开已被新的操作替代",
        });
      if (
        data?.metadata &&
        openedReaderDocumentWorkspaceSlug &&
        !data.metadata.readerDocumentWorkspaceSlug
      ) {
        data = {
          ...data,
          metadata: {
            ...data.metadata,
            readerDocumentWorkspaceSlug: openedReaderDocumentWorkspaceSlug,
          },
        };
      }
      if (!response?.ok || !data?.success) {
        const failure = readerOpenFailureResult({
          stage: "metadata",
          response,
          data,
          requestError,
          fallback: "服务器伴读文档打开失败",
          readerDocumentId,
          workspaceSlug: workspace?.slug || null,
          candidateWorkspaceSlug: openedReaderDocumentWorkspaceSlug,
        });
        readerOpenDebug("metadata-failure", failure);
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
        return returnStatus ? failure : null;
      }
      try {
        const opened = await openServerDocumentData(data, historyItem, {
          openContext,
        });
        if (!isCurrentOpen())
          return openFailure({
            stage: "stale-after-render",
            reason: "stale-after-render",
            extra: { retryable: false, terminal: false },
            fallback: "服务器伴读文档打开已被新的操作替代",
          });
        if (opened) {
          markTaskPerformance("reader_target_ready", {
            readerDocumentId,
            workspaceSlug: openedReaderDocumentWorkspaceSlug || workspace?.slug,
          });
          clearPendingReaderOpen("server", readerDocumentId);
          readerOpenDebug("success", {
            readerDocumentId,
            workspaceSlug:
              openedReaderDocumentWorkspaceSlug || workspace?.slug || null,
            documentType: opened.documentType || null,
            renderType: opened.renderType || null,
          });
          return returnStatus
            ? {
                ok: true,
                opened,
                status: response?.status || 200,
                readerDocumentId,
                workspaceSlug:
                  openedReaderDocumentWorkspaceSlug || workspace?.slug || null,
              }
            : opened;
        }
        const failure = readerOpenFailureResult({
          stage: "render",
          error: new Error("Reader document metadata cannot be rendered."),
          fallback: "服务器伴读文档元数据不可用",
          readerDocumentId,
          workspaceSlug: workspace?.slug || null,
          candidateWorkspaceSlug: openedReaderDocumentWorkspaceSlug,
        });
        readerOpenDebug("render-failure", failure);
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
        return returnStatus ? failure : null;
      } catch (error) {
        if (error?.name === "AbortError")
          return openFailure({
            stage: "render-aborted",
            reason: "aborted",
            error,
            extra: { retryable: false, terminal: false },
            fallback: "服务器伴读文档打开已取消",
          });
        if (!isCurrentOpen())
          return openFailure({
            stage: "stale-render-error",
            reason: "stale-render-error",
            extra: { retryable: false, terminal: false },
            fallback: "服务器伴读文档打开已被新的操作替代",
          });
        const failure = readerOpenFailureResult({
          stage: "render-error",
          error,
          fallback: "服务器伴读文档打开失败",
          readerDocumentId,
          workspaceSlug: workspace?.slug || null,
          candidateWorkspaceSlug: openedReaderDocumentWorkspaceSlug,
        });
        readerOpenDebug("render-error", failure);
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
        return returnStatus ? failure : null;
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
      const alreadyOpen = currentDocumentRef.current;
      if (
        alreadyOpen?.source === "workspace_parsed" &&
        alreadyOpen.workspaceDocPath === docPath &&
        alreadyOpen.readerDocumentWorkspaceSlug === sourceWorkspaceSlug
      ) {
        return alreadyOpen;
      }
      readerOpenDebug("workspace-parsed-start", {
        docPath,
        sourceWorkspaceSlug,
        reason: options.reason || (historyItem ? "history" : "picker"),
      });
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
      currentDocumentRef.current = doc;
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      setDrawerOpenPersisted(false);
      return doc;
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
      if (!historyItem)
        return options.returnStatus
          ? {
              ok: false,
              reason: "missing-history-item",
              message: "缺少伴读历史记录",
              retryable: false,
            }
          : false;
      const openContext = options.openContext || beginReaderOpen();
      const isCurrentOpen = () => readerOpenIsCurrent(openContext);
      const failures = [];
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
          const openResult = await openReaderDocument(
            readerDocumentId,
            { ...historyItem, localPath: null, localSourceId: null },
            {
              suppressTerminalToast: true,
              openContext,
              returnStatus: true,
            }
          );
          if (!isCurrentOpen())
            return options.returnStatus
              ? {
                  ok: false,
                  reason: "aborted",
                  retryable: false,
                  message: "伴读打开已被新的操作替代",
                  failures,
                }
              : false;
          if (!openResult?.ok) {
            if (openResult) failures.push(openResult);
            continue;
          }
          const opened = openResult.opened;
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
          return options.returnStatus
            ? { ok: true, opened, readerDocumentId }
            : true;
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
          if (!isCurrentOpen())
            return options.returnStatus
              ? {
                  ok: false,
                  reason: "aborted",
                  retryable: false,
                  message: "伴读打开已被新的操作替代",
                  failures,
                }
              : false;
          if (localPathResult.ok)
            return options.returnStatus ? localPathResult : true;
          if (localPathResult) failures.push(localPathResult);
          if (localPathResult.retryable)
            return options.returnStatus
              ? {
                  ...localPathResult,
                  failures,
                }
              : false;
        }
        if (options.returnStatus) {
          const failure = bestReaderOpenFailure(failures);
          return {
            ok: false,
            ...(failure || {
              reason: "no-open-candidate",
              message: "云端文档暂时不可用，请稍后重试。",
              retryable: true,
            }),
            failures,
          };
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
            intent: "upload",
          });
        }
        return doc;
      } catch (error) {
        if (error?.name === "AbortError" || !isCurrentOpen()) return;
        showToast(
          validation.documentType === "docx"
            ? `${error.message || "自动上传失败"}，请重试生成 DOCX 版式预览。`
            : `${error.message || "自动上传失败"}，已临时本地预览。`,
          "warning"
        );
      } finally {
        setDocxPreviewStatus(null);
      }
      if (!isCurrentOpen()) return;
      let objectUrl = null;
      let renderType = null;
      let previewWarning = null;
      const content =
        validation.documentType === "docx"
          ? lightweightDocxPreviewContent(localDocumentId, "failed")
          : await parseFileByType(
              file,
              localDocumentId,
              validation.documentType
            );
      if (!isCurrentOpen()) return;
      if (validation.documentType === "docx") {
        renderType = "docx-preview-failed";
        previewWarning =
          "DOCX 需要生成 PDF 版式预览后打开。系统不会自动使用会打乱格式的 HTML 预览。";
      } else {
        objectUrl = URL.createObjectURL(file);
        setReaderObjectUrl(objectUrl);
      }
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
        renderType,
        objectUrl,
        file,
        progress: normalizedReaderProgress(progressItem?.progress),
        previewWarning,
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
              const uploadAction = optimisticActionCenter.run({
                type: "reader.bookshelf.upload",
                scope: {
                  route: "workspace-chat",
                  workspaceSlug: workspace?.slug || null,
                  surface: "reader-upload",
                  uploadEntryId: entryId,
                },
                priority: "P1",
                policy: "visible",
                resource: "upload",
                protected: true,
                abortable: true,
                signal: controller.signal,
                label: "optimistic:reader-bookshelf-upload",
                dedupeKey: `reader:upload:${entryId}`,
                rollbackPatch: () => {
                  if (controller.signal.aborted) return;
                  patchBookshelfUpload(entryId, {
                    status: "failed",
                    stage: "failed",
                    error: "上传失败。",
                  });
                },
                serverCall: async ({ signal }) =>
                  await ReaderDocument.upload(null, formData, {
                    signal,
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
              });
              const uploadOutcome = await uploadAction.promise;
              if (!uploadOutcome.ok)
                throw uploadOutcome.error || new Error("Upload failed");
              uploadResult = uploadOutcome.result;
              if (!uploadResult) throw new Error("Upload failed");
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
              intent: "upload",
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
      navigationLifecycle.leave(
        readerLifecycleScope(workspace?.slug, threadSlug, currentDocument),
        {
          reason: "close-reader",
          extraScopes: [
            { surface: "reader-open", workspaceSlug: workspace?.slug || null },
            {
              surface: "reader-postprocess",
              workspaceSlug: workspace?.slug || null,
            },
            {
              surface: "reader-upload",
              workspaceSlug: workspace?.slug || null,
            },
          ],
        }
      );
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
      threadSlug,
      workspace?.slug,
    ]
  );

  const closeReader = useCallback(
    (progress = null) => {
      navigationLifecycle.leave(
        readerLifecycleScope(workspace?.slug, threadSlug, currentDocument),
        {
          reason: "close-reader",
          extraScopes: [
            { surface: "reader-open", workspaceSlug: workspace?.slug || null },
            {
              surface: "reader-postprocess",
              workspaceSlug: workspace?.slug || null,
            },
            {
              surface: "reader-upload",
              workspaceSlug: workspace?.slug || null,
            },
          ],
        }
      );
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
      threadSlug,
      workspace?.slug,
    ]
  );

  const findReaderDevItem = useCallback(
    (readerDocumentId) => {
      if (!readerDocumentId) return null;
      const matches = (item) =>
        item?.readerDocumentId === readerDocumentId ||
        item?.backupReaderDocumentId === readerDocumentId;
      return (
        readerBookshelf.find(matches) ||
        readerHistory.find(matches) ||
        readReaderBookshelf().find(matches) ||
        readReaderHistory().find(matches) ||
        null
      );
    },
    [readerBookshelf, readerHistory]
  );

  const publishReaderDevResult = useCallback((result = {}) => {
    if (typeof window === "undefined") return result;
    const payload = {
      at: Date.now(),
      ...result,
    };
    window.__athenaReaderDevControlLastResult = payload;
    window.dispatchEvent(
      new CustomEvent(READER_DEV_CONTROL_RESULT_EVENT, { detail: payload })
    );
    return payload;
  }, []);

  const readerDevSnapshot = useCallback(
    () => ({
      drawerOpen,
      drawerSection: drawerSectionRef.current,
      currentDocument: currentDocument
        ? {
            readerDocumentId:
              currentDocument.readerDocumentId ||
              currentDocument.backupReaderDocumentId ||
              null,
            documentType: currentDocument.documentType || null,
            renderType: currentDocument.renderType || null,
            progress: currentDocument.progress || null,
            hasContent: !!currentDocument.content,
            hasMetadata: !!currentDocument.metadata,
          }
        : null,
      bookshelfCount: readerBookshelf.length,
      historyCount: readerHistory.length,
      uploadQueueCount: bookshelfUploadQueue.length,
    }),
    [
      bookshelfUploadQueue.length,
      currentDocument,
      drawerOpen,
      readerBookshelf.length,
      readerHistory.length,
    ]
  );

  const recordReaderDevPage = useCallback(
    (readerDocumentId, page, params = {}) => {
      if (!page) return null;
      const progress = normalizedReaderProgress({
        ...(currentDocument?.progress || {}),
        label: params.locatorLabel || `page ${page}`,
        source: "dev-control",
        trusted: true,
        updatedAt: new Date().toISOString(),
        locator: {
          type: "pdf-page",
          page,
          pageOffsetRatio: Number(params.pageOffsetRatio || 0) || 0,
        },
      });
      const currentReaderDocumentId =
        currentDocument?.readerDocumentId ||
        currentDocument?.backupReaderDocumentId ||
        null;
      if (currentDocument && currentReaderDocumentId === readerDocumentId) {
        recordCurrentProgress(progress, {
          force: true,
          source: "dev-control",
          trustStartPosition: true,
        });
        return progress;
      }

      const item = findReaderDevItem(readerDocumentId);
      if (!item) return progress;
      upsertReaderBookMemory(item, progress, {
        source: "dev-control",
        trustStartPosition: true,
      });
      upsertReaderProgressBackup(item, progress);
      setReaderHistory(updateReaderHistoryItem(null, null, item, { progress }));
      setReaderBookshelf(updateReaderBookshelfItem(item, { progress }));
      return progress;
    },
    [currentDocument, findReaderDevItem, recordCurrentProgress]
  );

  useEffect(() => {
    const runReaderDevCommand = async (event) => {
      const detail = event.detail || {};
      if (!isValidReaderDevControlCommand(detail)) return;
      const command = detail.command;
      const scope = detail.scope || {};
      const params = detail.params || {};
      const commandId = detail.commandId || null;
      const requestId = detail.requestId || detail.sourceRequestId || null;
      const respond = (patch = {}) =>
        publishReaderDevResult({
          command,
          commandId,
          requestId,
          success: patch.success !== false,
          ...patch,
        });

      try {
        if (command === "reader.ui.openDrawer") {
          const section = params.section || "bookshelf";
          setDrawerSectionPersisted(section, { open: true });
          setDrawerOpenPersisted(true, { section });
          return respond({
            status: "drawer_opened",
            snapshot: readerDevSnapshot(),
          });
        }

        if (
          command === "reader.ui.refreshLibrary" ||
          command === "reader.library.hideMissing" ||
          command === "reader.cache.invalidate"
        ) {
          const section = params.section || "bookshelf";
          setDrawerSectionPersisted(section, { open: true });
          setDrawerOpenPersisted(true, { section });
          await refreshReaderLibraryFromPersistentSources("drawer-open");
          refreshLocalReaderLibraryState();
          return respond({
            status: "library_refreshed",
            snapshot: readerDevSnapshot(),
          });
        }

        if (command === "reader.ui.snapshot") {
          return respond({ status: "snapshot", snapshot: readerDevSnapshot() });
        }

        if (command?.startsWith?.("reader.library.db.")) {
          let result = null;
          const applyAuthorityResult = (libraryResult) => {
            if (!libraryResult?.data?.success) return null;
            const authorityState = writeReaderAuthorityLibraryState(
              libraryResult.data
            );
            setReaderCategories(authorityState.categories);
            setReaderBookshelf(authorityState.bookshelf);
            return authorityState;
          };

          if (
            command === "reader.library.db.snapshot" ||
            command === "reader.library.db.reconcile"
          ) {
            result = await ReaderLibrary.list({
              priority: "P0",
              intentRank: 1,
              scope: { workspaceSlug: workspace?.slug || null },
            });
            applyAuthorityResult(result);
          } else if (command === "reader.library.db.bootstrap") {
            result = await ReaderLibrary.bootstrap(
              {
                bookshelf: params.bookshelf || readReaderBookshelf(),
                categories:
                  params.categories || readReaderBookshelfCategories(),
              },
              {
                priority: "P0",
                intentRank: 0,
                scope: { workspaceSlug: workspace?.slug || null },
              }
            );
            applyAuthorityResult(result);
          } else if (command === "reader.library.db.patchItem") {
            const item =
              (params.itemId && { libraryItemId: params.itemId }) ||
              findReaderDevItem(
                params.readerDocumentId || scope.readerDocumentId
              );
            const itemId =
              params.itemId ||
              item?.libraryItemId ||
              item?.itemId ||
              item?.itemKey ||
              item?.key;
            if (!itemId)
              return respond({
                success: false,
                status: "missing_library_item_id",
              });
            result = await ReaderLibrary.patchItem(itemId, params.patch || {}, {
              priority: "P0",
              intentRank: 0,
              scope: {
                workspaceSlug: workspace?.slug || null,
                readerDocumentId:
                  params.readerDocumentId || scope.readerDocumentId || null,
              },
            });
            applyAuthorityResult(result);
          } else if (command === "reader.library.db.deleteItem") {
            const item =
              (params.itemId && { libraryItemId: params.itemId }) ||
              findReaderDevItem(
                params.readerDocumentId || scope.readerDocumentId
              );
            const itemId =
              params.itemId ||
              item?.libraryItemId ||
              item?.itemId ||
              item?.itemKey ||
              item?.key;
            if (!itemId)
              return respond({
                success: false,
                status: "missing_library_item_id",
              });
            result = await ReaderLibrary.deleteItem(itemId, {
              priority: "P0",
              intentRank: 0,
              scope: {
                workspaceSlug: workspace?.slug || null,
                readerDocumentId:
                  params.readerDocumentId || scope.readerDocumentId || null,
              },
            });
            applyAuthorityResult(result);
          } else if (command === "reader.library.db.patchCategory") {
            result = await ReaderLibrary.patchCategory(
              params.categoryId,
              params.patch || { name: params.name },
              {
                priority: "P0",
                intentRank: 0,
                scope: { workspaceSlug: workspace?.slug || null },
              }
            );
            applyAuthorityResult(result);
          } else if (command === "reader.library.db.deleteCategory") {
            result = await ReaderLibrary.deleteCategory(params.categoryId, {
              priority: "P0",
              intentRank: 0,
              scope: { workspaceSlug: workspace?.slug || null },
            });
            applyAuthorityResult(result);
          }

          return respond({
            status: "reader_library_db_command_done",
            result: result?.data || null,
            snapshot: readerDevSnapshot(),
          });
        }

        if (
          command === "reader.scope.cancelTasks" ||
          command === "reader.scope.markStale"
        ) {
          const taskScope = {
            route: "workspace-chat",
            workspaceSlug: scope.workspaceSlug || workspace?.slug || null,
            readerDocumentId: readerDevDocumentId(scope, params),
          };
          const count =
            command === "reader.scope.cancelTasks"
              ? requestPriorityQueue.cancelScope(
                  taskScope,
                  "dev-control-reader-cancel"
                )
              : requestPriorityQueue.markScopeStale(
                  taskScope,
                  "dev-control-reader-stale"
                );
          return respond({ status: "task_scope_updated", count });
        }

        const readerDocumentId = readerDevDocumentId(scope, params);
        if (!readerDocumentId) {
          return respond({
            success: false,
            status: "missing_reader_document_id",
          });
        }

        if (command === "reader.memory.clear") {
          const item = findReaderDevItem(readerDocumentId);
          if (item) {
            deleteReaderProgressBackup(item);
            setReaderHistory(
              updateReaderHistoryItem(null, null, item, {
                progress: null,
              })
            );
            setReaderBookshelf(
              updateReaderBookshelfItem(item, { progress: null })
            );
          }
          return respond({
            status: item ? "memory_cleared" : "item_not_found",
          });
        }

        const item = findReaderDevItem(readerDocumentId) || {
          readerDocumentId,
          backupReaderDocumentId: readerDocumentId,
          title: params.title || "",
          documentType: params.documentType || "pdf",
          readerDocumentWorkspaceSlug:
            scope.workspaceSlug ||
            params.workspaceSlug ||
            workspace?.slug ||
            null,
        };

        if (
          command === "reader.ui.openDocument" ||
          command === "reader.ui.jumpToPage"
        ) {
          setDrawerSectionPersisted(params.section || "bookshelf", {
            open: true,
          });
          setDrawerOpenPersisted(true, {
            section: params.section || "bookshelf",
          });
          const opened = await openReaderDocument(readerDocumentId, item, {
            returnStatus: true,
            suppressTerminalToast: true,
            readerDebugHeaders: readerDevDebugGrantHeaders(params),
          });
          if (!opened?.ok) {
            return respond({
              success: false,
              status: "open_failed",
              reason: opened?.reason || null,
              message: opened?.message || "Reader document open failed",
            });
          }
        }

        if (
          command === "reader.memory.setPage" ||
          command === "reader.ui.jumpToPage"
        ) {
          const page = readerDevPage(params);
          const progress = recordReaderDevPage(readerDocumentId, page, params);
          const jumpSource = readerDevJumpSource(
            currentDocument || item,
            page,
            {
              ...params,
              readerDocumentId,
              backupReaderDocumentId:
                item.backupReaderDocumentId || readerDocumentId,
            }
          );
          if (jumpSource) {
            window.setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent("anythingllm-document-reader-jump", {
                  detail: jumpSource,
                })
              );
            }, 180);
          }
          return respond({
            status:
              command === "reader.memory.setPage"
                ? "memory_page_recorded"
                : "document_opened_and_jumped",
            progress,
          });
        }

        return respond({
          status:
            command === "reader.ui.openDocument"
              ? "document_opened"
              : "command_accepted",
          snapshot: readerDevSnapshot(),
        });
      } catch (error) {
        return respond({
          success: false,
          status: "command_failed",
          message: error?.message || "Reader dev command failed",
        });
      }
    };

    window.addEventListener(READER_DEV_CONTROL_EVENT, runReaderDevCommand);
    return () =>
      window.removeEventListener(READER_DEV_CONTROL_EVENT, runReaderDevCommand);
  }, [
    currentDocument,
    findReaderDevItem,
    openReaderDocument,
    publishReaderDevResult,
    readerDevSnapshot,
    recordReaderDevPage,
    refreshLocalReaderLibraryState,
    refreshReaderLibraryFromPersistentSources,
    setDrawerOpenPersisted,
    setDrawerSectionPersisted,
    workspace?.slug,
  ]);

  const openHistoryDocument = useCallback(
    async (historyItem, options = {}) => {
      if (!historyItem) return { ok: false };
      const rememberedItem = readerItemWithLatestBookMemory(historyItem);
      setDrawerSectionPersisted(options.origin || "history");
      if (
        rememberedItem.source === "workspace_parsed" &&
        rememberedItem.workspaceDocPath
      ) {
        const opened = await openWorkspaceParsedDocument(
          rememberedItem.workspaceDocPath,
          rememberedItem.readerDocumentWorkspaceSlug ||
            rememberedItem.workspaceSlug ||
            workspace?.slug,
          rememberedItem,
          { reason: "history-workspace-parsed" }
        );
        return { ok: !!opened };
      }
      const hasServerBackup = hasServerReaderDocument(rememberedItem);
      let serverFailure = null;
      if (hasServerBackup) {
        const serverResult = await openUploadedHistoryItem(rememberedItem, {
          returnStatus: true,
        });
        if (serverResult?.ok) return { ok: true };
        serverFailure = serverResult || null;
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
        const uploadedResult = await openUploadedHistoryItem(rememberedItem, {
          serverFallbackToast: localSourceFailed
            ? "本地文件不可用，已使用云端备份打开。"
            : null,
          allowLocalFallback: true,
          returnStatus: true,
        });
        if (uploadedResult?.ok) return { ok: true };
        serverFailure = uploadedResult || serverFailure;
      }
      if (hasServerBackup) {
        const failure = serverFailure || {
          ok: false,
          message: "云端文档暂时不可用，请稍后重试。",
          reason: "unknown-server-open-failure",
        };
        readerOpenDebug("history-server-failure", {
          title: rememberedItem.title || null,
          readerDocumentId:
            rememberedItem.readerDocumentId ||
            rememberedItem.backupReaderDocumentId ||
            null,
          workspaceSlug:
            rememberedItem.readerDocumentWorkspaceSlug ||
            rememberedItem.workspaceSlug ||
            workspace?.slug ||
            null,
          ...failure,
        });
        showToast(
          failure.message || "云端文档暂时不可用，请稍后重试。",
          failure.terminal ? "error" : "warning"
        );
        return { ok: false, ...failure };
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
      const removableKeys = selectedItems.map(readerLibraryItemKey);
      const removableItems = selectedItems;

      if (removableKeys.length) {
        const nextBookshelf = deleteStoredReaderBookshelfItems(removableKeys);
        deleteReaderProgressBackup(removableItems);
        setReaderBookshelf(nextBookshelf);
      }

      for (const item of removableItems) {
        deleteStoredReaderHistoryItem(null, null, item);
      }
      setReaderHistory(readReaderHistory());

      const deleteAction = optimisticActionCenter.run({
        type: "reader.bookshelf.delete",
        scope: {
          route: "workspace-chat",
          workspaceSlug: workspace?.slug || null,
          surface: "reader-bookshelf",
        },
        priority: "P0",
        policy: "foreground",
        intentRank: 0,
        protected: true,
        abortable: false,
        tombstone: true,
        label: "optimistic:reader-bookshelf-delete",
        dedupeKey: `optimistic:reader-bookshelf-delete:${removableKeys.join(",")}`,
        rollbackPatch: () => {},
        serverCall: async ({ signal }) =>
          await Promise.all(
            selectedItems.map(async (item) => {
              const authorityItemId =
                item.libraryItemId ||
                item.itemId ||
                item.itemKey ||
                item.key ||
                readerLibraryItemKey(item);
              try {
                const { response, data } = await ReaderLibrary.deleteItem(
                  authorityItemId,
                  {
                    signal,
                    timeoutMs: 15_000,
                    priority: "P0",
                    intentRank: 0,
                    scope: {
                      workspaceSlug: workspace?.slug || null,
                      readerDocumentId: item.readerDocumentId || null,
                    },
                  }
                );
                if (response.ok && data?.success)
                  return { ok: true, itemId: authorityItemId };
                if (response.status === 404)
                  return { ok: true, itemId: authorityItemId, missing: true };
                return {
                  ok: false,
                  itemId: authorityItemId,
                  error: data?.error || authorityItemId,
                };
              } catch (error) {
                if (error?.status === 404) {
                  return { ok: true, itemId: authorityItemId, missing: true };
                }
                return {
                  ok: false,
                  itemId: authorityItemId,
                  error: error?.message || authorityItemId,
                };
              }
            })
          ),
      });
      const deleteOutcome = await deleteAction.promise;
      const deleteResults = deleteOutcome.ok ? deleteOutcome.result || [] : [];
      const failedDeletes = deleteResults.filter((result) => !result.ok);

      if (!deleteOutcome.ok || failedDeletes.length) {
        showToast(
          `部分书架删除同步失败，已先从本机隐藏 ${
            failedDeletes.length || selectedItems.length
          } 本书，后台稍后可重试。`,
          "warning"
        );
      } else {
        showToast(`已从书架移除 ${removableItems.length} 本书`, "success");
      }
    },
    [workspace?.slug]
  );

  const createBookshelfCategory = useCallback(
    (name) => {
      const previousCategories = readReaderBookshelfCategories();
      const action = optimisticActionCenter.run({
        type: "reader.category.create",
        scope: {
          route: "workspace-chat",
          workspaceSlug: workspace?.slug || null,
          surface: "reader-bookshelf",
        },
        priority: "P0",
        policy: "foreground",
        intentRank: 0,
        protected: true,
        abortable: false,
        label: "optimistic:reader-category-create",
        optimisticPatch: () =>
          setReaderCategories(createReaderBookshelfCategory(name)),
        rollbackPatch: () =>
          setReaderCategories(
            writeReaderBookshelfCategories(previousCategories)
          ),
        serverCall: async ({ signal }) => {
          const categories = readReaderBookshelfCategories();
          const category = categories.find((entry) => entry.name === name) || {
            id: name,
            name,
          };
          return await ReaderLibrary.patchCategory(
            category.id,
            { name: category.name },
            {
              signal,
              priority: "P0",
              intentRank: 0,
              scope: { workspaceSlug: workspace?.slug || null },
            }
          );
        },
      });
      return action.promise;
    },
    [workspace?.slug]
  );

  const renameBookshelfCategory = useCallback(
    (categoryId, name) => {
      const previousCategories = readReaderBookshelfCategories();
      const action = optimisticActionCenter.run({
        type: "reader.category.rename",
        scope: {
          route: "workspace-chat",
          workspaceSlug: workspace?.slug || null,
          surface: "reader-bookshelf",
          categoryId,
        },
        priority: "P0",
        policy: "foreground",
        intentRank: 0,
        protected: true,
        abortable: false,
        label: "optimistic:reader-category-rename",
        optimisticPatch: () =>
          setReaderCategories(renameReaderBookshelfCategory(categoryId, name)),
        rollbackPatch: () =>
          setReaderCategories(
            writeReaderBookshelfCategories(previousCategories)
          ),
        serverCall: async ({ signal }) =>
          await ReaderLibrary.patchCategory(
            categoryId,
            { name },
            {
              signal,
              priority: "P0",
              intentRank: 0,
              scope: { workspaceSlug: workspace?.slug || null, categoryId },
            }
          ),
      });
      return action.promise;
    },
    [workspace?.slug]
  );

  const deleteBookshelfCategory = useCallback(
    (categoryId) => {
      const previousCategories = readReaderBookshelfCategories();
      let localResult = null;
      const action = optimisticActionCenter.run({
        type: "reader.category.delete",
        scope: {
          route: "workspace-chat",
          workspaceSlug: workspace?.slug || null,
          surface: "reader-bookshelf",
          categoryId,
        },
        priority: "P0",
        policy: "foreground",
        intentRank: 0,
        protected: true,
        abortable: false,
        label: "optimistic:reader-category-delete",
        optimisticPatch: () => {
          localResult = deleteReaderBookshelfCategory(
            categoryId,
            readReaderBookshelf()
          );
          setReaderCategories(localResult.categories);
          if (!localResult.ok) throw new Error(localResult.error);
        },
        rollbackPatch: () =>
          setReaderCategories(
            writeReaderBookshelfCategories(previousCategories)
          ),
        serverCall: async ({ signal }) =>
          await ReaderLibrary.deleteCategory(categoryId, {
            signal,
            priority: "P0",
            intentRank: 0,
            scope: { workspaceSlug: workspace?.slug || null, categoryId },
          }),
      });
      void action.promise.then((outcome) => {
        if (!outcome.ok) showToast(outcome.error?.message, "warning");
        else showToast("已删除分类", "success");
      });
      return localResult || { ok: false, categories: previousCategories };
    },
    [workspace?.slug]
  );

  const updateBookshelfItemCategory = useCallback(
    (item, categoryId) => {
      if (!item || !categoryId) return;
      const previousCategory = item.category || null;
      const patch = manualReaderCategory(categoryId);
      const action = optimisticActionCenter.run({
        type: "reader.bookshelf.category.update",
        scope: {
          route: "workspace-chat",
          workspaceSlug: workspace?.slug || null,
          readerDocumentId: item.readerDocumentId || null,
          surface: "reader-bookshelf",
        },
        priority: "P0",
        policy: "foreground",
        intentRank: 0,
        protected: true,
        abortable: false,
        label: "optimistic:reader-category-update",
        optimisticPatch: () => patchStoredCategoryForItem(item, patch),
        rollbackPatch: () => {
          if (previousCategory)
            patchStoredCategoryForItem(item, previousCategory);
        },
        serverCall: async ({ signal }) =>
          await ReaderLibrary.patchItem(
            item.libraryItemId || item.itemId || item.itemKey || item.key,
            {
              categoryId,
              category: patch.category,
              categoryStatus: patch.categoryStatus,
              categoryStage: patch.categoryStage,
              categoryReason: patch.categoryReason,
            },
            {
              signal,
              priority: "P0",
              intentRank: 0,
              scope: {
                workspaceSlug: workspace?.slug || null,
                readerDocumentId: item.readerDocumentId || null,
              },
            }
          ),
      });
      void action.promise.then((outcome) => {
        if (outcome.ok) showToast("已修改分类", "success");
        else showToast("分类修改失败", "error");
      });
    },
    [patchStoredCategoryForItem, workspace?.slug]
  );

  const reclassifyBookshelfItem = useCallback(
    (item) => {
      if (!item) return;
      const previousCategory = item.category || null;
      const patch = pendingReaderCategory("extracting", "等待重新自动分类");
      const action = optimisticActionCenter.run({
        type: "reader.bookshelf.reclassify",
        scope: {
          route: "workspace-chat",
          workspaceSlug: workspace?.slug || null,
          readerDocumentId: item.readerDocumentId || null,
          surface: "reader-bookshelf",
        },
        priority: "P0",
        policy: "foreground",
        intentRank: 0,
        protected: true,
        abortable: false,
        label: "optimistic:reader-reclassify",
        optimisticPatch: () => patchStoredCategoryForItem(item, patch),
        rollbackPatch: () => {
          if (previousCategory)
            patchStoredCategoryForItem(item, previousCategory);
        },
        serverCall: async () => {
          await queueBookshelfPostprocess({
            item: { ...item, ...patch },
            tasks: ["classification"],
            intent: "manual",
          });
          return true;
        },
      });
      void action.promise.then((outcome) => {
        if (!outcome.ok) showToast("重新分类任务启动失败", "error");
      });
    },
    [patchStoredCategoryForItem, queueBookshelfPostprocess, workspace?.slug]
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
      bookshelfLoading,
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
      loadWorkspaceDocuments,
      workspaceDocumentsLoading,
      workspaceDocumentsError,
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
      workspace: {
        ...workspace,
        documents: Array.isArray(workspaceDocuments)
          ? workspaceDocuments
          : Array.isArray(workspace?.documents)
            ? workspace.documents
            : [],
      },
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
      bookshelfLoading,
      bookshelfUploadQueue,
      readerCategories,
      reclassifyBookshelfItem,
      loadWorkspaceDocuments,
      workspaceDocumentsLoading,
      workspaceDocumentsError,
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
      workspaceDocuments,
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
