import { useEffect, useRef, useState } from "react";
import {
  Clock,
  DotsThreeVertical,
  FileArrowUp,
  FileText,
  FloppyDisk,
  FolderOpen,
  Play,
  Trash,
  X,
} from "@phosphor-icons/react";
import AppButton from "@/components/lib/AppButton";
import { useDocumentReader } from "./Provider";
import ReaderMarkdownRenderer from "./ReaderMarkdownRenderer";
import XlsxReader from "./XlsxReader";
import PdfReader from "./PdfReader";

const HISTORY_TYPE_STYLES = {
  pdf: { label: "PDF", className: "bg-rose-500 text-white" },
  docx: { label: "W", className: "bg-blue-500 text-white" },
  markdown: { label: "MD", className: "bg-slate-300 text-white" },
  xlsx: { label: "XLS", className: "bg-emerald-500 text-white" },
  txt: { label: "TXT", className: "bg-emerald-500 text-white" },
};

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
  return String(type || "DOC").toUpperCase();
}

function historyTypeStyle(type) {
  return (
    HISTORY_TYPE_STYLES[type] || {
      label: "DOC",
      className: "bg-slate-400 text-white",
    }
  );
}

function ReaderHeader({ document, onUpload }) {
  if (!document) return null;
  const parsedOnly = document.source === "workspace_parsed";
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
          </div>
          {parsedOnly && (
            <p className="m-0 mt-1 text-xs text-amber-200/80 light:text-amber-700">
              该文档不是原始版式，仅展示已解析内容
            </p>
          )}
        </div>
        {document.source === "local" && (
          <button
            type="button"
            onClick={onUpload}
            className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-sky-300/40 bg-sky-500/90 px-3 text-xs font-semibold text-white shadow-[0_10px_24px_rgba(14,165,233,0.24)] hover:bg-sky-400"
          >
            <FloppyDisk size={14} />
            上传备份
          </button>
        )}
      </div>
    </div>
  );
}

function ReaderBody({ document, onCite }) {
  if (!document) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/65 light:text-slate-600">
        请选择本地文档或工作区文档开始伴读。
      </div>
    );
  }

  if (["markdown", "docx"].includes(document.documentType)) {
    return <ReaderMarkdownRenderer document={document} onCite={onCite} />;
  }
  if (document.documentType === "xlsx") {
    return <XlsxReader document={document} onCite={onCite} />;
  }
  if (document.documentType === "pdf") {
    return <PdfReader document={document} onCite={onCite} />;
  }
  return (
    <p className="text-sm text-white/50 light:text-slate-500">
      当前格式只能 fallback 预览，暂不支持结构化引用。
    </p>
  );
}

