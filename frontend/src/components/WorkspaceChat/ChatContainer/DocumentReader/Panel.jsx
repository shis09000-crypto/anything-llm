import { useEffect, useRef, useState } from "react";
import {
  Books,
  Clock,
  CheckCircle,
  CheckSquare,
  DotsThreeVertical,
  FileArrowUp,
  FileText,
  FloppyDisk,
  FolderOpen,
  Play,
  Plus,
  Square,
  Tag,
  Trash,
  X,
} from "@phosphor-icons/react";
import AppButton from "@/components/lib/AppButton";
import AppDropdownButton from "@/components/lib/AppDropdownButton";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import AppIcon from "@/components/lib/AppIcon";
import { debugChatTurn } from "@/utils/chat/debug";
import {
  effectiveReaderCategoryId,
  UNKNOWN_READER_CATEGORY_ID,
} from "./storage";
import { useDocumentReader } from "./Provider";
import ReaderMarkdownRenderer from "./ReaderMarkdownRenderer";
import XlsxReader from "./XlsxReader";
import PdfReader from "./PdfReader";
import EpubReader from "./EpubReader";

const READER_PROGRESS_AUTO_SAVE_INTERVAL_MS = 5000;

const HISTORY_TYPE_STYLES = {
  pdf: { label: "PDF", className: "bg-rose-500 text-white" },
  docx: { label: "W", className: "bg-blue-500 text-white" },
  markdown: { label: "MD", className: "bg-slate-300 text-white" },
  xlsx: { label: "XLS", className: "bg-emerald-500 text-white" },
  epub: { label: "EPUB", className: "bg-violet-500 text-white" },
  txt: { label: "TXT", className: "bg-emerald-500 text-white" },
};

const BOOKSHELF_SORT_OPTIONS = [
  { value: "recent", label: "最近阅读" },
  { value: "added", label: "加入时间" },
  { value: "progress", label: "阅读进度" },
  { value: "title", label: "书名" },
  { value: "type", label: "文件类型" },
];

