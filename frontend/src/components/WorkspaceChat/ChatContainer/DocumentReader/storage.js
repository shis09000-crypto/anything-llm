export const READER_SCHEMA_VERSION = 1;
export const MAX_READER_FILE_SIZE = 50 * 1024 * 1024;
export const READER_EVENT_OPEN_DRAWER = "anythingllm-document-reader-open";
export const READER_EVENT_ASSOCIATE_SELECTION =
  "anythingllm-document-reader-associate-selection";
export const READER_EVENT_TURN_COMPLETED =
  "anythingllm-document-reader-turn-completed";

export const ALLOWED_READER_EXTENSIONS = [
  ".md",
  ".markdown",
  ".pdf",
  ".docx",
  ".xlsx",
];

export function readerStorageKey(workspaceSlug, threadSlug = null) {
  return `anythingllm_document_reader:v1:${workspaceSlug}:${threadSlug || "default"}`;
}

export function readerSourcesStorageKey(workspaceSlug, threadSlug = null) {
  return `anythingllm_document_reader_sources:v1:${workspaceSlug}:${threadSlug || "default"}`;
}

export function readerHistoryStorageKey(workspaceSlug, threadSlug = null) {
  return `anythingllm_document_reader_history:v1:${workspaceSlug}:${threadSlug || "default"}`;
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value) || fallback;
  } catch {
    return fallback;
  }
}

export function readReaderHistory(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) return [];
  const parsed = safeJson(
    localStorage.getItem(readerHistoryStorageKey(workspaceSlug, threadSlug)),
    []
  );
  return Array.isArray(parsed) ? parsed : [];
}

export function writeReaderHistory(
  workspaceSlug,
  threadSlug = null,
  history = []
) {
  if (!workspaceSlug) return [];
  const next = Array.isArray(history) ? history.slice(0, 20) : [];
  localStorage.setItem(
    readerHistoryStorageKey(workspaceSlug, threadSlug),
    JSON.stringify(next)
  );
  return next;
}

export function clearReaderHistory(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) return [];
  localStorage.removeItem(readerHistoryStorageKey(workspaceSlug, threadSlug));
  return [];
}

export function upsertReaderHistory(
  workspaceSlug,
  threadSlug = null,
  item = {}
) {
  if (!workspaceSlug || !item?.title)
    return readReaderHistory(workspaceSlug, threadSlug);
  const itemKey =
    item.source === "local"
      ? item.localDocumentId ||
        item.backupReaderDocumentId ||
        `${item.source}:${item.title}`
      : item.readerDocumentId ||
        item.backupReaderDocumentId ||
        item.workspaceDocPath ||
        item.localDocumentId ||
        `${item.source}:${item.title}`;
  const now = new Date().toISOString();
  const current = readReaderHistory(workspaceSlug, threadSlug);
  const nextItem = {
    source: item.source,
    title: item.title,
    documentType: item.documentType,
    size: item.size ?? null,
    lastOpenedAt: item.lastOpenedAt || now,
    readerDocumentId: item.readerDocumentId || null,
    backupReaderDocumentId: item.backupReaderDocumentId || null,
    workspaceDocPath: item.workspaceDocPath || null,
    localDocumentId: item.localDocumentId || null,
    progress: item.progress || { label: "最近打开", percent: 0 },
    key: itemKey,
  };
  const deduped = current.filter((historyItem) => historyItem.key !== itemKey);
  return writeReaderHistory(workspaceSlug, threadSlug, [nextItem, ...deduped]);
}

export function textHash(text = "") {
  let hash = 5381;
  const normalized = String(text || "")
    .trim()
    .slice(0, 1000);
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 33) ^ normalized.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function stableBlockId(text = "", index = 0) {
  return `block-${index}-${textHash(text)}`;
}

export function extensionFromName(name = "") {
  const match = String(name)
    .toLowerCase()
    .match(/\.[^.]+$/);
  return match?.[0] || "";
}

export function documentTypeFromExtension(ext = "") {
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  return ext.replace(".", "");
}

export function validateReaderFile(file) {
  if (!file) return { ok: false, error: "请选择文档。" };
  if (file.size > MAX_READER_FILE_SIZE) {
    return { ok: false, error: "文件超过 50MB，伴读模式不会自动解析。" };
  }
  const ext = extensionFromName(file.name);
  if (!ALLOWED_READER_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      error: "伴读 MVP 仅支持 .md/.markdown/.pdf/.docx/.xlsx。",
    };
  }
  return { ok: true, ext, documentType: documentTypeFromExtension(ext) };
}

export function quoteForPrompt(selection) {
  if (!selection?.selectedText) return "";
  const title = selection.documentTitle || "文档";
  const locator = selection.locatorLabel ? `（${selection.locatorLabel}）` : "";
  return `\n> 来自伴读文档 ${title}${locator}：\n> ${selection.selectedText}\n`;
}

export function compactDocumentForStorage(document) {
  if (!document) return null;
  return {
    source: document.source,
    localDocumentId: document.localDocumentId || null,
    readerDocumentId: document.readerDocumentId || null,
    backupReaderDocumentId: document.backupReaderDocumentId || null,
    documentType: document.documentType,
    title: document.title,
    metadata: document.metadata,
    restoredAt: Date.now(),
  };
}