function ReaderDrawer({
  workspace,
  onOpenFile,
  onOpenWorkspaceDoc,
  readerHistory = [],
  onOpenHistoryDocument,
  onClearHistory,
}) {
  const fileInputRef = useRef(null);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const documents = workspace?.documents || [];
  const hasHistory = readerHistory.length > 0;

  const openHistory = async (historyItem) => {
    const result = await onOpenHistoryDocument?.(historyItem);
    if (result?.needsLocalFile) fileInputRef.current?.click();
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[linear-gradient(135deg,#eef7ff_0%,#f8fbff_44%,#ffffff_100%)] px-5 pb-5 pt-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-sky-200/28 blur-3xl" />
        <div className="absolute -right-20 bottom-10 h-80 w-80 rounded-full bg-blue-200/24 blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-28 bg-[linear-gradient(180deg,transparent,rgba(255,255,255,0.65))]" />
      </div>
      <div className="relative z-10 grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)] gap-5">
        <div className="flex min-h-0 flex-col rounded-[22px] border border-white/70 bg-white/42 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.88),0_18px_44px_rgba(15,23,42,0.08)] backdrop-blur-xl">
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
            className={["relative mt-3", workspacePickerOpen ? "z-50" : ""]
              .filter(Boolean)
              .join(" ")}
          >
            <button
              type="button"
              onClick={() => setWorkspacePickerOpen((open) => !open)}
              className="motion-hover group flex min-h-[92px] w-full items-center gap-3 rounded-2xl border border-white/70 bg-white/66 px-4 text-left shadow-[0_14px_30px_rgba(15,23,42,0.08)] hover:-translate-y-0.5 hover:border-blue-200 hover:bg-white/82"
              aria-expanded={workspacePickerOpen}
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
              <div className="absolute left-0 top-full z-[80] mt-3 max-h-[260px] w-[min(340px,calc(100vw-64px))] overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.18)]">
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
          <div className="mt-3 flex min-h-[92px] w-full items-center gap-3 rounded-2xl border border-white/60 bg-white/44 px-4 text-left">
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
          </div>
        </div>
        <div className="flex min-h-0 flex-col rounded-[22px] border border-white/70 bg-white/52 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_18px_44px_rgba(15,23,42,0.08)] backdrop-blur-xl">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="mt-1 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-slate-800 shadow-[0_10px_24px_rgba(15,23,42,0.1)]">
                <Clock size={20} />
              </span>
              <div>
                <h2 className="m-0 text-lg font-bold text-slate-950">
                  历史阅读文档
                </h2>
                <p className="m-0 mt-1 text-xs font-medium text-slate-500">
                  查看并继续阅读最近打开的文档
                </p>
              </div>
            </div>
            <AppButton
              size="sm"
              onClick={onClearHistory}
              disabled={!hasHistory}
              leftIcon={<Trash size={15} />}
              className="reader-clear-history-button shrink-0"
            >
              清空记录
            </AppButton>
          </div>
          <div className="mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
            {hasHistory ? (
              <div className="flex flex-col gap-3">
                {readerHistory.map((item) => (
                  <HistoryDocumentCard
                    key={item.key}
                    item={item}
                    onOpen={() => openHistory(item)}
                  />
                ))}
              </div>
            ) : (
              <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200/90 bg-white/40 px-6 text-center">
                <Clock size={34} className="text-slate-300" />
                <p className="m-0 mt-3 text-sm font-semibold text-slate-700">
                  暂无历史阅读记录
                </p>
                <p className="m-0 mt-1 max-w-[280px] text-xs leading-5 text-slate-500">
                  打开本地、服务器备份或工作区解析文档后，这里会显示最近阅读记录。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="relative z-10 mt-4 flex h-10 shrink-0 items-center rounded-2xl border border-white/70 bg-white/58 px-4 text-xs font-medium text-slate-500 shadow-[0_12px_30px_rgba(15,23,42,0.06)]">
        提示：支持 PDF、Word、TXT、MD、XLSX 等多种格式文档
      </div>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".md,.markdown,.pdf,.docx,.xlsx"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onOpenFile(file);
        }}
      />
    </div>
  );
}

function HistoryDocumentCard({ item, onOpen }) {
  const style = historyTypeStyle(item.documentType);
  const progressPercent = Math.max(
    0,
    Math.min(100, Number(item.progress?.percent || 0))
  );
  const needsLocalFile =
    item.source === "local" && !item.backupReaderDocumentId;

  return (
    <div className="group flex min-h-[92px] items-center gap-4 rounded-2xl border border-white/76 bg-white/72 px-4 py-3 shadow-[0_14px_32px_rgba(15,23,42,0.08)] backdrop-blur-xl">
      <div
        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xs font-bold shadow-[0_12px_24px_rgba(15,23,42,0.12)] ${style.className}`}
      >
        {style.label}
      </div>
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-sm font-bold text-slate-900">
          {item.title}
        </p>
        <p className="m-0 mt-1 text-xs font-medium text-slate-500">
          {documentTypeLabel(item.documentType)} · {formatFileSize(item.size)}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <span className="shrink-0 text-xs font-medium text-slate-500">
            {item.progress?.label || "最近打开"} · {progressPercent}%
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
          {needsLocalFile ? "重新选择" : "继续阅读"}
        </button>
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-slate-400 shadow-[0_10px_22px_rgba(15,23,42,0.08)]"
          aria-label="更多历史操作"
        >
          <DotsThreeVertical size={20} weight="bold" />
        </button>
      </div>
    </div>
  );
}

export default function DocumentReaderPanel({
  percent = 50,
  onActiveChange = null,
}) {
  const {
    currentDocument,
    drawerOpen,
    openLocalFile,
    uploadCurrentDocument,
    openWorkspaceParsedDocument,
    citeSelection,
    closeReader,
    readerHistory,
    openHistoryDocument,
    clearReaderHistory,
    workspace,
  } = useDocumentReader() || {};

  const active = !!currentDocument || !!drawerOpen;
  useEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);

  if (!currentDocument && !drawerOpen) {
    return null;
  }

  const isPdf = currentDocument?.documentType === "pdf";

  return (
    <div
      className="relative hidden h-full min-w-0 lg:flex"
      style={{ flex: `${percent} 1 0%` }}
    >
      <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[18px] border border-white/10 bg-zinc-950 text-white shadow-[0_18px_45px_rgba(0,0,0,0.24)] ring-1 ring-white/5 light:border-white/70 light:bg-white light:text-slate-900 light:shadow-[0_18px_42px_rgba(15,23,42,0.12)] light:ring-slate-200/70">
        <button
          type="button"
          onClick={closeReader}
          className="motion-hover absolute right-4 top-4 z-50 flex h-9 w-9 items-center justify-center rounded-full border border-white/80 bg-white/85 text-slate-600 shadow-[0_12px_28px_rgba(15,23,42,0.16)] backdrop-blur-xl hover:-translate-y-0.5 hover:bg-white hover:text-slate-950 light:border-slate-200/80"
          title="退出伴读"
          aria-label="退出伴读"
        >
          <X size={17} />
        </button>
        {!currentDocument && (
          <ReaderDrawer
            workspace={workspace}
            onOpenFile={openLocalFile}
            onOpenWorkspaceDoc={openWorkspaceParsedDocument}
            readerHistory={readerHistory}
            onOpenHistoryDocument={openHistoryDocument}
            onClearHistory={clearReaderHistory}
          />
        )}
        {currentDocument && (
          <ReaderHeader
            document={currentDocument}
            onUpload={uploadCurrentDocument}
          />
        )}
        {currentDocument && (
          <div
            className={`min-h-0 flex-1 ${
              isPdf ? "overflow-hidden p-3" : "overflow-y-auto px-4 py-3"
            }`}
          >
            <ReaderBody document={currentDocument} onCite={citeSelection} />
          </div>
        )}
      </div>
    </div>
  );
}
