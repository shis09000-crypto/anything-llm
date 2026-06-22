import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowClockwise,
  Briefcase,
  CheckCircle,
  Compass,
  Note,
  PencilSimpleLine,
  Question,
  SlidersHorizontal,
  Trash,
  X,
} from "@phosphor-icons/react";
import AppButton from "@/components/lib/AppButton";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import showToast from "@/utils/toast";
import AccountSettingsApi from "./accountSettingsApi";

const MEMORY_BLOCK_CONFIG = {
  preferences: {
    category: "preferences",
    title: "用户偏好",
    description: "回答方式、称呼习惯和协作偏好。",
    icon: SlidersHorizontal,
    tone: "sky",
  },
  projects: {
    category: "projects",
    title: "长期项目",
    description: "持续推进的系统、产品和研究任务。",
    icon: Briefcase,
    tone: "indigo",
  },
  facts: {
    category: "facts",
    title: "长期事实",
    description: "稳定背景、身份信息和重要上下文。",
    icon: Note,
    tone: "emerald",
  },
  decisions: {
    category: "decisions",
    title: "重要决策",
    description: "已经确认的产品方向和实现取舍。",
    icon: CheckCircle,
    tone: "amber",
  },
  "open-topics": {
    category: "open_topics",
    title: "待解决问题",
    description: "仍需继续跟进的疑问和未完成事项。",
    icon: Question,
    tone: "rose",
  },
  interests: {
    category: "interests",
    title: "兴趣与研究方向",
    description: "长期关注的主题、领域和研究线索。",
    icon: Compass,
    tone: "violet",
  },
};

const MEMORY_BLOCK_ORDER = [
  "preferences",
  "projects",
  "facts",
  "decisions",
  "open-topics",
  "interests",
];

const TONE_CLASSES = {
  sky: "bg-sky-50 text-sky-600 ring-sky-100",
  indigo: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  emerald: "bg-emerald-50 text-emerald-600 ring-emerald-100",
  amber: "bg-amber-50 text-amber-600 ring-amber-100",
  rose: "bg-rose-50 text-rose-600 ring-rose-100",
  violet: "bg-violet-50 text-violet-600 ring-violet-100",
};

const MEMORY_CATEGORY_OPTIONS = MEMORY_BLOCK_ORDER.map((key) => ({
  key,
  category: MEMORY_BLOCK_CONFIG[key].category,
  title: MEMORY_BLOCK_CONFIG[key].title,
}));