function formatFileSize(size) {
  const bytes = Number(size || 0);
  if (!bytes) return "未知大小";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatHistoryTime(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  );
  const dayDiff = Math.round((startToday - startDate) / 86400000);
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (dayDiff === 0) return `今天 ${time}`;
  if (dayDiff === 1) return `昨天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function documentTypeLabel(type) {
  if (type === "docx") return "Word";
  if (type === "markdown") return "MD";
  if (type === "xlsx") return "XLSX";
  if (type === "epub") return "EPUB";
  return String(type || "DOC").toUpperCase();
}

function timestampValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function sortBookshelfItems(items = [], sortBy = "recent") {
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (sortBy === "added")
      return timestampValue(b.addedAt) - timestampValue(a.addedAt);
    if (sortBy === "progress")
      return (
        Number(b.progress?.percent || 0) - Number(a.progress?.percent || 0)
      );
    if (sortBy === "title")
      return String(a.title || "").localeCompare(
        String(b.title || ""),
        "zh-Hans"
      );
    if (sortBy === "type")
      return String(a.documentType || "").localeCompare(
        String(b.documentType || ""),
        "zh-Hans"
      );
    return (
      timestampValue(b.lastOpenedAt || b.updatedAt || b.addedAt) -
      timestampValue(a.lastOpenedAt || a.updatedAt || a.addedAt)
    );
  });
  return sorted;
}

function bookshelfSections(items = [], categories = [], sortBy = "recent") {
  const categoryMap = new Map(
    categories.map((category) => [category.id, category])
  );
  const pending = items
    .filter((item) => item.categoryStatus === "pending")
    .sort((a, b) => timestampValue(b.addedAt) - timestampValue(a.addedAt));
  const normalItems = sortBookshelfItems(
    items.filter((item) => item.categoryStatus !== "pending"),
    sortBy
  );
  const grouped = new Map();
  for (const item of normalItems) {
    const categoryId = effectiveReaderCategoryId(item, categories);
    if (!grouped.has(categoryId)) grouped.set(categoryId, []);
    grouped.get(categoryId).push(item);
  }
  const sections = [];
  if (pending.length)
    sections.push({
      id: "pending",
      name: "正在分类",
      pending: true,
      items: pending,
    });
  for (const category of categories) {
    const sectionItems = grouped.get(category.id) || [];
    if (!sectionItems.length) continue;
    sections.push({
      id: category.id,
      name: category.name,
      pending: false,
      items: sectionItems,
    });
  }
  for (const [categoryId, sectionItems] of grouped.entries()) {
    if (categoryMap.has(categoryId)) continue;
    const unknown = categoryMap.get(UNKNOWN_READER_CATEGORY_ID) || {
      id: UNKNOWN_READER_CATEGORY_ID,
      name: "未知分类",
    };
    sections.push({
      id: `${unknown.id}-missing-${categoryId}`,
      name: unknown.name,
      pending: false,
      items: sectionItems,
    });
  }
  return sections;
}

function historyTypeStyle(type) {
  return (
    HISTORY_TYPE_STYLES[type] || {
      label: "DOC",
      className: "bg-slate-400 text-white",
    }
  );
}

function ReaderHeader({ document, onUpload, onBindLocalPath, onExit }) {
  if (!document) return null;
  const parsedOnly = document.source === "workspace_parsed";
  const isDocxPreview = document.renderType === "pdf-preview";
  const isDocxFallback =
    document.documentType === "docx" && document.renderType !== "pdf-preview";
  const showUpload = document.source === "local" && !document.readerDocumentId;
  return (
    <div className="border-b border-white/10 px-4 py-3 pr-14 light:border-slate-200">
      <div className="flex items-start gap-3">
        <FileText
          size={20}
          className="mt-0.5 shrink-0 text-sky-300 light:text-sky-600"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="m-0 truncate text-sm font-semibold text-white light:text-slate-900">
              {document.title}
            </p>
            {parsedOnly && (
              <span className="shrink-0 rounded bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-200 light:text-amber-700">
                解析文本预览
              </span>
            )}
            {isDocxPreview && (
              <span className="shrink-0 rounded bg-sky-400/15 px-2 py-0.5 text-[11px] text-sky-200 light:text-sky-700">
                PDF 版式预览
              </span>
            )}
            {isDocxFallback && (
              <span className="shrink-0 rounded bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-200 light:text-amber-700">
                临时可读预览
              </span>
            )}
          </div>
          {parsedOnly && (
            <p className="m-0 mt-1 text-xs text-amber-200/80 light:text-amber-700">
              该文档不是原始版式，仅展示已解析内容
            </p>
          )}
          {isDocxFallback && (
            <p className="m-0 mt-1 text-xs text-amber-200/80 light:text-amber-700">
              版式预览生成失败，当前仅作为异常兜底的可读预览，不承诺 WPS/PDF
              版式和标记定位。
            </p>
          )}
        </div>
        {showUpload && (
          <AppButton
            variant="secondary"
            size="sm"
            onClick={onUpload}
            leftIcon={<FloppyDisk size={14} />}
            className="shrink-0"
          >
            上传备份
          </AppButton>
        )}
        {document.source === "local" && (
          <AppButton
            variant="secondary"
            size="sm"
            onClick={onBindLocalPath}
            className="shrink-0"
          >
            绑定路径
          </AppButton>
        )}
        <AppButton size="sm" onClick={onExit} className="shrink-0">
          退出
        </AppButton>
      </div>
    </div>
  );
}

function ReaderBody({
  document,
  onCite,
  onThumbnailReady,
  onProgressChange,
  readerTextSources = [],
  onFocusTextSource,
  onRemoveTextSource,
}) {
  if (!document) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/65 light:text-slate-600">
        请选择本地文档或工作区文档开始伴读。
      </div>
    );
  }

  if (
    document.documentType === "pdf" ||
    document.renderType === "pdf-preview"
  ) {
    return (
      <PdfReader
        document={document}
        onCite={onCite}
        onThumbnailReady={onThumbnailReady}
        onProgressChange={onProgressChange}
        readerTextSources={readerTextSources}
        onFocusTextSource={onFocusTextSource}
        onRemoveTextSource={onRemoveTextSource}
      />
    );
  }
  if (document.documentType === "epub") {
    return (
      <EpubReader
        document={document}
        onCite={onCite}
        onThumbnailReady={onThumbnailReady}
        onProgressChange={onProgressChange}
        readerTextSources={readerTextSources}
        onFocusTextSource={onFocusTextSource}
        onRemoveTextSource={onRemoveTextSource}
      />
    );
  }
  if (["markdown", "docx"].includes(document.documentType)) {
    return (
      <ReaderMarkdownRenderer
        document={document}
        onCite={onCite}
        readerTextSources={readerTextSources}
        onFocusTextSource={onFocusTextSource}
        onRemoveTextSource={onRemoveTextSource}
      />
    );
  }
  if (document.documentType === "xlsx") {
    return <XlsxReader document={document} onCite={onCite} />;
  }
  return (
    <p className="text-sm text-white/50 light:text-slate-500">
      当前格式只能 fallback 预览，暂不支持结构化引用。
    </p>
  );
}

function DocxPreviewLoadingOverlay({ status }) {
  if (!status) return null;
  return (
    <div className="absolute inset-0 z-[85] flex items-center justify-center bg-slate-950/24 px-6 backdrop-blur-sm">
      <div className="flex w-full max-w-[360px] items-center gap-4 rounded-2xl border border-white/80 bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.24)]">
        <div className="h-10 w-10 shrink-0 animate-spin rounded-full border-4 border-blue-100 border-t-blue-500" />
        <div className="min-w-0">
          <p className="m-0 text-sm font-bold text-slate-950">
            {status.message || "正在生成版式预览"}
          </p>
          <p className="m-0 mt-1 truncate text-xs text-slate-500">
            {status.fileName}
          </p>
        </div>
      </div>
    </div>
  );
}

function BookshelfCard({
  item,
  selecting,
  selected,
  highlighted,
  categories = [],
  onToggle,
  onOpen,
  onChangeCategory,
  onReclassify,
  onDelete,
}) {
  const style = historyTypeStyle(item.documentType);
  const [menuOpen, setMenuOpen] = useState(false);
  const progressPercent = Math.max(
    0,
    Math.min(100, Number(item.progress?.percent || 0))
  );
  const category =
    categories.find(
      (candidate) => candidate.id === item.category?.primaryCategoryId
    ) ||
    categories.find((candidate) => candidate.id === UNKNOWN_READER_CATEGORY_ID);
  const isPending = item.categoryStatus === "pending";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => (selecting ? onToggle?.() : onOpen?.())}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selecting ? onToggle?.() : onOpen?.();
        }
      }}
      className={[
        "reader-bookshelf-card cursor-pointer",
        "group min-w-0 rounded-2xl border bg-white/70 p-3 text-left shadow-[0_14px_32px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 hover:bg-white",
        highlighted ? "reader-bookshelf-upload-pulse" : "",
        selected ? "border-blue-400 ring-2 ring-blue-200" : "border-white/76",
      ].join(" ")}
    >
      <div className="relative mx-auto aspect-[3/4] w-full max-w-[138px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_18px_34px_rgba(15,23,42,0.14)]">
        {item.thumbnailDataUrl ? (
          <img
            src={item.thumbnailDataUrl}
            alt=""
            className="h-full w-full object-contain bg-white"
          />
        ) : (
          <div
            className={`flex h-full w-full items-center justify-center text-sm font-black ${style.className}`}
          >
            {style.label}
          </div>
        )}
        {!selecting && !isPending && (
          <span
            className={[
              "reader-bookshelf-card-action absolute right-2 top-2 z-10",
              menuOpen ? "reader-bookshelf-card-action-open" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={(event) => event.stopPropagation()}
          >
            <AppDropdownButton
              iconOnly
              size="sm"
              open={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              onOpenChange={setMenuOpen}
              icon={
                <AppIcon
                  name="more"
                  size="xs"
                  tone="muted"
                  weight="bold"
                  style={{
                    "--app-icon-size-shell": "18px",
                    "--app-icon-size-symbol": "11px",
                  }}
                />
              }
              menuWidth={158}
              menuMinWidth={158}
              portalMenu
              className="reader-bookshelf-card-more"
              menuClassName="reader-bookshelf-card-menu"
              menu={
                <>
                  <AppDropdownButton.Item
                    icon={<Tag size={14} />}
                    onClick={() => {
                      setMenuOpen(false);
                      onChangeCategory?.();
                    }}
                  >
                    更改分类
                  </AppDropdownButton.Item>
                  <AppDropdownButton.Item
                    icon={<AppIcon name="refresh" size="xs" />}
                    onClick={() => {
                      setMenuOpen(false);
                      onReclassify?.();
                    }}
                  >
                    重新自动分类
                  </AppDropdownButton.Item>
                  <AppDropdownButton.Item
                    icon={<Trash size={14} />}
                    className="reader-bookshelf-card-menu-danger"
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete?.();
                    }}
                  >
                    删除
                  </AppDropdownButton.Item>
                </>
              }
              aria-label="书籍更多操作"
            />
          </span>
        )}
        {selecting && (
          <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-blue-600 shadow-[0_8px_18px_rgba(15,23,42,0.18)]">
            {selected ? (
              <CheckSquare size={18} weight="fill" />
            ) : (
              <Square size={18} />
            )}
          </span>
        )}
      </div>
      <p className="m-0 mt-3 line-clamp-2 min-h-[36px] text-sm font-bold leading-[18px] text-slate-900">
        {item.title}
      </p>
      <p className="m-0 mt-1 truncate text-[11px] font-semibold text-slate-500">
        {isPending
          ? item.categoryReason || "正在分类"
          : category?.name || "未知分类"}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200/80">
          <div
            className="h-full rounded-full bg-blue-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <span className="shrink-0 text-[11px] font-bold text-slate-500">
          {progressPercent}%
        </span>
      </div>
    </div>
  );
}

function HistoryBookshelfPicker({
  open,
  readerHistory = [],
  onClose,
  onConfirm,
}) {
  const [selectedKeys, setSelectedKeys] = useState([]);

  useEffect(() => {
    if (open) setSelectedKeys([]);
  }, [open]);

  if (!open) return null;

  const selected = new Set(selectedKeys);
  const toggle = (item) => {
    setSelectedKeys((current) =>
      current.includes(item.key)
        ? current.filter((key) => key !== item.key)
        : [...current, item.key]
    );
  };

  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-slate-950/28 px-6 backdrop-blur-sm">
      <div className="flex max-h-[78%] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-white/80 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.24)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <p className="m-0 text-base font-bold text-slate-950">
              从历史加入书架
            </p>
            <p className="m-0 mt-1 text-xs font-medium text-slate-500">
              可多选历史记录，加入后会复用书架去重逻辑。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {readerHistory.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {readerHistory.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => toggle(item)}
                  className={[
                    "flex min-h-[76px] items-center gap-3 rounded-2xl border px-3 py-2 text-left transition",
                    selected.has(item.key)
                      ? "border-blue-300 bg-blue-50"
                      : "border-slate-200 bg-white hover:bg-slate-50",
                  ].join(" ")}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-blue-600">
                    {selected.has(item.key) ? (
                      <CheckSquare size={18} weight="fill" />
                    ) : (
                      <Square size={18} />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-slate-900">
                      {item.title}
                    </span>
                    <span className="mt-1 block text-xs font-medium text-slate-500">
                      阅读进度 ·{" "}
                      {Math.round(Number(item.progress?.percent || 0))}%
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="m-0 py-10 text-center text-sm text-slate-500">
              暂无可加入的历史记录。
            </p>
          )}
        </div>
        <div className="flex justify-end gap-3 border-t border-slate-100 px-5 py-4">
          <AppButton variant="secondary" size="sm" onClick={onClose}>
            取消
          </AppButton>
          <AppButton
            size="sm"
            disabled={!selectedKeys.length}
            onClick={() => {
              onConfirm?.(
                readerHistory.filter((item) => selected.has(item.key))
              );
              onClose?.();
            }}
          >
            加入 {selectedKeys.length} 本
          </AppButton>
        </div>
      </div>
    </div>
  );
}

function CategoryPickerModal({ item, categories = [], onClose, onSelect }) {
  if (!item) return null;
  return (
    <div className="absolute inset-0 z-[90] flex items-center justify-center bg-slate-950/28 px-6 backdrop-blur-sm">
      <div className="flex max-h-[78%] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-white/80 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.24)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <p className="m-0 text-base font-bold text-slate-950">更改分类</p>
            <p className="m-0 mt-1 truncate text-xs font-medium text-slate-500">
              {item.title}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="grid min-h-0 grid-cols-2 gap-3 overflow-y-auto p-5 sm:grid-cols-3">
          {categories.map((category) => (
            <AppButton
              key={category.id}
              variant="secondary"
              size="sm"
              onClick={() => {
                onSelect?.(item, category.id);
                onClose?.();
              }}
              className="justify-center"
            >
              {category.name}
            </AppButton>
          ))}
        </div>
      </div>
    </div>
  );
}

function CategoryManagerModal({
  open,
  categories = [],
  readerBookshelf = [],
  onClose,
  onCreate,
  onRename,
  onDelete,
}) {
  if (!open) return null;
  const counts = new Map();
  for (const item of readerBookshelf) {
    const categoryId = effectiveReaderCategoryId(item, categories);
    counts.set(categoryId, (counts.get(categoryId) || 0) + 1);
  }
  return (
    <div className="absolute inset-0 z-[90] flex items-center justify-center bg-slate-950/28 px-6 backdrop-blur-sm">
      <div className="flex max-h-[82%] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-white/80 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.24)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <p className="m-0 text-base font-bold text-slate-950">分类管理</p>
            <p className="m-0 mt-1 text-xs font-medium text-slate-500">
              可新增、重命名和删除空分类。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="flex justify-end pb-3">
            <AppButton
              size="sm"
              leftIcon={<Plus size={14} />}
              onClick={() => {
                const name = window.prompt("请输入新分类名称");
                if (name?.trim()) onCreate?.(name.trim());
              }}
            >
              新增分类
            </AppButton>
          </div>
          <div className="flex flex-col gap-2">
            {categories.map((category) => {
              const count = counts.get(category.id) || 0;
              const isUnknown = category.id === UNKNOWN_READER_CATEGORY_ID;
              const deleteDisabled = isUnknown || count > 0;
              return (
                <div
                  key={category.id}
                  className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-sm font-bold text-slate-900">
                      {category.name}
                    </p>
                    <p className="m-0 mt-0.5 text-xs font-medium text-slate-500">
                      {count} 本{isUnknown ? " · 固定兜底分类" : ""}
                    </p>
                  </div>
                  <AppButton
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const name = window.prompt(
                        "请输入新的分类名称",
                        category.name
                      );
                      if (name?.trim()) onRename?.(category.id, name.trim());
                    }}
                  >
                    重命名
                  </AppButton>
                  <AppButton
                    variant={deleteDisabled ? "secondary" : "primary"}
                    size="sm"
                    disabled={deleteDisabled}
                    title={
                      count > 0
                        ? "该分类下还有书籍，请先移动或修改这些书籍的分类后再删除。"
                        : isUnknown
                          ? "未知分类不可删除。"
                          : ""
                    }
                    onClick={() => onDelete?.(category.id)}
                    className={
                      deleteDisabled ? "" : "reader-category-delete-button"
                    }
                  >
                    删除
                  </AppButton>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReaderDrawer({
  workspace,
  initialSection = "history",
  onSectionChange,
  onOpenFile,
  onUploadBookshelfFiles,
  onOpenWorkspaceDoc,
  readerHistory = [],
  readerBookshelf = [],
  readerCategories = [],
  onOpenHistoryDocument,
  onOpenBookshelfDocument,
  onAddHistoryItemsToBookshelf,
  onDeleteBookshelfItems,
  onCreateCategory,
  onRenameCategory,
  onDeleteCategory,
  onUpdateBookCategory,
  onReclassifyBook,
  onClearHistory,
  onDeleteHistoryItem,
}) {
  const fileInputRef = useRef(null);
  const bookshelfFileInputRef = useRef(null);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [bookshelfAddOpen, setBookshelfAddOpen] = useState(false);
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [categoryPickerItem, setCategoryPickerItem] = useState(null);
  const [bookshelfSortMenuOpen, setBookshelfSortMenuOpen] = useState(false);
  const [bookshelfSelecting, setBookshelfSelecting] = useState(false);
  const [bookshelfSortBy, setBookshelfSortBy] = useState("recent");
  const [selectedBookshelfKeys, setSelectedBookshelfKeys] = useState([]);
  const [activeSection, setActiveSection] = useState(initialSection);
  const [highlightedBookshelfKeys, setHighlightedBookshelfKeys] = useState([]);
  const documents = workspace?.documents || [];
  const hasHistory = readerHistory.length > 0;
  const hasBookshelf = readerBookshelf.length > 0;
  const selectedBooks = new Set(selectedBookshelfKeys);
  const selectedBookshelfItems = readerBookshelf.filter((item) =>
    selectedBooks.has(item.key)
  );
  const allBookshelfSelected =
    hasBookshelf && selectedBookshelfKeys.length === readerBookshelf.length;
  const showingHistory = activeSection === "history";
  const showingBookshelf = activeSection === "bookshelf";
  const showingWorkspace = activeSection === "workspace";
  const bookshelfGroupedSections = bookshelfSections(
    readerBookshelf,
    readerCategories,
    bookshelfSortBy
  );
  const selectedBookshelfSort =
    BOOKSHELF_SORT_OPTIONS.find((option) => option.value === bookshelfSortBy) ||
    BOOKSHELF_SORT_OPTIONS[0];

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    onSectionChange?.(activeSection);
  }, [activeSection, onSectionChange]);

  useEffect(() => {
    if (!highlightedBookshelfKeys.length) return;
    const timeout = window.setTimeout(() => {
      setHighlightedBookshelfKeys([]);
    }, 2200);
    return () => window.clearTimeout(timeout);
  }, [highlightedBookshelfKeys]);

  const openHistory = async (historyItem) => {
    const result = await onOpenHistoryDocument?.(historyItem);
    if (result?.needsLocalFile) fileInputRef.current?.click();
  };

  const openBookshelf = async (bookshelfItem) => {
    const result = await onOpenBookshelfDocument?.(bookshelfItem);
    if (result?.needsLocalFile) fileInputRef.current?.click();
  };

  const toggleBookshelfSelection = (item) => {
    setSelectedBookshelfKeys((current) =>
      current.includes(item.key)
        ? current.filter((key) => key !== item.key)
        : [...current, item.key]
    );
  };

  const cancelBookshelfSelection = () => {
    setBookshelfSelecting(false);
    setSelectedBookshelfKeys([]);
  };

  const openBookshelfSection = () => {
    setWorkspacePickerOpen(false);
    setActiveSection("bookshelf");
  };

  const openWorkspaceSection = () => {
    setWorkspacePickerOpen(false);
    setBookshelfAddOpen(false);
    cancelBookshelfSelection();
    setActiveSection("workspace");
  };

  const openHistorySection = () => {
    setWorkspacePickerOpen(false);
    setBookshelfAddOpen(false);
    cancelBookshelfSelection();
    setActiveSection("history");
  };

  const confirmAndDeleteBooks = async (items = []) => {
    if (!items.length) return false;
    const confirmed = await showAppConfirm({
      tone: "danger",
      title: "确认删除书籍",
      description: `将删除 ${items.length} 本书，并同步删除对应服务器备份和历史记录中的同本书。`,
      body: "此操作会同步清理书架、历史记录和已上传备份状态。",
      confirmText: "确认删除",
    });
    if (!confirmed) return false;
    await onDeleteBookshelfItems?.(items);
    return true;
  };

  const deleteSelectedBooks = async () => {
    const deleted = await confirmAndDeleteBooks(selectedBookshelfItems);
    if (!deleted) return;
    cancelBookshelfSelection();
  };

  const deleteBookshelfItem = async (item) => {
    await confirmAndDeleteBooks([item]);
  };

  const uploadBookshelfFiles = async (files = []) => {
    const addedItems = await onUploadBookshelfFiles?.(files);
    if (!Array.isArray(addedItems) || !addedItems.length) return;
    setWorkspacePickerOpen(false);
    setBookshelfAddOpen(false);
    cancelBookshelfSelection();
    setActiveSection("bookshelf");
    setHighlightedBookshelfKeys(addedItems.map((item) => item.key));
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[linear-gradient(135deg,#eef7ff_0%,#f8fbff_44%,#ffffff_100%)] px-5 pb-5 pt-8">
      <style>
        {`
          @keyframes readerBookshelfUploadPulse {
            0%, 100% {
              box-shadow: 0 14px 32px rgba(15, 23, 42, 0.08);
              transform: translateY(0);
            }
            50% {
              box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.22), 0 18px 40px rgba(59, 130, 246, 0.2);
              transform: translateY(-2px);
            }
          }
          .reader-bookshelf-upload-pulse {
            animation: readerBookshelfUploadPulse 1s cubic-bezier(0.22, 1, 0.36, 1) 2;
          }
          .reader-category-delete-button {
            --app-button-gradient-start: #fb7185;
            --app-button-gradient-middle: #ef4444;
            --app-button-gradient-end: #dc2626;
            --app-button-shadow-strength: 0.18;
            --app-button-glow-blur: 20px;
            --app-button-border-opacity: 0.54;
            --app-button-hover-lift: 1px;
          }
          .reader-category-delete-button:focus-visible {
            outline-color: rgb(220 38 38 / 0.68);
            box-shadow:
              0 0 0 5px rgb(248 113 113 / 0.18),
              0 12px 24px rgb(220 38 38 / 0.2),
              inset 0 1px 0 rgb(255 255 255 / 0.5);
          }
          .reader-bookshelf-card-more {
            --app-dropdown-button-height: 24px;
            --app-dropdown-button-radius: 999px;
            --app-dropdown-button-bg-alpha: 0.92;
            --app-dropdown-button-border-alpha: 0.52;
            --app-dropdown-button-shadow-alpha: 0.06;
            --app-dropdown-button-blur: 8px;
          }
          .reader-bookshelf-card-more .app-dropdown-button {
            box-shadow:
              0 6px 14px rgba(15, 23, 42, 0.1),
              inset 0 1px 0 rgba(255, 255, 255, 0.9);
          }
          .reader-bookshelf-card-action {
            opacity: 0;
            pointer-events: none;
            transform: translateY(-2px) scale(0.96);
            transition:
              opacity 140ms ease,
              transform 140ms ease;
          }
          .reader-bookshelf-card:hover .reader-bookshelf-card-action,
          .reader-bookshelf-card:focus-within .reader-bookshelf-card-action,
          .reader-bookshelf-card-action-open {
            opacity: 1;
            pointer-events: auto;
            transform: translateY(0) scale(1);
          }
          .reader-bookshelf-card-menu.app-dropdown-button-menu,
          .reader-bookshelf-sort-menu.app-dropdown-button-menu,
          .reader-bookshelf-add-menu.app-dropdown-button-menu {
            --app-dropdown-menu-radius: 13px;
            --app-dropdown-menu-bg-alpha: 0.9;
            --app-dropdown-menu-shadow-alpha: 0.1;
            padding: 6px;
          }
          .reader-bookshelf-card-menu .app-dropdown-button-menu-item,
          .reader-bookshelf-sort-menu .app-dropdown-button-menu-item,
          .reader-bookshelf-add-menu .app-dropdown-button-menu-item {
            min-height: 31px;
            gap: 7px;
            border-radius: 9px;
            padding: 0 9px;
            font-size: 12px;
            font-weight: 740;
          }
          .reader-bookshelf-card-menu .app-dropdown-button-menu-item-icon,
          .reader-bookshelf-sort-menu .app-dropdown-button-menu-item-icon,
          .reader-bookshelf-add-menu .app-dropdown-button-menu-item-icon {
            width: 15px;
            height: 15px;
          }
          .reader-bookshelf-card-menu .app-dropdown-button-menu-item-icon svg,
          .reader-bookshelf-sort-menu .app-dropdown-button-menu-item-icon svg,
          .reader-bookshelf-add-menu .app-dropdown-button-menu-item-icon svg {
            width: 15px;
            height: 15px;
          }
          .reader-bookshelf-card-menu .reader-bookshelf-card-menu-danger {
            color: #dc2626;
          }
          .reader-bookshelf-card-menu .reader-bookshelf-card-menu-danger .app-dropdown-button-menu-item-icon {
            color: #dc2626;
          }
          .reader-bookshelf-card-menu .reader-bookshelf-card-menu-danger:not(:disabled):hover {
            background: rgb(254 226 226 / 0.74);
            color: #b91c1c;
          }
          .reader-bookshelf-sort-button,
          .reader-bookshelf-add-button {
            --app-dropdown-button-height: 34px;
            --app-dropdown-button-bg-alpha: 0.78;
            --app-dropdown-button-shadow-alpha: 0.08;
            --app-dropdown-button-blur: 12px;
          }
          .reader-bookshelf-sort-button .app-dropdown-button,
          .reader-bookshelf-add-button .app-dropdown-button {
            min-width: 92px;
            gap: 6px;
          }
        `}
      </style>
      <HistoryBookshelfPicker
        open={historyPickerOpen}
        readerHistory={readerHistory}
        onClose={() => setHistoryPickerOpen(false)}
        onConfirm={onAddHistoryItemsToBookshelf}
      />
      <CategoryPickerModal
        item={categoryPickerItem}
        categories={readerCategories}
        onClose={() => setCategoryPickerItem(null)}
        onSelect={onUpdateBookCategory}
      />
      <CategoryManagerModal
        open={categoryManagerOpen}
        categories={readerCategories}
        readerBookshelf={readerBookshelf}
        onClose={() => setCategoryManagerOpen(false)}
        onCreate={onCreateCategory}
        onRename={onRenameCategory}
        onDelete={onDeleteCategory}
      />
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-sky-200/28 blur-3xl" />
        <div className="absolute -right-20 bottom-10 h-80 w-80 rounded-full bg-blue-200/24 blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-28 bg-[linear-gradient(180deg,transparent,rgba(255,255,255,0.65))]" />
      </div>
      <div className="relative z-10 grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)] gap-5 overflow-visible">
        <div
          className={[
            "relative flex min-h-0 flex-col overflow-visible rounded-[22px] border border-white/70 bg-white/42 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.88),0_18px_44px_rgba(15,23,42,0.08)] backdrop-blur-xl",
            workspacePickerOpen ? "z-[90]" : "z-20",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="motion-hover group relative flex min-h-[98px] w-full items-center gap-3 rounded-2xl border border-sky-200/80 bg-sky-50/76 px-4 text-left shadow-[0_16px_34px_rgba(59,130,246,0.15)] hover:-translate-y-0.5 hover:border-sky-300 hover:bg-sky-50"
          >
            <span className="absolute left-0 top-4 h-14 w-1 rounded-r-full bg-blue-500" />
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-sky-200 bg-white/86 text-sky-600 shadow-[0_12px_26px_rgba(14,165,233,0.18)]">
              <FileArrowUp size={24} />
            </span>
            <span>
              <span className="block text-base font-bold text-slate-900">
                本地文档
              </span>
              <span className="mt-1 block text-xs font-medium text-slate-500">
                从本地上传文档
              </span>
            </span>
          </button>
          <div
            className={["relative mt-3", workspacePickerOpen ? "z-[100]" : ""]
              .filter(Boolean)
              .join(" ")}
          >
            <button
              type="button"
              onClick={openWorkspaceSection}
              className={[
                "motion-hover group flex min-h-[92px] w-full items-center gap-3 rounded-2xl border px-4 text-left shadow-[0_14px_30px_rgba(15,23,42,0.08)] hover:-translate-y-0.5",
                showingWorkspace
                  ? "border-blue-200 bg-blue-50/78 shadow-[0_16px_34px_rgba(59,130,246,0.14)]"
                  : "border-white/70 bg-white/66 hover:border-blue-200 hover:bg-white/82",
              ].join(" ")}
              aria-current={showingWorkspace ? "page" : undefined}
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/88 text-blue-600 shadow-[0_12px_26px_rgba(59,130,246,0.12)]">
                <FolderOpen size={24} />
              </span>
              <span>
                <span className="block text-[14px] font-bold text-slate-900">
                  工作区文档
                </span>
                <span className="mt-1 block text-xs font-medium text-slate-500">
                  从工作区选择文档
                </span>
              </span>
            </button>
            {workspacePickerOpen && (
              <div className="absolute left-0 top-full z-[110] mt-3 max-h-[260px] w-[min(340px,calc(100vw-64px))] overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.18)]">
                <div className="border-b border-slate-200/80 px-4 py-3">
                  <p className="m-0 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Workspace 解析文本
                  </p>
                </div>
                {documents.length > 0 ? (
                  <div className="max-h-[204px] divide-y divide-slate-100 overflow-y-auto">
                    {documents.map((doc) => {
                      const docPath = doc.docpath || doc.name;
                      return (
                        <button
                          key={docPath}
                          type="button"
                          onClick={() => {
                            setWorkspacePickerOpen(false);
                            onOpenWorkspaceDoc(docPath);
                          }}
                          className="block w-full truncate px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-sky-50 hover:text-sky-700 focus:bg-sky-50 focus:outline-none"
                        >
                          {doc.title || doc.name || docPath}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="m-0 px-4 py-5 text-center text-sm text-slate-500">
                    当前工作区没有可预览的解析文本。
                  </p>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={openHistorySection}
            className={[
              "motion-hover mt-3 flex min-h-[92px] w-full items-center gap-3 rounded-2xl border px-4 text-left hover:-translate-y-0.5",
              showingHistory
                ? "border-emerald-200 bg-emerald-50/76 shadow-[0_16px_34px_rgba(16,185,129,0.14)]"
                : "border-white/60 bg-white/44 hover:border-emerald-200 hover:bg-white/70",
            ].join(" ")}
          >
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-500 shadow-[0_12px_26px_rgba(16,185,129,0.12)]">
              <Clock size={24} />
            </span>
            <span>
              <span className="block text-base font-bold text-slate-900">
                历史文档
              </span>
              <span className="mt-1 block text-xs font-medium text-slate-500">
                查看最近阅读记录
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={openBookshelfSection}
            className={[
              "motion-hover mt-3 flex min-h-[92px] w-full items-center gap-3 rounded-2xl border px-4 text-left hover:-translate-y-0.5",
              showingBookshelf
                ? "border-violet-200 bg-violet-50/78 shadow-[0_16px_34px_rgba(139,92,246,0.14)]"
                : "border-white/60 bg-white/44 hover:border-violet-200 hover:bg-white/70",
            ].join(" ")}
          >
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-violet-50 text-violet-500 shadow-[0_12px_26px_rgba(139,92,246,0.12)]">
              <Books size={24} />
            </span>
            <span>
              <span className="block text-base font-bold text-slate-900">
                我的书架
              </span>
              <span className="mt-1 block text-xs font-medium text-slate-500">
                常读书籍
              </span>
            </span>
          </button>
        </div>
        <div className="relative z-10 flex min-h-0 flex-col rounded-[22px] border border-white/70 bg-white/52 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_18px_44px_rgba(15,23,42,0.08)] backdrop-blur-xl">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="mt-1 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-slate-800 shadow-[0_10px_24px_rgba(15,23,42,0.1)]">
                {showingWorkspace ? (
                  <FolderOpen size={20} />
                ) : showingBookshelf ? (
                  <Books size={20} />
                ) : (
                  <Clock size={20} />
                )}
              </span>
              <div>
                <h2 className="m-0 text-lg font-bold text-slate-950">
                  {showingWorkspace
                    ? "工作区文档"
                    : showingBookshelf
                      ? "我的书架"
                      : "历史阅读文档"}
                </h2>
                <p className="m-0 mt-1 text-xs font-medium text-slate-500">
                  {showingWorkspace
                    ? "从当前工作区选择已解析文档"
                    : showingBookshelf
                      ? "可以放置常看书籍，系统会自动整理"
                      : "查看并继续阅读最近打开的文档"}
                </p>
              </div>
            </div>
            {showingHistory && (
              <AppButton
                size="sm"
                onClick={onClearHistory}
                disabled={!hasHistory}
                leftIcon={<Trash size={15} />}
                className="reader-clear-history-button shrink-0"
              >
                清空记录
              </AppButton>
            )}
            {showingBookshelf &&
              (bookshelfSelecting ? (
                <div className="flex shrink-0 items-center gap-2">
                  <AppButton
                    variant="secondary"
                    size="sm"
                    onClick={cancelBookshelfSelection}
                  >
                    取消
                  </AppButton>
                  <AppButton
                    size="sm"
                    disabled={!hasBookshelf}
                    onClick={() =>
                      setSelectedBookshelfKeys(
                        allBookshelfSelected
                          ? []
                          : readerBookshelf.map((item) => item.key)
                      )
                    }
                  >
                    {allBookshelfSelected ? "取消全选" : "全选"}
                  </AppButton>
                  <AppButton
                    size="sm"
                    disabled={!selectedBookshelfKeys.length}
                    onClick={deleteSelectedBooks}
                    leftIcon={<Trash size={15} />}
                    className="border-0 bg-gradient-to-r from-rose-500 to-red-600 text-white hover:from-rose-500 hover:to-red-500"
                  >
                    删除
                  </AppButton>
                </div>
              ) : (
                <div className="relative flex shrink-0 items-center gap-2">
                  <AppDropdownButton
                    size="sm"
                    open={bookshelfSortMenuOpen}
                    onClick={() => setBookshelfSortMenuOpen((open) => !open)}
                    onOpenChange={setBookshelfSortMenuOpen}
                    portalMenu
                    menuWidth={124}
                    menuMinWidth={124}
                    className="reader-bookshelf-sort-button app-dropdown-button-compact"
                    menuClassName="reader-bookshelf-sort-menu"
                    menu={BOOKSHELF_SORT_OPTIONS.map((option) => (
                      <AppDropdownButton.Item
                        key={option.value}
                        icon={
                          option.value === bookshelfSortBy ? (
                            <CheckCircle size={14} weight="fill" />
                          ) : (
                            <span className="inline-flex h-[14px] w-[14px]" />
                          )
                        }
                        onClick={() => {
                          setBookshelfSortBy(option.value);
                          setBookshelfSortMenuOpen(false);
                        }}
                      >
                        {option.label}
                      </AppDropdownButton.Item>
                    ))}
                    aria-label="书架排序"
                  >
                    {selectedBookshelfSort.label}
                  </AppDropdownButton>
                  <AppButton
                    variant="secondary"
                    size="sm"
                    onClick={() => setCategoryManagerOpen(true)}
                  >
                    分类管理
                  </AppButton>
                  <AppDropdownButton
                    size="sm"
                    open={bookshelfAddOpen}
                    onClick={() => setBookshelfAddOpen((open) => !open)}
                    onOpenChange={setBookshelfAddOpen}
                    icon={<Plus size={14} weight="bold" />}
                    portalMenu
                    menuWidth={136}
                    menuMinWidth={136}
                    className="reader-bookshelf-add-button app-dropdown-button-compact"
                    menuClassName="reader-bookshelf-add-menu"
                    menu={
                      <>
                        <AppDropdownButton.Item
                          icon={<Clock size={14} />}
                          onClick={() => {
                            setBookshelfAddOpen(false);
                            setHistoryPickerOpen(true);
                          }}
                        >
                          从历史加入
                        </AppDropdownButton.Item>
                        <AppDropdownButton.Item
                          icon={<FileArrowUp size={14} />}
                          onClick={() => {
                            setBookshelfAddOpen(false);
                            bookshelfFileInputRef.current?.click();
                          }}
                        >
                          上传新书
                        </AppDropdownButton.Item>
                      </>
                    }
                    aria-label="加入书籍"
                  >
                    加入书籍
                  </AppDropdownButton>
                  <AppButton
                    variant="secondary"
                    size="sm"
                    disabled={!hasBookshelf}
                    onClick={() => setBookshelfSelecting(true)}
                  >
                    选择
                  </AppButton>
                </div>
              ))}
          </div>
          <div
            className={[
              "mt-6 min-h-0 flex-1 overflow-y-auto pr-1",
              showingBookshelf ? "pt-2" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {showingWorkspace ? (
              documents.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {documents.map((doc) => {
                    const docPath = doc.docpath || doc.name;
                    return (
                      <button
                        key={docPath}
                        type="button"
                        onClick={() => onOpenWorkspaceDoc(docPath)}
                        className="block w-full rounded-2xl border border-slate-200/80 bg-white/74 px-4 py-3 text-left text-sm font-semibold text-slate-700 shadow-[0_10px_24px_rgba(15,23,42,0.05)] hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700 focus:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                      >
                        <span className="block truncate">
                          {doc.title || doc.name || docPath}
                        </span>
                        {docPath && (
                          <span className="mt-1 block truncate text-xs font-medium text-slate-400">
                            {docPath}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200/90 bg-white/40 px-6 text-center">
                  <FolderOpen size={34} className="text-slate-300" />
                  <p className="m-0 mt-3 text-sm font-semibold text-slate-700">
                    当前工作区没有可预览的解析文本
                  </p>
                  <p className="m-0 mt-1 max-w-[280px] text-xs leading-5 text-slate-500">
                    上传并解析文档后，可以从这里进入伴读。
                  </p>
                </div>
              )
            ) : showingHistory && hasHistory ? (
              <div className="flex flex-col gap-3">
                {readerHistory.map((item) => (
                  <HistoryDocumentCard
                    key={item.key}
                    item={item}
                    onOpen={() => openHistory(item)}
                    onDelete={() => onDeleteHistoryItem?.(item)}
                  />
                ))}
              </div>
            ) : showingHistory ? (
              <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200/90 bg-white/40 px-6 text-center">
                <Clock size={34} className="text-slate-300" />
                <p className="m-0 mt-3 text-sm font-semibold text-slate-700">
                  暂无历史阅读记录
                </p>
                <p className="m-0 mt-1 max-w-[280px] text-xs leading-5 text-slate-500">
                  打开本地、服务器备份或工作区解析文档后，这里会显示最近阅读记录。
                </p>
              </div>
            ) : hasBookshelf ? (
              <div className="flex flex-col gap-6">
                {bookshelfGroupedSections.map((section) => (
                  <section key={section.id}>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="m-0 text-sm font-black text-slate-900">
                        {section.name} · {section.items.length} 本
                      </h3>
                      {section.pending && (
                        <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-bold text-blue-600">
                          后台处理中
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(116px,1fr))] gap-4 min-[1280px]:grid-cols-4">
                      {section.items.map((item) => (
                        <BookshelfCard
                          key={item.key}
                          item={item}
                          categories={readerCategories}
                          selecting={bookshelfSelecting}
                          selected={selectedBooks.has(item.key)}
                          highlighted={highlightedBookshelfKeys.includes(
                            item.key
                          )}
                          onToggle={() => toggleBookshelfSelection(item)}
                          onOpen={() => openBookshelf(item)}
                          onChangeCategory={() => setCategoryPickerItem(item)}
                          onReclassify={() =>
                            onReclassifyBook?.(item, { force: true })
                          }
                          onDelete={() => deleteBookshelfItem(item)}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="flex h-full min-h-[320px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200/90 bg-white/40 px-6 text-center">
                <Books size={34} className="text-slate-300" />
                <p className="m-0 mt-3 text-sm font-semibold text-slate-700">
                  书架还是空的
                </p>
                <p className="m-0 mt-1 max-w-[300px] text-xs leading-5 text-slate-500">
                  可从历史多选加入，或一次上传多本新书。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="relative z-10 mt-4 flex h-10 shrink-0 items-center rounded-2xl border border-white/70 bg-white/58 px-4 text-xs font-medium text-slate-500 shadow-[0_12px_30px_rgba(15,23,42,0.06)]">
        提示：支持 PDF、Word、EPUB、TXT、MD、XLSX 等多种格式文档
      </div>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".md,.markdown,.pdf,.docx,.xlsx,.epub"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onOpenFile(file);
        }}
      />
      <input
        ref={bookshelfFileInputRef}
        type="file"
        className="hidden"
        accept=".md,.markdown,.pdf,.docx,.xlsx,.epub"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = "";
          if (files.length) uploadBookshelfFiles(files);
        }}
      />
    </div>
  );
}

function HistoryDocumentCard({ item, onOpen, onDelete }) {
  const style = historyTypeStyle(item.documentType);
  const [menuOpen, setMenuOpen] = useState(false);
  const uploaded = !!(
    item.readerDocumentId ||
    item.backupReaderDocumentId ||
    item.uploaded
  );
  const progressPercent = Math.max(
    0,
    Math.min(100, Number(item.progress?.percent || 0))
  );

  return (
    <div className="group relative flex min-h-[92px] items-center gap-4 rounded-2xl border border-white/76 bg-white/72 px-4 py-3 shadow-[0_14px_32px_rgba(15,23,42,0.08)] backdrop-blur-xl">
      {item.thumbnailDataUrl ? (
        <div className="flex h-14 w-12 shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_12px_24px_rgba(15,23,42,0.12)]">
          <img
            src={item.thumbnailDataUrl}
            alt=""
            className="h-full w-full object-contain bg-white"
          />
        </div>
      ) : (
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xs font-bold shadow-[0_12px_24px_rgba(15,23,42,0.12)] ${style.className}`}
        >
          {style.label}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="m-0 truncate text-sm font-bold text-slate-900">
            {item.title}
          </p>
          {uploaded && (
            <CheckCircle
              size={15}
              weight="fill"
              className="shrink-0 text-blue-500"
              aria-label="已上传"
            />
          )}
          {item.branchId && (
            <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">
              {item.branchLabel || "本地分支"}
            </span>
          )}
        </div>
        <p className="m-0 mt-1 text-xs font-medium text-slate-500">
          {documentTypeLabel(item.documentType)} · {formatFileSize(item.size)}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <span className="shrink-0 text-xs font-medium text-slate-500">
            阅读进度 · {progressPercent}%
          </span>
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200/70">
            <div
              className="h-full rounded-full bg-blue-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="hidden text-xs font-semibold text-slate-400 xl:block">
          {formatHistoryTime(item.lastOpenedAt)}
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="motion-hover flex h-9 items-center gap-1.5 rounded-lg border border-blue-300/70 bg-white/70 px-3 text-xs font-bold text-blue-600 hover:-translate-y-0.5 hover:bg-blue-50"
        >
          <Play size={13} weight="fill" />
          打开
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-slate-400 shadow-[0_10px_22px_rgba(15,23,42,0.08)]"
          aria-label="更多历史操作"
          aria-expanded={menuOpen}
        >
          <DotsThreeVertical size={20} weight="bold" />
        </button>
        {menuOpen && (
          <div className="absolute right-4 top-[72px] z-30 w-36 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_18px_36px_rgba(15,23,42,0.16)]">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onDelete?.();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-rose-600 hover:bg-rose-50"
            >
              <Trash size={14} />
              删除历史记录
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function LocalFileConflictModal({ conflict, onResolve }) {
  if (!conflict) return null;
  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-slate-950/28 px-6 backdrop-blur-sm">
      <div className="w-full max-w-[420px] rounded-2xl border border-white/80 bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.24)]">
        <p className="m-0 text-base font-bold text-slate-950">已存在上传版本</p>
        <p className="m-0 mt-2 text-sm leading-6 text-slate-600">
          “{conflict.fileName}”
          已有服务器备份。可以直接打开已上传版本并恢复进度，也可以创建一个本地分支继续阅读当前文件。
        </p>
        <div className="mt-5 flex justify-end gap-3">
          <AppButton
            variant="secondary"
            size="sm"
            onClick={() => onResolve?.("branch")}
          >
            创建本地分支
          </AppButton>
          <AppButton size="sm" onClick={() => onResolve?.("uploaded")}>
            打开已上传版本
          </AppButton>
        </div>
      </div>
    </div>
  );
}

export default function DocumentReaderPanel({
  percent = 50,
  onActiveChange = null,
  onBeforeActiveChange = null,
  onReaderLayoutTransition = null,
}) {
  const {
    currentDocument,
    drawerOpen,
    setDrawerSection,
    openLocalFile,
    uploadCurrentDocument,
    bindCurrentDocumentLocalPath,
    openWorkspaceParsedDocument,
    citeSelection,
    closeReader,
    exitCurrentDocument,
    readerHistory,
    drawerInitialSection,
    openHistoryDocument,
    clearReaderHistory,
    deleteReaderHistoryItem,
    updateCurrentDocumentThumbnail,
    localFileConflict,
    resolveLocalFileConflict,
    docxPreviewStatus,
    recordCurrentProgress,
    backupCurrentDocumentProgress,
    pendingReaderTextSources,
    focusReaderTextSource,
    removePendingReaderTextSource,
    readerBookshelf,
    openBookshelfDocument,
    addHistoryItemsToBookshelf,
    uploadFilesToBookshelf,
    deleteReaderBookshelfItems,
    readerCategories,
    createBookshelfCategory,
    renameBookshelfCategory,
    deleteBookshelfCategory,
    updateBookshelfItemCategory,
    reclassifyBookshelfItem,
    workspace,
  } = useDocumentReader() || {};
  const readerBodyRef = useRef(null);
  const progressTimerRef = useRef(null);
  const latestPagedProgressRef = useRef(null);
  const saveProgressSnapshotRef = useRef(null);
  const onActiveChangeRef = useRef(onActiveChange);

  const active = !!currentDocument || !!drawerOpen;
  useEffect(() => {
    onActiveChangeRef.current = onActiveChange;
  }, [onActiveChange]);

  useEffect(() => {
    debugChatTurn("DocumentReaderPanel:activeState", {
      active,
      hasCurrentDocument: !!currentDocument,
      drawerOpen: !!drawerOpen,
      currentDocumentId: currentDocument?.readerDocumentId || null,
    });
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    return () => onActiveChangeRef.current?.(false);
  }, []);

  useEffect(() => {
    return () => window.clearTimeout(progressTimerRef.current);
  }, []);

  useEffect(() => {
    latestPagedProgressRef.current = null;
  }, [
    currentDocument?.readerDocumentId,
    currentDocument?.localDocumentId,
    currentDocument?.bookKey,
    currentDocument?.branchId,
  ]);

  useEffect(() => {
    saveProgressSnapshotRef.current = (options = {}) => {
      if (!currentDocument) return;
      const progress = latestReadingProgress();
      if (!progress) return;
      backupCurrentDocumentProgress?.(progress);
      recordCurrentProgress?.(progress, {
        force: true,
        skipCurrentDocumentPersist: !!options.skipCurrentDocumentPersist,
      });
    };
  });

  useEffect(() => {
    if (!currentDocument) return;

    const save = (options = {}) => saveProgressSnapshotRef.current?.(options);
    const handleVisibilityChange = () => {
      if (window.document.visibilityState === "hidden") save();
    };
    const interval = window.setInterval(
      save,
      READER_PROGRESS_AUTO_SAVE_INTERVAL_MS
    );
    window.document.addEventListener(
      "visibilitychange",
      handleVisibilityChange
    );
    window.addEventListener("pagehide", save);
    return () => {
      window.clearInterval(interval);
      window.document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
      window.removeEventListener("pagehide", save);
      save({ skipCurrentDocumentPersist: true });
    };
  }, [
    currentDocument?.readerDocumentId,
    currentDocument?.localDocumentId,
    currentDocument?.bookKey,
    currentDocument?.branchId,
  ]);

  useEffect(() => {
    if (
      !currentDocument ||
      currentDocument.documentType === "pdf" ||
      currentDocument.renderType === "pdf-preview" ||
      currentDocument.documentType === "epub"
    )
      return;
    const progress = currentDocument.progress || {};
    const ratio =
      typeof progress.scrollRatio === "number"
        ? progress.scrollRatio
        : Number(progress.percent || 0) / 100;
    if (!ratio) return;
    const timer = window.setTimeout(() => {
      const root = readerBodyRef.current;
      if (!root) return;
      const range = root.scrollHeight - root.clientHeight;
      if (range > 0) root.scrollTop = range * ratio;
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    currentDocument?.readerDocumentId,
    currentDocument?.localDocumentId,
    currentDocument?.bookKey,
    currentDocument?.branchId,
    currentDocument?.renderType,
    currentDocument?.documentType,
  ]);

  if (!currentDocument && !drawerOpen) {
    return null;
  }

  const isPdf =
    currentDocument?.documentType === "pdf" ||
    currentDocument?.renderType === "pdf-preview";
  const isPagedReader = isPdf || currentDocument?.documentType === "epub";

  function scrollProgressForElement(root) {
    if (!root) return { percent: 0, locator: null };
    const candidates = [root, ...root.querySelectorAll("*")];
    const scrollTarget = candidates.reduce((best, element) => {
      const range = element.scrollHeight - element.clientHeight;
      if (range <= 4) return best;
      if (!best || range > best.scrollHeight - best.clientHeight)
        return element;
      return best;
    }, null);
    if (!scrollTarget) return { percent: 0, locator: null };
    const range = scrollTarget.scrollHeight - scrollTarget.clientHeight;
    const scrollRatio = range > 0 ? scrollTarget.scrollTop / range : 0;
    const percent = scrollRatio * 100;
    let locator = null;
    if (
      currentDocument?.documentType === "pdf" ||
      currentDocument?.renderType === "pdf-preview"
    ) {
      const pages = [...scrollTarget.querySelectorAll("[data-page-number]")];
      const containerTop = scrollTarget.getBoundingClientRect().top;
      const activePage = pages
        .map((page, index) => ({
          pageNumber:
            Number(page.getAttribute("data-page-number")) || index + 1,
          pageOffsetRatio: Math.max(
            0,
            Math.min(
              1,
              (containerTop - page.getBoundingClientRect().top) /
                Math.max(1, page.getBoundingClientRect().height)
            )
          ),
          distance: Math.abs(page.getBoundingClientRect().top - containerTop),
        }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (activePage)
        locator = {
          ...(currentDocument?.renderType === "pdf-preview"
            ? { type: "pdf-preview" }
            : {}),
          page: activePage.pageNumber,
          pageOffsetRatio: activePage.pageOffsetRatio,
        };
    }
    return {
      percent,
      locator,
      scrollRatio,
      scrollTop: scrollTarget.scrollTop,
    };
  }

  function captureCurrentReadingProgress() {
    const progress = scrollProgressForElement(readerBodyRef.current);
    return {
      label: "阅读进度",
      percent: progress.percent,
      locator: progress.locator,
      scrollRatio: progress.scrollRatio,
      scrollTop: progress.scrollTop,
    };
  }

  function scheduleProgressUpdate(progress) {
    if (!progress) return;
    if (isPagedReader && progress) latestPagedProgressRef.current = progress;
    window.clearTimeout(progressTimerRef.current);
    progressTimerRef.current = window.setTimeout(() => {
      recordCurrentProgress?.(progress);
    }, 800);
  }

  function latestReadingProgress() {
    if (isPagedReader)
      return latestPagedProgressRef.current || currentDocument.progress || null;
    return captureCurrentReadingProgress();
  }

  function handleReaderScroll() {
    if (!currentDocument || isPagedReader) return;
    scheduleProgressUpdate(captureCurrentReadingProgress());
  }

  function handleCloseReader() {
    debugChatTurn("DocumentReaderPanel:closeReader", {
      currentDocumentId: currentDocument?.readerDocumentId || null,
      documentType: currentDocument?.documentType || null,
      hasDocument: !!currentDocument,
      drawerOpen: !!drawerOpen,
    });
    onBeforeActiveChange?.(false, "reader-close");
    window.clearTimeout(progressTimerRef.current);
    closeReader?.(latestReadingProgress());
  }

  function handleExitCurrentDocument() {
    debugChatTurn("DocumentReaderPanel:exitDocument", {
      currentDocumentId: currentDocument?.readerDocumentId || null,
      documentType: currentDocument?.documentType || null,
      hasDocument: !!currentDocument,
      drawerOpen: !!drawerOpen,
    });
    onReaderLayoutTransition?.("reader-exit-document");
    window.clearTimeout(progressTimerRef.current);
    exitCurrentDocument?.(latestReadingProgress());
  }

  async function handleBindLocalPath() {
    const absolutePath = window.prompt("请输入该文档在本机的绝对路径");
    if (!absolutePath?.trim()) return;
    await bindCurrentDocumentLocalPath?.(absolutePath);
  }

  return (
    <div
      className="relative hidden h-full min-w-0 lg:flex"
      style={{ flex: `${percent} 1 0%` }}
    >
      <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[18px] border border-white/10 bg-zinc-950 text-white shadow-[0_18px_45px_rgba(0,0,0,0.24)] ring-1 ring-white/5 light:border-white/70 light:bg-white light:text-slate-900 light:shadow-[0_18px_42px_rgba(15,23,42,0.12)] light:ring-slate-200/70">
        <LocalFileConflictModal
          conflict={localFileConflict}
          onResolve={resolveLocalFileConflict}
        />
        <DocxPreviewLoadingOverlay status={docxPreviewStatus} />
        <button
          type="button"
          onClick={handleCloseReader}
          className="motion-hover absolute right-3 top-2 z-50 flex h-10 w-10 items-center justify-center rounded-full border-none bg-transparent p-0 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          title="取消伴读"
          aria-label="取消伴读"
        >
          <AppIcon name="close" size="md" tone="muted" weight="bold" />
        </button>
        {!currentDocument && (
          <ReaderDrawer
            workspace={workspace}
            initialSection={drawerInitialSection}
            onSectionChange={setDrawerSection}
            onOpenFile={openLocalFile}
            onUploadBookshelfFiles={uploadFilesToBookshelf}
            onOpenWorkspaceDoc={openWorkspaceParsedDocument}
            readerHistory={readerHistory}
            readerBookshelf={readerBookshelf}
            readerCategories={readerCategories}
            onOpenHistoryDocument={openHistoryDocument}
            onOpenBookshelfDocument={openBookshelfDocument}
            onAddHistoryItemsToBookshelf={addHistoryItemsToBookshelf}
            onDeleteBookshelfItems={deleteReaderBookshelfItems}
            onCreateCategory={createBookshelfCategory}
            onRenameCategory={renameBookshelfCategory}
            onDeleteCategory={deleteBookshelfCategory}
            onUpdateBookCategory={updateBookshelfItemCategory}
            onReclassifyBook={reclassifyBookshelfItem}
            onClearHistory={clearReaderHistory}
            onDeleteHistoryItem={deleteReaderHistoryItem}
          />
        )}
        {currentDocument && (
          <ReaderHeader
            document={currentDocument}
            onUpload={uploadCurrentDocument}
            onBindLocalPath={handleBindLocalPath}
            onExit={handleExitCurrentDocument}
          />
        )}
        {currentDocument && (
          <div
            ref={readerBodyRef}
            onScroll={handleReaderScroll}
            className={`min-h-0 flex-1 ${
              isPagedReader
                ? "overflow-hidden p-3"
                : "overflow-y-auto px-4 py-3"
            }`}
          >
            <ReaderBody
              document={currentDocument}
              onCite={citeSelection}
              onThumbnailReady={updateCurrentDocumentThumbnail}
              onProgressChange={scheduleProgressUpdate}
              readerTextSources={pendingReaderTextSources}
              onFocusTextSource={focusReaderTextSource}
              onRemoveTextSource={removePendingReaderTextSource}
            />
          </div>
        )}
      </div>
    </div>
  );
}
