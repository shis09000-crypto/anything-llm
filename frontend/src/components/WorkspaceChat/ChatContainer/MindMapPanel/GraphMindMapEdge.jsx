import { useMemo, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";

const roleLabels = {
  main: "主线关系",
  branch: "分线关系",
  support: "支线关系",
  weak: "弱关系",
  conflict: "冲突关系",
  layout: "布局辅助线",
};

export default function GraphMindMapEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data = {},
  selected,
  markerEnd,
}) {
  const [hovered, setHovered] = useState(false);
  const role = data.edgeRole || "support";
  const isLayout = data.isLayoutEdge || role === "layout";
  const label = data.displayLabel || data.label || data.relationLabelZh || "";
  const isSelected = selected || data.isSelectedEdge;
  const showLabel = shouldShowLabel(data, hovered, isSelected);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 20,
  });
  const style = useMemo(
    () => edgeStyle(data, isSelected, hovered),
    [data, isSelected, hovered]
  );

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={style}
        markerEnd={isLayout ? undefined : markerEnd}
        interactionWidth={isLayout ? 4 : 18}
      />
      {!isLayout && (
        <path
          d={edgePath}
          fill="none"
          stroke="transparent"
          strokeWidth={18}
          className="cursor-pointer"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={() =>
            document.dispatchEvent(
              new CustomEvent("mindmap-graph-edge-click", {
                detail: { id, data },
              })
            )
          }
        />
      )}
      <EdgeLabelRenderer>
        {(showLabel || hovered || isSelected) && !isLayout && (
          <div
            className="nodrag nopan pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {showLabel && (
              <div
                className={`rounded-full border bg-white/95 px-2 py-0.5 text-[10px] font-semibold shadow-sm ${labelClass(
                  role
                )}`}
              >
                {label}
              </div>
            )}
            {(hovered || isSelected) && (
              <div className="mt-1 w-[220px] rounded-xl border border-slate-200 bg-white/95 p-2 text-[11px] leading-4 text-slate-600 shadow-xl backdrop-blur">
                <div className="font-semibold text-slate-900">
                  {label || "关系"}
                </div>
                <div className="mt-1 text-slate-500">
                  {roleLabels[role] || role} · {data.relationType || "relation"}
                </div>
                <div className="mt-1 grid grid-cols-2 gap-1">
                  <span>置信度 {formatPercent(data.confidence)}</span>
                  <span>权重 {Number(data.weight || 0).toFixed(1)}</span>
                  <span>证据 {data.evidenceCount || 0}</span>
                  <span>{trustLabel(data.trustLevel)}</span>
                </div>
                {data.isWeakRelation && (
                  <div className="mt-1 rounded-lg bg-slate-50 px-2 py-1 text-slate-500">
                    弱关系：证据较少、置信度较低，或属于泛化“相关”。
                  </div>
                )}
                {data.isConflictEdge && (
                  <div className="mt-1 rounded-lg bg-orange-50 px-2 py-1 text-orange-700">
                    存在冲突证据，点击查看详情。
                  </div>
                )}
                <div className="mt-1 text-blue-600">点击查看原始证据</div>
              </div>
            )}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

function shouldShowLabel(data = {}, hovered, selected) {
  const mode = data.labelMode || data.labelModeDefault || "auto";
  if (mode === "hidden") return false;
  if (mode === "all") return true;
  if (mode === "hover") return hovered || selected;
  if (mode === "main") return Boolean(data.isMainEdge);
  if (data.isWeakRelation) return false;
  if (data.isMainEdge || data.isBranchEdge) return true;
  return hovered || selected || Boolean(data.shouldShowLabel);
}

function edgeStyle(data = {}, selected, hovered) {
  const role = data.edgeRole || "support";
  const color =
    role === "conflict"
      ? "#f97316"
      : role === "layout"
        ? "#cbd5e1"
        : data.color || "#94a3b8";
  const width = Number(data.visualWeight || 2);
  const opacity = Number(data.visualOpacity ?? 0.5);
  return {
    stroke: color,
    strokeWidth:
      selected || data.isPathEdge ? width + 1.2 : hovered ? width + 0.6 : width,
    opacity:
      selected || data.isPathEdge
        ? 1
        : hovered
          ? Math.min(1, opacity + 0.18)
          : opacity,
    strokeDasharray:
      data.visualStyle === "dashed" || role === "weak" || role === "conflict"
        ? "7 6"
        : undefined,
    filter:
      selected || data.isPathEdge
        ? "drop-shadow(0 2px 4px rgba(37,99,235,0.24))"
        : undefined,
  };
}

function labelClass(role) {
  if (role === "main") return "border-blue-200 text-blue-700";
  if (role === "branch") return "border-indigo-200 text-indigo-700";
  if (role === "conflict") return "border-orange-200 text-orange-700";
  if (role === "weak") return "border-slate-200 text-slate-500";
  return "border-slate-200 text-slate-600";
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function trustLabel(level) {
  if (level === "high") return "高可信";
  if (level === "medium") return "中可信";
  if (level === "low") return "低可信";
  return "可信度待定";
}