export default function MemoryBlocksCard() {
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [blocks, setBlocks] = useState(() => buildEmptyMemoryBlocks());
  const [overview, setOverview] = useState(null);
  const [archives, setArchives] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [editingMemory, setEditingMemory] = useState(null);
  const [savingMemory, setSavingMemory] = useState(false);
  const [deletingMemoryId, setDeletingMemoryId] = useState(null);
  const closeTimerRef = useRef(null);

  useEffect(() => {
    refreshMemoryData();
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!selectedBlock) return;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeDrawer();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedBlock]);

  function isDesktopViewport() {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(min-width: 768px)").matches;
  }

  function openDrawer(block) {
    if (!isDesktopViewport()) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setSelectedBlock(block);
    window.requestAnimationFrame(() => setIsDrawerOpen(true));
  }

  function closeDrawer() {
    setIsDrawerOpen(false);
    setEditingMemory(null);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setSelectedBlock(null);
    }, 280);
  }

  async function refreshMemoryData({ selectedKey = null } = {}) {
    setLoading(true);
    const [overviewResult, blocksResult, archivesResult] = await Promise.all([
      AccountSettingsApi.fetchMemoryOverview(),
      AccountSettingsApi.fetchMemoryBlocks(),
      AccountSettingsApi.fetchMemoryArchives(),
    ]);
    setLoading(false);

    if (overviewResult?.success) setOverview(overviewResult.overview || null);
    if (blocksResult?.success) {
      const normalizedBlocks = normalizeMemoryBlocks(blocksResult.blocks || []);
      const activeKey = selectedKey || selectedBlock?.key;
      setBlocks(normalizedBlocks);
      if (activeKey) {
        setSelectedBlock(
          normalizedBlocks.find((block) => block.key === activeKey) || null
        );
      }
    } else {
      setBlocks(buildEmptyMemoryBlocks());
      showToast(blocksResult?.error || "无法读取长期记忆。", "error");
    }
    if (archivesResult?.success) setArchives(archivesResult.archives || []);
  }

  async function rebuildProfile() {
    setRebuilding(true);
    const result = await AccountSettingsApi.rebuildMemoryProfile();
    setRebuilding(false);
    if (!result?.success) {
      showToast(result?.error || "重构画像失败。", "error");
      return;
    }

    showToast("用户画像已重构。", "success");
    await refreshMemoryData();
  }

  async function saveMemoryEdit(form) {
    if (!editingMemory) return;
    setSavingMemory(true);
    const result = await AccountSettingsApi.updateMemory({
      id: editingMemory.id,
      ...form,
    });
    setSavingMemory(false);

    if (!result?.success) {
      showToast(result?.error || "无法更新长期记忆。", "error");
      return;
    }

    setEditingMemory(null);
    showToast("长期记忆已更新。", "success");
    await refreshMemoryData({
      selectedKey: categoryToBlockKey(result.memory?.category || form.category),
    });
  }

  async function deleteMemory(memory) {
    const confirmed = await showAppConfirm({
      title: "删除长期记忆",
      description: `确定删除“${memory.title}”吗？删除后会进入记忆归档。`,
      confirmText: "删除",
      cancelText: "取消",
      tone: "danger",
    });
    if (!confirmed) return;

    setDeletingMemoryId(memory.id);
    const result = await AccountSettingsApi.deleteMemory({ id: memory.id });
    setDeletingMemoryId(null);

    if (!result?.success) {
      showToast(result?.error || "无法删除长期记忆。", "error");
      return;
    }

    showToast("长期记忆已删除并归档。", "success");
    await refreshMemoryData({ selectedKey: selectedBlock?.key || blockKeyForMemory(memory) });
  }

  return (
    <section id="memory-blocks" className="account-card">
      <div className="mb-4 flex flex-col gap-3 px-1 pb-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">长期记忆</h2>
          <p className="mt-1 text-sm leading-5 text-slate-500">
            概览 Athena 当前理解的偏好、项目、事实、决策和长期关注点。
          </p>
        </div>
        <AppButton
          variant="secondary"
          size="sm"
          loading={rebuilding}
          leftIcon={<ArrowClockwise className="h-4 w-4" />}
          onClick={rebuildProfile}
        >
          重构画像
        </AppButton>
      </div>

      <UserProfileOverview overview={overview} loading={loading} />

      <div className="grid gap-3 md:grid-cols-3">
        {blocks.map((block) => (
          <MemoryBlockItem
            key={block.key}
            block={block}
            isActive={isDrawerOpen && selectedBlock?.key === block.key}
            onOpen={openDrawer}
          />
        ))}
      </div>

      <MemoryArchives archives={archives} />

      {selectedBlock && (
        <MemoryDetailDrawer
          block={selectedBlock}
          isOpen={isDrawerOpen}
          onClose={closeDrawer}
          onEdit={setEditingMemory}
          onDelete={deleteMemory}
          deletingMemoryId={deletingMemoryId}
        />
      )}
      {editingMemory && (
        <MemoryEditDialog
          memory={editingMemory}
          saving={savingMemory}
          onCancel={() => setEditingMemory(null)}
          onSave={saveMemoryEdit}
        />
      )}
    </section>
  );
}

function buildEmptyMemoryBlocks() {
  return MEMORY_BLOCK_ORDER.map((key) => withBlockPresentation({ key }));
}

function normalizeMemoryBlocks(incomingBlocks = []) {
  const incomingByKey = new Map(
    incomingBlocks.map((block) => [
      block.key || (block.category === "open_topics" ? "open-topics" : block.category),
      block,
    ])
  );

  return MEMORY_BLOCK_ORDER.map((key) =>
    withBlockPresentation(incomingByKey.get(key) || { key })
  );
}

function withBlockPresentation(block) {
  const key = block.key || (block.category === "open_topics" ? "open-topics" : block.category);
  const config = MEMORY_BLOCK_CONFIG[key] || MEMORY_BLOCK_CONFIG[block.category];
  return {
    ...config,
    ...block,
    key,
    category: block.category || config?.category,
    title: block.title || config?.title || "长期记忆",
    description: block.description || config?.description || "暂无说明。",
    icon: config?.icon || Note,
    tone: config?.tone || "sky",
    items: block.items || [],
  };
}

function categoryToBlockKey(category) {
  return category === "open_topics" ? "open-topics" : category;
}

function blockKeyForMemory(memory) {
  return categoryToBlockKey(memory?.category);
}

function UserProfileOverview({ overview, loading }) {
  return (
    <div className="mb-4 rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
            User Profile Overview
          </p>
          <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-600">
            {loading
              ? "正在读取用户画像..."
              : overview?.overview || "暂无长期记忆画像。"}
          </p>
        </div>
        {overview?.version && (
          <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-400 ring-1 ring-slate-200">
            v{overview.version}
          </span>
        )}
      </div>
      {overview?.generatedAt && (
        <p className="mt-2 text-xs text-slate-400">
          生成于 {formatDate(overview.generatedAt)}
        </p>
      )}
    </div>
  );
}

