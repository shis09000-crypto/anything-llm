import { memo } from "react";
import { Handle, Position } from "@xyflow/react";

const themeStyles = {
  napkin:
    "bg-white text-slate-900 border-slate-200 shadow-[0_14px_34px_rgba(15,23,42,0.12)]",
  ocean:
    "bg-sky-50 text-slate-900 border-sky-200 shadow-[0_14px_34px_rgba(14,116,144,0.14)]",
  forest:
    "bg-emerald-50 text-slate-900 border-emerald-200 shadow-[0_14px_34px_rgba(4,120,87,0.14)]",
  sunset:
    "bg-rose-50 text-slate-900 border-rose-200 shadow-[0_14px_34px_rgba(190,18,60,0.14)]",
  mono: "bg-zinc-50 text-zinc-950 border-zinc-300 shadow-[0_14px_34px_rgba(24,24,27,0.12)]",
};

function MindMapNode({ data, selected }) {
  const isGraphNode = data.sourceType === "graph";
  const isRoot = data.size === "root" || Number(data.level || 0) === 0;
  const isImportant =
    isRoot ||
    data.size === "large" ||
    Number(data.workspaceImportanceScore || 0) >= 0.35 ||
    Number(data.recentImportanceScore || 0) >= 0.35;

  const englishLabel = data.displayNameEn || data.canonicalName;
  const showEnglishLabel =
    !isGraphNode && englishLabel && englishLabel !== data.label;

  return (
    <div
      className={`mind-map-node h-[164px] w-[280px] overflow-hidden rounded-2xl border p-4 transition-all ${
        themeStyles[data.theme] || themeStyles.napkin
      } ${selected || data.isPathNode ? "ring-2 ring-blue-400" : ""} ${
        isImportant ? "border-slate-300" : ""
      }`}
      style={{
        borderTop: `${isRoot ? 6 : 4}px solid ${data.color || "#CBD5E1"}`,
        boxShadow: isImportant
          ? "0 16px 38px rgba(15, 23, 42, 0.16)"
          : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div className="flex items-start gap-3">
        <div
          className={`flex shrink-0 items-center justify-center rounded-xl text-sm font-semibold ${
            isRoot ? "h-10 w-10" : "h-9 w-9"
          }`}
          style={{ background: data.color || "#E2E8F0" }}
        >
          {data.icon || "*"}
        </div>
        <div className="min-w-0">
          <div
            className={`font-semibold leading-5 max-h-[42px] overflow-hidden ${
              isRoot ? "text-[15px]" : "text-sm"
            }`}
          >
            {data.label}
          </div>
          {showEnglishLabel && (
            <div className="mt-0.5 max-h-[20px] overflow-hidden text-xs font-medium leading-5 text-slate-500">
              {englishLabel}
            </div>
          )}
          {data.description && (
            <div className="mt-2 text-xs leading-5 text-slate-600 max-h-[58px] overflow-hidden">
              {data.description}
            </div>
          )}
        </div>
      </div>
      {isGraphNode && (
        <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-slate-500">
          <span className="rounded-full bg-slate-100 px-2 py-0.5">
            证据 {data.evidenceCount || 0}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5">
            重要度 {formatScore(data.importanceScore)}
          </span>
          {data.clusterLabel && (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-600">
              {data.clusterLabel}
            </span>
          )}
        </div>
      )}
      {data.hasChildren && (
        <div className="mt-3 text-[10px] uppercase tracking-wide text-slate-400">
          双击收起/展开分支
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  );
}

function formatScore(value) {
  return Number(value || 0).toFixed(2);
}

export default memo(MindMapNode);
