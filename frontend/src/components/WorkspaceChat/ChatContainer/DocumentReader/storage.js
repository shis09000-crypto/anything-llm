import { storageKeys } from "@/utils/appEnvironment";

export const READER_SCHEMA_VERSION = 1;
export const MAX_READER_FILE_SIZE = 500 * 1024 * 1024;
export const READER_EVENT_OPEN_DRAWER = "anythingllm-document-reader-open";
export const READER_EVENT_ASSOCIATE_SELECTION =
  "anythingllm-document-reader-associate-selection";
export const READER_EVENT_TURN_COMPLETED =
  "anythingllm-document-reader-turn-completed";
export const READER_EVENT_CONSUME_TEXT_SOURCES =
  "anythingllm-document-reader-consume-text-sources";
export const READER_BOOKSHELF_STORAGE_KEY =
  "anythingllm_document_reader_bookshelf:v1";
export const READER_BOOKSHELF_CATEGORIES_STORAGE_KEY =
  "anythingllm_document_reader_bookshelf_categories:v1";
export const READER_BOOKSHELF_PENDING_OPEN_KEY =
  "anythingllm_document_reader_bookshelf_pending_open:v1";
export const UNKNOWN_READER_CATEGORY_ID = "unknown";

export const ALLOWED_READER_EXTENSIONS = [
  ".md",
  ".markdown",
  ".pdf",
  ".docx",
  ".xlsx",
  ".epub",
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

function isoNow() {
  return new Date().toISOString();
}

const DEFAULT_READER_BOOKSHELF_CATEGORIES = [
  [UNKNOWN_READER_CATEGORY_ID, "未知分类"],
  ["fiction", "小说文学"],
  ["philosophy", "哲学思想"],
  ["history", "历史传记"],
  ["medicine", "医学健康"],
  ["finance", "金融经济"],
  ["computer", "计算机技术"],
  ["science", "自然科学"],
  ["society", "社会科学"],
  ["language", "语言学习"],
  ["textbook", "教材教辅"],
  ["business", "商业管理"],
  ["law-politics", "法律政治"],
  ["religion-culture", "宗教文化"],
  ["tea-food", "茶学饮食"],
  ["paper-report", "论文报告"],
  ["project-doc", "项目文档"],
  ["other", "其他"],
].map(([id, name], index) => ({
  id,
  name,
  sortOrder: index * 10,
}));

function normalizedCategoryId(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function uniqueCategoryId(name = "", existing = []) {
  const used = new Set(existing.map((category) => category.id));
  const base =
    normalizedCategoryId(name) ||
    `category-${Math.random().toString(36).slice(2, 8)}`;
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function normalizeCategoryName(name = "") {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 30);
}

function unknownReaderCategory(now = isoNow()) {
  return {
    id: UNKNOWN_READER_CATEGORY_ID,
    name: "未知分类",
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeReaderBookshelfCategories(categories = []) {
  const now = isoNow();
  const source =
    Array.isArray(categories) && categories.length
      ? categories
      : DEFAULT_READER_BOOKSHELF_CATEGORIES;
  const byId = new Map();
  for (const rawCategory of source) {
    const id = normalizedCategoryId(rawCategory?.id);
    const name = normalizeCategoryName(rawCategory?.name);
    if (!id || !name || byId.has(id)) continue;
    byId.set(id, {
      id,
      name,
      sortOrder: Number.isFinite(Number(rawCategory.sortOrder))
        ? Number(rawCategory.sortOrder)
        : byId.size * 10,
      createdAt: rawCategory.createdAt || now,
      updatedAt: rawCategory.updatedAt || now,
    });
  }
  if (!byId.has(UNKNOWN_READER_CATEGORY_ID)) {
    byId.set(UNKNOWN_READER_CATEGORY_ID, unknownReaderCategory(now));
  }
  return [...byId.values()].sort((a, b) => {
    if (a.id === UNKNOWN_READER_CATEGORY_ID) return -1;
    if (b.id === UNKNOWN_READER_CATEGORY_ID) return 1;
    return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "zh-Hans");
  });
}

export function readReaderBookshelfCategories() {
  const parsed = safeJson(
    localStorage.getItem(READER_BOOKSHELF_CATEGORIES_STORAGE_KEY),
    []
  );
  const categories = normalizeReaderBookshelfCategories(parsed);
  localStorage.setItem(
    READER_BOOKSHELF_CATEGORIES_STORAGE_KEY,
    JSON.stringify(categories)
  );
  return categories;
}

export function writeReaderBookshelfCategories(categories = []) {
  const next = normalizeReaderBookshelfCategories(categories);
  localStorage.setItem(
    READER_BOOKSHELF_CATEGORIES_STORAGE_KEY,
    JSON.stringify(next)
  );
  return next;
}

export function createReaderBookshelfCategory(name = "") {
  const current = readReaderBookshelfCategories();
  const categoryName = normalizeCategoryName(name);
  if (!categoryName) return current;
  const now = isoNow();
  return writeReaderBookshelfCategories([
    ...current,
    {
      id: uniqueCategoryId(categoryName, current),
      name: categoryName,
      sortOrder:
        Math.max(0, ...current.map((category) => category.sortOrder || 0)) + 10,
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

export function renameReaderBookshelfCategory(categoryId, name = "") {
  const id = normalizedCategoryId(categoryId);
  const categoryName = normalizeCategoryName(name);
  if (!id || !categoryName) return readReaderBookshelfCategories();
  const now = isoNow();
  return writeReaderBookshelfCategories(
    readReaderBookshelfCategories().map((category) =>
      category.id === id
        ? { ...category, name: categoryName, updatedAt: now }
        : category
    )
  );
}

export function deleteReaderBookshelfCategory(categoryId, items = []) {
  const id = normalizedCategoryId(categoryId);
  const categories = readReaderBookshelfCategories();
  if (id === UNKNOWN_READER_CATEGORY_ID) {
    return {
      ok: false,
      categories,
      error: "未知分类不可删除。",
    };
  }
  const hasBooks = (Array.isArray(items) ? items : []).some(
    (item) => effectiveReaderCategoryId(item, categories) === id
  );
  if (hasBooks) {
    return {
      ok: false,
      categories,
      error: "该分类下还有书籍，请先移动或修改这些书籍的分类后再删除。",
    };
  }
  return {
    ok: true,
    categories: writeReaderBookshelfCategories(
      categories.filter((category) => category.id !== id)
    ),
  };
}

function categoryById(
  categoryId,
  categories = readReaderBookshelfCategories()
) {
  const id = normalizedCategoryId(categoryId);
  return (
    categories.find((category) => category.id === id) ||
    categories.find((category) => category.id === UNKNOWN_READER_CATEGORY_ID) ||
    unknownReaderCategory()
  );
}

export function pendingReaderCategory(stage = "extracting", reason = "") {
  const now = isoNow();
  const unknown = categoryById(UNKNOWN_READER_CATEGORY_ID);
  return {
    categoryStatus: "pending",
    categoryStage: stage,
    categoryReason: reason || "正在分类",
    category: {
      primaryCategoryId: unknown.id,
      primaryCategoryName: unknown.name,
      secondaryCategory: "",
      tags: [],
      confidence: 0,
      source: "pending",
      reason: reason || "正在分类",
      evidence: [],
      sampleStrategy: "",
      classifiedAt: null,
      updatedAt: now,
    },
  };
}

export function fallbackReaderCategory(reason = "无法判断分类") {
  const now = isoNow();
  const unknown = categoryById(UNKNOWN_READER_CATEGORY_ID);
  return {
    categoryStatus: "unknown",
    categoryStage: "unknownReason",
    categoryReason: reason,
    category: {
      primaryCategoryId: unknown.id,
      primaryCategoryName: unknown.name,
      secondaryCategory: "",
      tags: [],
      confidence: 0,
      source: "fallback",
      reason,
      evidence: [],
      sampleStrategy: "",
      classifiedAt: now,
      updatedAt: now,
    },
  };
}

export function manualReaderCategory(categoryId, extra = {}) {
  const now = isoNow();
  const category = categoryById(categoryId);
  const tags = Array.isArray(extra.tags)
    ? extra.tags
        .map((tag) => String(tag).trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  return {
    categoryStatus: "manual",
    categoryStage: "manual",
    categoryReason: "用户手动修改",
    category: {
      primaryCategoryId: category.id,
      primaryCategoryName: category.name,
      secondaryCategory: String(extra.secondaryCategory || "").trim(),
      tags,
      confidence: 1,
      source: "manual",
      reason: "用户手动修改",
      evidence: [],
      sampleStrategy: "",
      classifiedAt: now,
      updatedAt: now,
    },
  };
}

export function normalizeReaderCategoryPatch(result = {}) {
  const categories = readReaderBookshelfCategories();
  const now = isoNow();
  const rawCategory = result.category || result;
  const selected = categoryById(rawCategory.primaryCategoryId, categories);
  const source = ["llm", "manual", "fallback", "pending"].includes(
    rawCategory.source
  )
    ? rawCategory.source
    : "fallback";
  const status =
    result.categoryStatus ||
    (source === "manual"
      ? "manual"
      : source === "llm"
        ? "classified"
        : "unknown");
  return {
    categoryStatus: status,
    categoryStage:
      result.categoryStage ||
      (status === "classified"
        ? "classified"
        : status === "manual"
          ? "manual"
          : "unknownReason"),
    categoryReason: result.categoryReason || rawCategory.reason || "",
    category: {
      primaryCategoryId: selected.id,
      primaryCategoryName: selected.name,
      secondaryCategory: String(rawCategory.secondaryCategory || "").trim(),
      tags: Array.isArray(rawCategory.tags)
        ? rawCategory.tags
            .map((tag) => String(tag).trim())
            .filter(Boolean)
            .slice(0, 8)
        : [],
      confidence: Math.max(0, Math.min(1, Number(rawCategory.confidence) || 0)),
      source,
      reason: String(rawCategory.reason || "").trim(),
      evidence: Array.isArray(rawCategory.evidence)
        ? rawCategory.evidence
            .map((item) => String(item).trim())
            .filter(Boolean)
            .slice(0, 4)
        : [],
      sampleStrategy: String(rawCategory.sampleStrategy || "").trim(),
      classifiedAt: rawCategory.classifiedAt || now,
      updatedAt: rawCategory.updatedAt || now,
    },
  };
}

export function effectiveReaderCategoryId(
  item = {},
  categories = readReaderBookshelfCategories()
) {
  if (item.categoryStatus === "pending") return "pending";
  const category = categoryById(item.category?.primaryCategoryId, categories);
  return category.id;
}

export function normalizeBookTitle(title = "") {
  return String(title || "")
    .normalize("NFKC")
    .replace(/\.(pdf|docx|xlsx|epub|md|markdown|txt)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fallbackBookKey(item = {}) {
  return normalizeBookTitle(item.title || item.metadata?.originalName || "");
}

function timestampValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function isUploadedHistoryItem(item = {}) {
  return !!(
    item.readerDocumentId ||
    item.backupReaderDocumentId ||
    item.uploaded
  );
}

function historySort(a, b) {
  return timestampValue(b.lastOpenedAt) - timestampValue(a.lastOpenedAt);
}

function mergeHistoryItems(primary = {}, secondary = {}) {
  const primaryUploaded = isUploadedHistoryItem(primary);
  const secondaryUploaded = isUploadedHistoryItem(secondary);
  return {
    ...secondary,
    ...primary,
    readerDocumentId:
      primary.readerDocumentId || secondary.readerDocumentId || null,
    backupReaderDocumentId:
      primary.backupReaderDocumentId ||
      secondary.backupReaderDocumentId ||
      null,
    workspaceDocPath:
      primary.workspaceDocPath || secondary.workspaceDocPath || null,
    localDocumentId:
      primary.localDocumentId || secondary.localDocumentId || null,
    localPath: primary.localPath || secondary.localPath || null,
    thumbnailDataUrl:
      primary.thumbnailDataUrl || secondary.thumbnailDataUrl || null,
    categoryStatus:
      primary.categoryStatus || secondary.categoryStatus || undefined,
    categoryStage: primary.categoryStage || secondary.categoryStage || "",
    categoryReason: primary.categoryReason || secondary.categoryReason || "",
    category: primary.category || secondary.category || undefined,
    progress: normalizedReaderProgress(primary.progress || secondary.progress),
    uploaded: primaryUploaded || secondaryUploaded,
  };
}

function normalizeHistoryItem(item = {}) {
  const bookKey = item.bookKey || fallbackBookKey(item);
  const branchId = item.branchId || null;
  const key = branchId ? `${bookKey}:branch:${branchId}` : `${bookKey}:main`;
  return {
    ...item,
    bookKey,
    branchId,
    branchLabel: branchId ? item.branchLabel || "本地分支" : null,
    uploaded: isUploadedHistoryItem(item),
    progress: normalizedReaderProgress(item.progress),
    key,
  };
}

function normalizeBookshelfItem(item = {}) {
  const normalized = normalizeHistoryItem(item);
  const now = new Date().toISOString();
  return {
    ...normalized,
    workspaceSlug: item.workspaceSlug || null,
    threadSlug: item.threadSlug || null,
    addedAt: item.addedAt || item.lastOpenedAt || now,
    updatedAt: item.updatedAt || item.lastOpenedAt || now,
  };
}

function normalizeHistory(history = []) {
  const byKey = new Map();
  for (const rawItem of Array.isArray(history) ? history : []) {
    if (!rawItem?.title) continue;
    const item = normalizeHistoryItem(rawItem);
    const previous = byKey.get(item.key);
    if (!previous) {
      byKey.set(item.key, item);
      continue;
    }
    const newer =
      timestampValue(item.lastOpenedAt) >= timestampValue(previous.lastOpenedAt)
        ? item
        : previous;
    const older = newer === item ? previous : item;
    byKey.set(item.key, normalizeHistoryItem(mergeHistoryItems(newer, older)));
  }
  return [...byKey.values()].sort(historySort);
}

export function readReaderHistory(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) return [];
  const parsed = safeJson(
    localStorage.getItem(readerHistoryStorageKey(workspaceSlug, threadSlug)),
    []
  );
  return normalizeHistory(parsed);
}

export function writeReaderHistory(
  workspaceSlug,
  threadSlug = null,
  history = []
) {
  if (!workspaceSlug) return [];
  const next = normalizeHistory(history).slice(0, 20);
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

export function readReaderBookshelf() {
  const parsed = safeJson(
    localStorage.getItem(READER_BOOKSHELF_STORAGE_KEY),
    []
  );
  const byKey = new Map();
  for (const rawItem of Array.isArray(parsed) ? parsed : []) {
    if (!rawItem?.title) continue;
    const item = normalizeBookshelfItem(rawItem);
    const previous = byKey.get(item.key);
    if (!previous) {
      byKey.set(item.key, item);
      continue;
    }
    const newer =
      timestampValue(item.updatedAt || item.addedAt) >=
      timestampValue(previous.updatedAt || previous.addedAt)
        ? item
        : previous;
    const older = newer === item ? previous : item;
    byKey.set(
      item.key,
      normalizeBookshelfItem(mergeHistoryItems(newer, older))
    );
  }
  return [...byKey.values()].sort(
    (a, b) =>
      timestampValue(b.updatedAt || b.addedAt) -
      timestampValue(a.updatedAt || a.addedAt)
  );
}

export function writeReaderBookshelf(items = []) {
  const next = [];
  const byKey = new Map();
  for (const rawItem of Array.isArray(items) ? items : []) {
    if (!rawItem?.title) continue;
    const item = normalizeBookshelfItem(rawItem);
    const previous = byKey.get(item.key);
    byKey.set(
      item.key,
      previous
        ? normalizeBookshelfItem(mergeHistoryItems(item, previous))
        : item
    );
  }
  next.push(...byKey.values());
  next.sort(
    (a, b) =>
      timestampValue(b.updatedAt || b.addedAt) -
      timestampValue(a.updatedAt || a.addedAt)
  );
  localStorage.setItem(READER_BOOKSHELF_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function upsertReaderBookshelfItems(items = []) {
  const now = new Date().toISOString();
  const current = readReaderBookshelf();
  const byKey = new Map(current.map((item) => [item.key, item]));
  for (const rawItem of Array.isArray(items) ? items : [items]) {
    if (!rawItem?.title) continue;
    const item = normalizeBookshelfItem({
      ...rawItem,
      updatedAt: rawItem.updatedAt || now,
    });
    const previous = byKey.get(item.key);
    byKey.set(
      item.key,
      normalizeBookshelfItem({
        ...previous,
        ...item,
        addedAt: previous?.addedAt || item.addedAt || now,
        updatedAt: now,
        readerDocumentId: item.readerDocumentId || previous?.readerDocumentId,
        backupReaderDocumentId:
          item.backupReaderDocumentId || previous?.backupReaderDocumentId,
        thumbnailDataUrl: item.thumbnailDataUrl || previous?.thumbnailDataUrl,
        categoryStatus: item.categoryStatus || previous?.categoryStatus,
        categoryStage: item.categoryStage || previous?.categoryStage,
        categoryReason: item.categoryReason || previous?.categoryReason,
        category: item.category || previous?.category,
        progress: normalizedReaderProgress(item.progress || previous?.progress),
      })
    );
  }
  return writeReaderBookshelf([...byKey.values()]);
}

export function updateReaderBookshelfItem(item = {}, patch = {}) {
  const key = item.key || readerHistoryItemKey(item);
  if (!key) return readReaderBookshelf();
  const now = new Date().toISOString();
  return writeReaderBookshelf(
    readReaderBookshelf().map((bookshelfItem) => {
      if (bookshelfItem.key !== key) return bookshelfItem;
      return normalizeBookshelfItem({
        ...bookshelfItem,
        ...patch,
        updatedAt: patch.updatedAt || now,
        uploaded: isUploadedHistoryItem({ ...bookshelfItem, ...patch }),
        progress: patch.progress
          ? normalizedReaderProgress(patch.progress)
          : bookshelfItem.progress,
      });
    })
  );
}

export function deleteReaderBookshelfItems(keys = []) {
  const selected = new Set(Array.isArray(keys) ? keys : [keys]);
  return writeReaderBookshelf(
    readReaderBookshelf().filter((item) => !selected.has(item.key))
  );
}

export function writePendingBookshelfOpen(item = null) {
  if (!item) return;
  localStorage.setItem(
    READER_BOOKSHELF_PENDING_OPEN_KEY,
    JSON.stringify({ ...item, requestedAt: new Date().toISOString() })
  );
}

export function readPendingBookshelfOpen() {
  return safeJson(
    localStorage.getItem(READER_BOOKSHELF_PENDING_OPEN_KEY),
    null
  );
}

export function clearPendingBookshelfOpen() {
  localStorage.removeItem(READER_BOOKSHELF_PENDING_OPEN_KEY);
}

export function normalizedReaderProgress(progress = null) {
  const percent = Math.max(
    0,
    Math.min(100, Math.round(Number(progress?.percent || 0)))
  );
  return {
    label: progress?.label || "阅读进度",
    percent,
    locator: progress?.locator || null,
    scrollRatio:
      progress?.scrollRatio === undefined
        ? null
        : Math.max(0, Math.min(1, Number(progress.scrollRatio) || 0)),
    scrollTop:
      progress?.scrollTop === undefined
        ? null
        : Number(progress.scrollTop) || 0,
    updatedAt: progress?.updatedAt || null,
  };
}

function locatorChangedSignificantly(previousLocator, nextLocator) {
  if (!previousLocator && !nextLocator) return false;
  if (!previousLocator || !nextLocator) return true;
  const previousPage = Number(previousLocator.page || 0);
  const nextPage = Number(nextLocator.page || 0);
  if (previousPage || nextPage) return previousPage !== nextPage;
  return JSON.stringify(previousLocator) !== JSON.stringify(nextLocator);
}

export function hasSignificantProgressChange(previous = null, next = null) {
  const before = normalizedReaderProgress(previous);
  const after = normalizedReaderProgress(next);
  if (Math.abs(after.percent - before.percent) >= 1) return true;
  if (locatorChangedSignificantly(before.locator, after.locator)) return true;
  if (
    before.scrollRatio !== null &&
    after.scrollRatio !== null &&
    Math.abs(after.scrollRatio - before.scrollRatio) >= 0.01
  ) {
    return true;
  }
  if (
    before.scrollRatio === null &&
    after.scrollRatio !== null &&
    after.scrollRatio > 0.005
  ) {
    return true;
  }
  return false;
}

export function readerHistoryItemKey(item = {}) {
  if (!item?.title && !item?.bookKey) return null;
  const bookKey = item.bookKey || fallbackBookKey(item);
  const branchId = item.branchId || null;
  return branchId ? `${bookKey}:branch:${branchId}` : `${bookKey}:main`;
}

export function upsertReaderHistory(
  workspaceSlug,
  threadSlug = null,
  item = {}
) {
  if (!workspaceSlug || !item?.title)
    return readReaderHistory(workspaceSlug, threadSlug);
  const normalizedItem = normalizeHistoryItem(item);
  const itemKey = readerHistoryItemKey(normalizedItem);
  const now = new Date().toISOString();
  const current = readReaderHistory(workspaceSlug, threadSlug);
  const previous = current.find((historyItem) => historyItem.key === itemKey);
  const nextItem = {
    ...previous,
    source: normalizedItem.source,
    title: normalizedItem.title,
    documentType: normalizedItem.documentType,
    size: normalizedItem.size ?? previous?.size ?? null,
    bookKey: normalizedItem.bookKey,
    branchId: normalizedItem.branchId,
    branchLabel: normalizedItem.branchLabel,
    uploaded: isUploadedHistoryItem(normalizedItem) || previous?.uploaded,
    lastOpenedAt: item.lastOpenedAt || now,
    readerDocumentId:
      normalizedItem.readerDocumentId || previous?.readerDocumentId || null,
    backupReaderDocumentId:
      normalizedItem.backupReaderDocumentId ||
      previous?.backupReaderDocumentId ||
      null,
    workspaceDocPath:
      normalizedItem.workspaceDocPath || previous?.workspaceDocPath || null,
    localDocumentId:
      normalizedItem.localDocumentId || previous?.localDocumentId || null,
    localPath: normalizedItem.localPath || previous?.localPath || null,
    thumbnailDataUrl:
      normalizedItem.thumbnailDataUrl || previous?.thumbnailDataUrl || null,
    categoryStatus:
      normalizedItem.categoryStatus || previous?.categoryStatus || undefined,
    categoryStage:
      normalizedItem.categoryStage || previous?.categoryStage || "",
    categoryReason:
      normalizedItem.categoryReason || previous?.categoryReason || "",
    category: normalizedItem.category || previous?.category || undefined,
    progress: normalizedReaderProgress(
      normalizedItem.progress || previous?.progress
    ),
    key: itemKey,
  };
  const deduped = current.filter((historyItem) => historyItem.key !== itemKey);
  return writeReaderHistory(workspaceSlug, threadSlug, [nextItem, ...deduped]);
}

export function updateReaderHistoryItem(
  workspaceSlug,
  threadSlug = null,
  item = {},
  patch = {}
) {
  if (!workspaceSlug) return [];
  const key = item.key || readerHistoryItemKey(item);
  if (!key) return readReaderHistory(workspaceSlug, threadSlug);
  const current = readReaderHistory(workspaceSlug, threadSlug);
  const now = new Date().toISOString();
  const next = current.map((historyItem) => {
    if (historyItem.key !== key) return historyItem;
    return {
      ...historyItem,
      ...patch,
      uploaded: isUploadedHistoryItem({ ...historyItem, ...patch }),
      lastOpenedAt:
        patch.lastOpenedAt || (patch.progress ? now : historyItem.lastOpenedAt),
      progress: patch.progress
        ? normalizedReaderProgress(patch.progress)
        : historyItem.progress,
      key,
    };
  });
  return writeReaderHistory(workspaceSlug, threadSlug, next);
}

export function deleteReaderHistoryItem(
  workspaceSlug,
  threadSlug = null,
  item = {}
) {
  if (!workspaceSlug) return [];
  const key = item.key || readerHistoryItemKey(item);
  if (!key) return readReaderHistory(workspaceSlug, threadSlug);
  const current = readReaderHistory(workspaceSlug, threadSlug);
  const target = normalizeHistoryItem(item);
  return writeReaderHistory(
    workspaceSlug,
    threadSlug,
    current.filter((historyItem) => {
      if (target.branchId) return historyItem.key !== key;
      return historyItem.branchId || historyItem.bookKey !== target.bookKey;
    })
  );
}

function clearDeletedReaderDocumentIdsFromItem(
  item = {},
  deletedIds = new Set()
) {
  if (!item) return item;
  const readerDocumentId = deletedIds.has(item.readerDocumentId)
    ? null
    : item.readerDocumentId || null;
  const backupReaderDocumentId = deletedIds.has(item.backupReaderDocumentId)
    ? null
    : item.backupReaderDocumentId || null;
  return {
    ...item,
    readerDocumentId,
    backupReaderDocumentId,
    uploaded: !!(readerDocumentId || backupReaderDocumentId),
  };
}

export function clearDeletedReaderDocumentIdsFromAllStorage(ids = []) {
  const deletedIds = new Set(
    (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
  );
  if (!deletedIds.size) return { bookshelf: readReaderBookshelf() };

  const historyPrefix = "anythingllm_document_reader_history:v1:";
  const readerPrefix = "anythingllm_document_reader:v1:";
  for (const key of storageKeys(localStorage)) {
    if (!key) continue;
    if (key.startsWith(historyPrefix)) {
      const history = safeJson(localStorage.getItem(key), []);
      localStorage.setItem(
        key,
        JSON.stringify(
          normalizeHistory(
            history.map((item) =>
              clearDeletedReaderDocumentIdsFromItem(item, deletedIds)
            )
          )
        )
      );
      continue;
    }
    if (key.startsWith(readerPrefix) && !key.startsWith(historyPrefix)) {
      const document = safeJson(localStorage.getItem(key), null);
      if (!document) continue;
      localStorage.setItem(
        key,
        JSON.stringify(
          clearDeletedReaderDocumentIdsFromItem(document, deletedIds)
        )
      );
    }
  }

  const bookshelf = writeReaderBookshelf(
    readReaderBookshelf().map((item) =>
      clearDeletedReaderDocumentIdsFromItem(item, deletedIds)
    )
  );
  return { bookshelf };
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
    return { ok: false, error: "文件超过 500MB，伴读模式不会自动解析。" };
  }
  const ext = extensionFromName(file.name);
  if (!ALLOWED_READER_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      error: "伴读 MVP 仅支持 .md/.markdown/.pdf/.docx/.xlsx/.epub。",
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

export function firstSentenceSnippet(text = "", maxLength = 10) {
  const raw = String(text || "").trim();
  if (!raw) return "选中文本";
  const sentenceEnd = raw.search(/[。！？!?.\n]/);
  const firstSentence = sentenceEnd > -1 ? raw.slice(0, sentenceEnd + 1) : raw;
  const compact = firstSentence.replace(/\s+/g, " ").trim() || raw;
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}

export function tempTextSourceTitle(selection) {
  const snippet = firstSentenceSnippet(selection?.selectedText, 10);
  const documentTitle = selection?.documentTitle || "伴读文档";
  return `${snippet} - ${documentTitle}.txt`;
}

export function readerTextSourceKey(selection = {}) {
  return [
    selection.documentTitle || "文档",
    selection.locatorLabel || "",
    selection.textHash || textHash(selection.selectedText || ""),
  ].join(":");
}

export function tempTextSourceFromSelection(selection, citationNo = null) {
  if (!selection?.selectedText) return null;
  const title = tempTextSourceTitle(selection);
  const sourceKey = selection.sourceKey || readerTextSourceKey(selection);
  return {
    ...selection,
    sourceKey,
    citationNo,
    delivery: "txt",
    mime: "text/plain",
    fileName: title,
    tempTextTitle: title,
    locatorLabel: selection.locatorLabel || "选区",
  };
}

export function promptWithTempTextSources(prompt = "", sources = []) {
  const textSources = (sources || []).filter(
    (source) => source?.delivery === "txt" && source?.selectedText
  );
  if (!textSources.length) return prompt;
  const blocks = textSources
    .map((source, index) => {
      const name =
        source.tempTextTitle || source.fileName || `选区-${index + 1}.txt`;
      const locator = source.locatorLabel ? `（${source.locatorLabel}）` : "";
      return [
        `【伴读临时文本 ${index + 1}: ${name}${locator}】`,
        source.selectedText,
      ].join("\n");
    })
    .join("\n\n");
  return `${prompt}\n\n---\n以下是用户从伴读文档选中的临时 TXT 文本，请作为普通上下文处理，不需要提及文件机制：\n${blocks}`;
}

export function compactDocumentForStorage(document) {
  if (!document) return null;
  return {
    source: document.source,
    localDocumentId: document.localDocumentId || null,
    readerDocumentId: document.readerDocumentId || null,
    backupReaderDocumentId: document.backupReaderDocumentId || null,
    documentType: document.documentType,
    renderType: document.renderType || null,
    title: document.title,
    metadata: document.metadata,
    previewWarning:
      document.previewWarning || document.metadata?.previewWarning || null,
    progress: normalizedReaderProgress(document.progress),
    bookKey: document.bookKey || fallbackBookKey(document),
    branchId: document.branchId || null,
    branchLabel: document.branchLabel || null,
    localPath: document.localPath || document.metadata?.localPath || null,
    thumbnailDataUrl:
      document.thumbnailDataUrl || document.metadata?.thumbnailDataUrl || null,
    restoredAt: Date.now(),
  };
}