function MemoryBlockItem({ block, isActive, onOpen }) {
  const Icon = block.icon;
  const visibleItems = block.items.slice(0, 3);

  function handleKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen(block);
  }

  return (
    <article
      tabIndex={0}
      role="button"
      aria-label={`${block.title}，${block.items.length} 条长期记忆`}
      aria-haspopup="dialog"
      aria-expanded={isActive}
      onClick={() => onOpen(block)}
      onKeyDown={handleKeyDown}
      className={[
        "group flex min-h-[196px] cursor-pointer flex-col rounded-2xl border border-[#E5E7EB] bg-white p-4 shadow-sm outline-none transition-all duration-200 ease-out focus-visible:-translate-y-0.5 focus-visible:border-violet-200 focus-visible:bg-slate-50/40 focus-visible:shadow-[0_10px_24px_rgba(15,23,42,0.06)] focus-visible:ring-1 focus-visible:ring-violet-100/70 md:hover:-translate-y-0.5 md:hover:border-violet-200 md:hover:bg-slate-50/40 md:hover:shadow-[0_14px_30px_rgba(15,23,42,0.08)]",
        isActive
          ? "scale-[0.99] border-violet-200/70 bg-slate-50/40 shadow-[0_10px_24px_rgba(15,23,42,0.06)] ring-1 ring-violet-100/60 duration-[120ms]"
          : "",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={[
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 transition duration-200 group-hover:scale-105 group-hover:ring-2 group-focus-visible:scale-105 group-focus-visible:ring-2",
              TONE_CLASSES[block.tone],
            ].join(" ")}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-slate-950">
              {block.title}
            </h3>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-500 transition duration-200 group-hover:border-violet-200 group-hover:bg-violet-50 group-hover:text-violet-500 group-focus-visible:border-violet-200 group-focus-visible:bg-violet-50 group-focus-visible:text-violet-500">
          {block.items.length}
        </span>
      </div>

      <p className="mt-3 truncate text-xs leading-5 text-slate-500">
        {block.description}
      </p>

      <div className="mt-4 flex flex-1 flex-col">
        {visibleItems.length > 0 ? (
          <ul className="space-y-2">
            {visibleItems.map((item) => (
              <li key={item.title} className="flex min-w-0 items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                <span className="truncate text-sm font-medium text-slate-700">
                  {item.title}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-1 items-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-3 py-4 text-sm font-medium text-slate-400">
            暂无记忆
          </div>
        )}
      </div>
    </article>
  );
}

function MemoryDetailDrawer({
  block,
  isOpen,
  onClose,
  onEdit,
  onDelete,
  deletingMemoryId,
}) {
  const titleId = `memory-detail-title-${block.key}`;
  const latestUpdatedAt = getLatestUpdatedAt(block.items);

  return (
    <div
      className={[
        "fixed inset-0 z-[10000] hidden backdrop-blur-[2px] transition-opacity duration-[280ms] ease-out md:block",
        isOpen ? "bg-slate-950/[0.08] opacity-100" : "bg-slate-950/0 opacity-0",
      ].join(" ")}
      onClick={onClose}
      aria-hidden={!isOpen}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={[
          "absolute bottom-6 right-6 top-6 flex w-[400px] max-w-[calc(100vw-48px)] flex-col rounded-[20px] border border-slate-200/80 bg-white shadow-[0_22px_60px_rgba(15,23,42,0.14)] transition-transform duration-[280ms] ease-out",
          isOpen ? "translate-x-0" : "translate-x-[calc(100%+32px)]",
        ].join(" ")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
              Memory Detail
            </p>
            <div className="mt-2 flex min-w-0 items-center gap-3">
              <h3
                id={titleId}
                className="min-w-0 flex-1 truncate text-xl font-semibold text-slate-950"
              >
                {block.title}
              </h3>
              {latestUpdatedAt && (
                <span className="shrink-0 text-xs font-medium text-slate-400">
                  更新于 {formatDate(latestUpdatedAt)}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-500">
              共 {block.items.length} 条长期记忆
            </p>
          </div>
          <button
            type="button"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-100"
            onClick={onClose}
            aria-label="关闭长期记忆详情"
          >
            <X className="h-4 w-4" weight="bold" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {block.items.length > 0 ? (
            <div className="space-y-2">
              {block.items.map((item) => (
                <article
                  key={`${item.title}-${item.source}`}
                  className="rounded-xl border border-slate-100 bg-white px-3.5 py-3 shadow-[0_4px_14px_rgba(15,23,42,0.025)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 text-sm font-semibold leading-6 text-slate-900">
                      {item.title}
                    </p>
                    <div className="flex shrink-0 items-center gap-1 pt-0.5">
                      <span className="mr-1 max-w-[112px] truncate text-xs font-medium text-slate-400">
                        {item.source}
                      </span>
                      <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-50 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-100"
                        onClick={() => onEdit(item)}
                        aria-label={`编辑长期记忆 ${item.title}`}
                      >
                        <PencilSimpleLine className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={deletingMemoryId === item.id}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => onDelete(item)}
                        aria-label={`删除长期记忆 ${item.title}`}
                      >
                        <Trash className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {item.detail}
                  </p>
                  <div className="mt-3 text-xs font-medium text-slate-400">
                    置信度 {item.confidence}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-5 text-sm font-medium text-slate-400">
              暂时无长期记忆。
            </div>
          )}
        </div>

        <div className="border-t border-slate-100 px-5 py-3 text-xs leading-5 text-slate-400">
          这些记忆只用于个性化体验，不会用于训练模型。
        </div>
      </aside>
    </div>
  );
}

function MemoryEditDialog({ memory, saving, onCancel, onSave }) {
  const [form, setForm] = useState(() => ({
    category: memory.category,
    title: memory.title,
    detail: memory.detail,
    source: memory.source,
    confidence: memory.confidence,
  }));

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    onSave(form);
  }

  return (
    <div
      className="fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/[0.12] px-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="memory-edit-title"
      onClick={() => {
        if (!saving) onCancel();
      }}
    >
      <form
        className="w-full max-w-[480px] rounded-[24px] border border-white/80 bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.18)]"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
              Edit Memory
            </p>
            <h4
              id="memory-edit-title"
              className="mt-2 text-lg font-semibold text-slate-950"
            >
              编辑长期记忆
            </h4>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="关闭编辑"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <MemoryFormField label="分类">
            <select
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm font-medium text-slate-800 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-2 focus:ring-violet-100"
              value={form.category}
              onChange={(event) => updateField("category", event.target.value)}
            >
              {MEMORY_CATEGORY_OPTIONS.map((option) => (
                <option key={option.category} value={option.category}>
                  {option.title}
                </option>
              ))}
            </select>
          </MemoryFormField>
          <MemoryFormField label="标题">
            <input
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm font-medium text-slate-800 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-2 focus:ring-violet-100"
              value={form.title}
              maxLength={160}
              onChange={(event) => updateField("title", event.target.value)}
            />
          </MemoryFormField>
          <MemoryFormField label="详情">
            <textarea
              className="min-h-[120px] w-full resize-y rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm leading-6 text-slate-800 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-2 focus:ring-violet-100"
              value={form.detail}
              maxLength={2000}
              onChange={(event) => updateField("detail", event.target.value)}
            />
          </MemoryFormField>
          <div className="grid gap-3 md:grid-cols-2">
            <MemoryFormField label="来源">
              <input
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm font-medium text-slate-800 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-2 focus:ring-violet-100"
                value={form.source}
                maxLength={120}
                onChange={(event) => updateField("source", event.target.value)}
              />
            </MemoryFormField>
            <MemoryFormField label="置信度">
              <input
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-sm font-medium text-slate-800 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-2 focus:ring-violet-100"
                value={form.confidence}
                maxLength={24}
                onChange={(event) =>
                  updateField("confidence", event.target.value)
                }
              />
            </MemoryFormField>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <AppButton
            type="button"
            variant="secondary"
            size="sm"
            disabled={saving}
            onClick={onCancel}
          >
            取消
          </AppButton>
          <AppButton type="submit" size="sm" loading={saving}>
            保存
          </AppButton>
        </div>
      </form>
    </div>
  );
}

function MemoryFormField({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function MemoryArchives({ archives }) {
  if (!archives?.length) return null;

  return (
    <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50/60 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
        <Archive className="h-4 w-4 text-slate-400" />
        <span>Memory Archives</span>
        <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-400 ring-1 ring-slate-200">
          {archives.length}
        </span>
      </div>
      <div className="space-y-2">
        {archives.slice(0, 5).map((archive) => {
          const oldValue = parseArchiveValue(archive.oldValue);
          return (
            <div
              key={archive.id}
              className="rounded-xl border border-slate-100 bg-white px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-medium text-slate-700">
                  {oldValue?.title || "旧记忆"}
                </p>
                <span className="shrink-0 text-xs text-slate-400">
                  {formatDate(archive.archivedAt)}
                </span>
              </div>
              {oldValue?.detail && (
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                  {oldValue.detail}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getLatestUpdatedAt(items) {
  return items.reduce((latest, item) => {
    if (!latest) return item.updatedAt;
    return parseMemoryDate(item.updatedAt) > parseMemoryDate(latest)
      ? item.updatedAt
      : latest;
  }, "");
}

function parseMemoryDate(value) {
  if (!value) return 0;
  if (String(value).includes("T")) return new Date(value).getTime();
  const [year, month, day] = value.split("/").map(Number);
  return new Date(year, month - 1, day).getTime();
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString("zh-CN");
  } catch {
    return String(value);
  }
}

function parseArchiveValue(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return null;
  }
}
