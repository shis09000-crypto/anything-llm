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
  compactDocumentForStorage,
  clearReaderHistory as clearStoredReaderHistory,
  quoteForPrompt,
  readReaderHistory,
  readerSourcesStorageKey,
  readerStorageKey,
  READER_EVENT_ASSOCIATE_SELECTION,
  READER_EVENT_OPEN_DRAWER,
  READER_EVENT_TURN_COMPLETED,
  upsertReaderHistory,
  validateReaderFile,
} from "./storage";
import {
  parseDocxFile,
  parseMarkdownFile,
  parsePdfFile,
  parseXlsxFile,
} from "./parsers";

const DocumentReaderContext = createContext(null);

async function parseFileByType(file, readerDocumentId, documentType) {
  if (documentType === "markdown")
    return await parseMarkdownFile(file, readerDocumentId);
  if (documentType === "docx")
    return await parseDocxFile(file, readerDocumentId);
  if (documentType === "xlsx")
    return await parseXlsxFile(file, readerDocumentId);
  if (documentType === "pdf") return await parsePdfFile(file, readerDocumentId);
  return null;
}

function uuid() {
  return crypto.randomUUID();
}

export function DocumentReaderProvider({
  workspace,
  threadSlug = null,
  setMessage,
  children,
}) {
  const storageKey = readerStorageKey(workspace?.slug, threadSlug);
  const sourcesKey = readerSourcesStorageKey(workspace?.slug, threadSlug);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [currentDocument, setCurrentDocument] = useState(null);
  const [pendingSelection, setPendingSelection] = useState(null);
  const [sourcesByTurn, setSourcesByTurn] = useState({});
  const [readerHistory, setReaderHistory] = useState([]);
  const objectUrlRef = useRef(null);
  const lastCitedRef = useRef({ signature: "", at: 0 });

  const historyItemFromDocument = useCallback((doc) => {
    if (!doc) return null;
    return {
      source: doc.source,
      title: doc.title,
      documentType: doc.documentType,
      size: doc.metadata?.size ?? doc.file?.size ?? null,
      readerDocumentId: doc.readerDocumentId || null,
      backupReaderDocumentId: doc.backupReaderDocumentId || null,
      workspaceDocPath: doc.workspaceDocPath || doc.metadata?.workspaceDocPath,
      localDocumentId: doc.localDocumentId || null,
      progress: doc.progress || { label: "最近打开", percent: 0 },
    };
  }, []);

  const rememberDocument = useCallback(
    (doc) => {
      if (!workspace?.slug) return;
      const item = historyItemFromDocument(doc);
      if (!item) return;
      setReaderHistory(upsertReaderHistory(workspace.slug, threadSlug, item));
    },
    [historyItemFromDocument, threadSlug, workspace?.slug]
  );

  const persistDocument = useCallback(
    (doc) => {
      if (!workspace?.slug) return;
      localStorage.setItem(
        storageKey,
        JSON.stringify(compactDocumentForStorage(doc))
      );
    },
    [storageKey, workspace?.slug]
  );

  const persistSources = useCallback(
    (nextSources) => {
      if (!workspace?.slug) return;
      localStorage.setItem(sourcesKey, JSON.stringify(nextSources || {}));
    },
    [sourcesKey, workspace?.slug]
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

  const openReaderDocument = useCallback(
    async (readerDocumentId) => {
      if (!workspace?.slug || !readerDocumentId) return;
      const { response, data } = await ReaderDocument.get(
        workspace.slug,
        readerDocumentId
      );
      if (!response.ok || !data?.success) {
        showToast(data?.error || "服务器伴读文档打开失败", "error");
        return;
      }

      let parsedContent = data.content;
      let objectUrl = null;
      if (data.metadata?.originalUrl) {
        const { response: blobResponse, blob } =
          await ReaderDocument.originalBlob(data.metadata.originalUrl);
        if (blobResponse.ok) {
          objectUrl = URL.createObjectURL(blob);
          objectUrlRef.current = objectUrl;
          const file = new File(
            [blob],
            data.metadata.originalName || "original",
            {
              type: data.metadata.mimeType,
            }
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
        source: "reader_upload",
        readerDocumentId,
        backupReaderDocumentId: readerDocumentId,
        documentType: data.content.documentType,
        title: data.metadata.originalName,
        metadata: data.metadata,
        content: parsedContent,
        objectUrl,
      };
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      setDrawerOpen(false);
    },
    [persistDocument, rememberDocument, workspace?.slug]
  );

  useEffect(() => {
    const storedSources = safeJsonParse(localStorage.getItem(sourcesKey), {});
    setSourcesByTurn(storedSources || {});
    setReaderHistory(readReaderHistory(workspace?.slug, threadSlug));

    const stored = safeJsonParse(localStorage.getItem(storageKey), null);
    if (!stored) return;
    if (stored.source === "local") {
      if (stored.backupReaderDocumentId) {
        showToast("本地文档不可恢复，已尝试使用服务器备份打开。", "info");
        openReaderDocument(stored.backupReaderDocumentId);
      } else {
        showToast("本地文档不可恢复，请重新选择文件。", "warning");
        setDrawerOpen(true);
      }
      return;
    }
    if (stored.readerDocumentId) openReaderDocument(stored.readerDocumentId);
  }, [openReaderDocument, sourcesKey, storageKey, threadSlug, workspace?.slug]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  useEffect(() => {
    const open = () => setDrawerOpen(true);
    window.addEventListener(READER_EVENT_OPEN_DRAWER, open);
    return () => window.removeEventListener(READER_EVENT_OPEN_DRAWER, open);
  }, []);

  useEffect(() => {
    const associate = (event) => {
      const { chatKey, clientGeneratedTurnId, turnId } = event.detail || {};
      if (!pendingSelection || !clientGeneratedTurnId) return;
      const mapKey = `${chatKey}:${clientGeneratedTurnId || turnId}`;
      setSources((prev) => ({
        ...prev,
        [mapKey]: [...(prev[mapKey] || []), pendingSelection],
      }));
      setPendingSelection(null);
    };
    const complete = (event) => {
      const { chatKey, turnId, chatId } = event.detail || {};
      if (!chatKey || !turnId || !chatId) return;
      const fromKey = `${chatKey}:${turnId}`;
      const toKey = `${chatKey}:chat:${chatId}`;
      setSources((prev) => {
        if (!prev[fromKey]) return prev;
        return {
          ...prev,
          [toKey]: prev[fromKey].map((source) => ({ ...source, chatId })),
        };
      });
    };
    window.addEventListener(READER_EVENT_ASSOCIATE_SELECTION, associate);
    window.addEventListener(READER_EVENT_TURN_COMPLETED, complete);
    return () => {
      window.removeEventListener(READER_EVENT_ASSOCIATE_SELECTION, associate);
      window.removeEventListener(READER_EVENT_TURN_COMPLETED, complete);
    };
  }, [pendingSelection, setSources]);

  const openLocalFile = useCallback(
    async (file) => {
      const validation = validateReaderFile(file);
      if (!validation.ok) {
        showToast(validation.error, "error");
        return;
      }
      const localDocumentId = uuid();
      const objectUrl = URL.createObjectURL(file);
      objectUrlRef.current = objectUrl;
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
      };
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      setDrawerOpen(false);
    },
    [persistDocument, rememberDocument]
  );

  const uploadCurrentDocument = useCallback(async () => {
    if (!workspace?.slug || !currentDocument?.file) {
      showToast("当前文档没有可上传的本地文件。", "warning");
      return;
    }
    const formData = new FormData();
    formData.append("file", currentDocument.file, currentDocument.file.name);
    const { response, data } = await ReaderDocument.upload(
      workspace.slug,
      formData
    );
    if (!response.ok || !data?.success) {
      showToast(data?.error || "上传服务器备份失败", "error");
      return;
    }
    const next = {
      ...currentDocument,
      source: "reader_upload",
      readerDocumentId: data.readerDocumentId,
      backupReaderDocumentId: data.readerDocumentId,
      metadata: data.metadata,
    };
    setCurrentDocument(next);
    persistDocument(next);
    rememberDocument({ ...next, source: "local" });
    showToast("已上传到服务器备份", "success");
  }, [currentDocument, persistDocument, rememberDocument, workspace?.slug]);

  const closeReader = useCallback(() => {
    setDrawerOpen(false);
    setCurrentDocument(null);
    setPendingSelection(null);
    if (workspace?.slug) localStorage.removeItem(storageKey);
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, [storageKey, workspace?.slug]);

  const openWorkspaceParsedDocument = useCallback(
    async (docPath) => {
      if (!workspace?.slug || !docPath) return;
      const { response, data } = await ReaderDocument.fromWorkspace(
        workspace.slug,
        docPath
      );
      if (!response.ok || !data?.success) {
        showToast(data?.error || "解析文本预览打开失败", "error");
        return;
      }
      const doc = {
        source: "workspace_parsed",
        readerDocumentId: data.metadata.readerDocumentId,
        documentType: "markdown",
        title: data.metadata.originalName,
        metadata: { ...data.metadata, workspaceDocPath: docPath },
        workspaceDocPath: docPath,
        content: data.content,
      };
      setCurrentDocument(doc);
      persistDocument(doc);
      rememberDocument(doc);
      setDrawerOpen(false);
    },
    [persistDocument, rememberDocument, workspace?.slug]
  );

  const openHistoryDocument = useCallback(
    async (historyItem) => {
      if (!historyItem) return { ok: false };
      if (
        historyItem.source === "reader_upload" &&
        historyItem.readerDocumentId
      ) {
        await openReaderDocument(historyItem.readerDocumentId);
        return { ok: true };
      }
      if (
        historyItem.source === "workspace_parsed" &&
        historyItem.workspaceDocPath
      ) {
        await openWorkspaceParsedDocument(historyItem.workspaceDocPath);
        return { ok: true };
      }
      if (
        historyItem.source === "local" &&
        historyItem.backupReaderDocumentId
      ) {
        await openReaderDocument(historyItem.backupReaderDocumentId);
        return { ok: true };
      }
      showToast("本地文档不可恢复，请重新选择文件。", "warning");
      return { ok: false, needsLocalFile: true };
    },
    [openReaderDocument, openWorkspaceParsedDocument]
  );

  const clearReaderHistory = useCallback(() => {
    setReaderHistory(clearStoredReaderHistory(workspace?.slug, threadSlug));
    showToast("已清空伴读历史记录", "success");
  }, [threadSlug, workspace?.slug]);

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
      setPendingSelection(selection);
      setMessage?.(quoteForPrompt(selection), "append");
      showToast("已加入伴读引用", "success");
    },
    [setMessage]
  );

  const value = useMemo(
    () => ({
      currentDocument,
      drawerOpen,
      setDrawerOpen,
      openLocalFile,
      uploadCurrentDocument,
      openWorkspaceParsedDocument,
      citeSelection,
      closeReader,
      readerHistory,
      openHistoryDocument,
      clearReaderHistory,
      sourcesByTurn,
      workspace,
      threadSlug,
    }),
    [
      currentDocument,
      drawerOpen,
      openLocalFile,
      uploadCurrentDocument,
      openWorkspaceParsedDocument,
      citeSelection,
      clearReaderHistory,
      closeReader,
      openHistoryDocument,
      readerHistory,
      sourcesByTurn,
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
