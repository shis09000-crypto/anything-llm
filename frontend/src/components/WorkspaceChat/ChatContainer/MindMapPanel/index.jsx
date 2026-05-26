import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toPng } from "html-to-image";
import { saveAs } from "file-saver";
import {
  ArrowsOut,
  CaretDown,
  CaretLeft,
  CaretRight,
  DownloadSimple,
  FileText,
  GitFork,
  ListBullets,
  MagnifyingGlass,
  ShieldWarning,
  Sparkle,
  Wrench,
  X,
} from "@phosphor-icons/react";
import MindMap from "@/models/mindMap";
import showToast from "@/utils/toast";
import renderMarkdown from "@/utils/chat/markdown";
import DOMPurify from "@/utils/chat/purify";
import MindMapNode from "./MindMapNode";
import GraphMindMapEdge from "./GraphMindMapEdge";
import { layoutMindMap } from "./layout";

const nodeTypes = { mindMapNode: MindMapNode };
const edgeTypes = { graphMindMapEdge: GraphMindMapEdge };
const layouts = ["tree", "radial", "timeline", "flow", "comparison"];
const themes = ["napkin", "ocean", "forest", "sunset", "mono"];
const layoutLabels = {
  tree: "树状",
  radial: "放射",
  timeline: "时间线",
  flow: "流程",
  comparison: "对比",
};
const themeLabels = {
  napkin: "柔和卡片",
  ocean: "海蓝",
  forest: "森林",
  sunset: "日落",
  mono: "黑白",
};
const relationFilterOptions = [
  { value: "all", label: "全部" },
  { value: "causes", label: "因果" },
  { value: "part_of", label: "组成/属于" },
  { value: "depends_on", label: "依赖" },
  { value: "regulates", label: "调控" },
  { value: "contrasts_with", label: "对比" },
  { value: "precedes", label: "先后" },
  { value: "references", label: "引用" },
  { value: "related_to", label: "相关" },
  { value: "conflict", label: "冲突" },
];
const labelModes = [
  { value: "auto", label: "自动" },
  { value: "main", label: "只显示主线" },
  { value: "hover", label: "hover 显示" },
  { value: "all", label: "全部显示" },
  { value: "hidden", label: "全部隐藏" },
];

export default function MindMapPanel({
  workspace,
  threadSlug = null,
  isOpen,
  request = null,
  onClose,
  sendCommand,
  setMessage,
  floating = false,
}) {
  if (!isOpen) return null;
  return (
    <ReactFlowProvider>
      <MindMapPanelInner
        workspace={workspace}
        threadSlug={threadSlug}
        request={request}
        onClose={onClose}
        sendCommand={sendCommand}
        setMessage={setMessage}
        floating={floating}
      />
    </ReactFlowProvider>
  );
}

function MindMapPanelInner({
  workspace,
  threadSlug = null,
  request = null,
  onClose,
  sendCommand,
  setMessage,
  floating = false,
}) {
  const flowRef = useRef(null);
  const documentMenuRef = useRef(null);
  const documentButtonRef = useRef(null);
  const lastRequestId = useRef(null);
  const saveViewportTimer = useRef(null);
  const suggestionTimer = useRef(null);
  const nodeMetricsCache = useRef(new Map());
  const graphPositionCache = useRef(new Map());
  const { fitView, getViewport, setViewport } = useReactFlow();
  const [mode, setMode] = useState("ai");
  const [savedMaps, setSavedMaps] = useState([]);
  const [activeMap, setActiveMap] = useState(null);
  const [layout, setLayout] = useState("tree");
  const [theme, setTheme] = useState("napkin");
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [collapsed, setCollapsed] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [pendingBody, setPendingBody] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showDocumentMenu, setShowDocumentMenu] = useState(false);
  const [graphConcept, setGraphConcept] = useState("");
  const [graphSuggestions, setGraphSuggestions] = useState([]);
  const [showGraphSuggestions, setShowGraphSuggestions] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [graphStatus, setGraphStatus] = useState(null);
  const [repairStatus, setRepairStatus] = useState(null);
  const [graphEmptyReason, setGraphEmptyReason] = useState(null);
  const [hideWeakRelations, setHideWeakRelations] = useState(true);
  const [mainOnly, setMainOnly] = useState(false);
  const [hideRelatedTo, setHideRelatedTo] = useState(true);
  const [relationTypeFilter, setRelationTypeFilter] = useState("all");
  const [labelMode, setLabelMode] = useState("auto");
  const [graphControlsCollapsed, setGraphControlsCollapsed] = useState(true);
  const [pathSource, setPathSource] = useState("");
  const [pathTarget, setPathTarget] = useState("");
  const [pathResult, setPathResult] = useState(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [selectedPathIndex, setSelectedPathIndex] = useState(0);
  const [evidenceTarget, setEvidenceTarget] = useState(null);
  const [evidenceData, setEvidenceData] = useState(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceSort, setEvidenceSort] = useState("trust");
  const [evidenceCluster, setEvidenceCluster] = useState("");
  const [evidencePage, setEvidencePage] = useState(1);
  const [expandedEvidence, setExpandedEvidence] = useState(new Set());
  const [nodeMetrics, setNodeMetrics] = useState(null);
  const [nodeMetricsLoading, setNodeMetricsLoading] = useState(false);

  const documents = workspace?.documents || [];
  const isGraphMap = activeMap?.sourceType === "graph";
  const graphNeedsSimplification =
    isGraphMap &&
    ((activeMap?.schema?.nodes?.length || 0) > 40 ||
      (activeMap?.schema?.edges?.length || 0) > 80);
  const activeSchema = useMemo(() => {
    if (!activeMap?.schema) return null;
    const schema = {
      ...activeMap.schema,
      layout,
      theme,
      edgeLabelMode: labelMode,
    };
    if (!isGraphMap) return schema;
    return filterGraphSchema(schema, {
      hideWeakRelations,
      mainOnly,
      hideRelatedTo,
      relationTypeFilter,
      labelMode,
      autoSimplified: graphNeedsSimplification,
      selectedPath: pathResult?.paths?.[selectedPathIndex],
      selectedEdgeId: selectedEdge?.id,
    });
  }, [
    activeMap,
    layout,
    theme,
    labelMode,
    isGraphMap,
    hideWeakRelations,
    mainOnly,
    hideRelatedTo,
    relationTypeFilter,
    graphNeedsSimplification,
    pathResult,
    selectedPathIndex,
    selectedEdge?.id,
  ]);

  const refreshSavedMaps = useCallback(async () => {
    if (!workspace?.slug) return;
    const maps = await MindMap.list(workspace.slug, threadSlug);
    setSavedMaps(maps);
  }, [workspace?.slug, threadSlug]);

  const refreshGraphStatus = useCallback(async () => {
    if (!workspace?.slug) return;
    const [stats, repair] = await Promise.all([
      MindMap.graphStats(workspace.slug),
      MindMap.repairStatus(workspace.slug),
    ]);
    setGraphStatus(stats);
    setRepairStatus(repair);
  }, [workspace?.slug]);

  useEffect(() => {
    refreshSavedMaps();
  }, [refreshSavedMaps]);

  useEffect(() => {
    if (mode === "graph") refreshGraphStatus();
  }, [mode, refreshGraphStatus]);

  useEffect(() => {
    if (!isGraphMap || !evidenceTarget || !workspace?.slug) {
      setEvidenceData(null);
      return;
    }
    let cancelled = false;
    async function loadEvidence() {
      setEvidenceLoading(true);
      const params = {
        page: evidencePage,
        limit: 10,
        sort: evidenceSort,
        cluster: evidenceCluster,
      };
      const result =
        evidenceTarget.type === "edge"
          ? await MindMap.edgeEvidence(workspace.slug, {
              ...params,
              edgeId: evidenceTarget.id,
            })
          : await MindMap.nodeEvidence(workspace.slug, {
              ...params,
              nodeId: evidenceTarget.id,
            });
      if (cancelled) return;
      setEvidenceLoading(false);
      if (result?.error) {
        setEvidenceData({ error: result.error });
        return;
      }
      setEvidenceData(result);
      setExpandedEvidence(new Set());
      MindMap.recordEvidenceUsage(workspace.slug, {
        targetType: evidenceTarget.type,
        targetId: String(evidenceTarget.id),
        action: "view",
      });
    }
    loadEvidence();
    return () => {
      cancelled = true;
    };
  }, [
    evidenceCluster,
    evidencePage,
    evidenceSort,
    evidenceTarget,
    isGraphMap,
    workspace?.slug,
  ]);

  useEffect(() => {
    if (
      !isGraphMap ||
      evidenceTarget?.type !== "node" ||
      !evidenceTarget?.id ||
      !workspace?.slug
    ) {
      setNodeMetrics(null);
      setNodeMetricsLoading(false);
      return;
    }
    let cancelled = false;
    const cacheKey = `${workspace.slug}:${evidenceTarget.id}`;
    const cached = nodeMetricsCache.current.get(cacheKey);
    if (cached) {
      setNodeMetrics(cached);
      if (cached.stale || cached.emptyReason === "metrics_missing") {
        MindMap.recomputeNodeMetrics(workspace.slug, {
          nodeId: evidenceTarget.id,
        });
      }
      return;
    }
    async function loadNodeMetrics() {
      setNodeMetricsLoading(true);
      const result = await MindMap.nodeMetrics(workspace.slug, {
        nodeId: evidenceTarget.id,
      });
      if (cancelled) return;
      setNodeMetricsLoading(false);
      if (result?.error) {
        setNodeMetrics({ error: result.error });
        return;
      }
      nodeMetricsCache.current.set(cacheKey, result);
      setNodeMetrics(result);
      if (result?.stale || result?.emptyReason === "metrics_missing") {
        MindMap.recomputeNodeMetrics(workspace.slug, {
          nodeId: evidenceTarget.id,
        });
      }
    }
    loadNodeMetrics();
    return () => {
      cancelled = true;
    };
  }, [evidenceTarget, isGraphMap, workspace?.slug]);

  useEffect(() => {
    if (!showDocumentMenu) return;
    function handleClickOutside(event) {
      if (
        documentMenuRef.current?.contains(event.target) ||
        documentButtonRef.current?.contains(event.target)
      ) {
        return;
      }
      setShowDocumentMenu(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showDocumentMenu]);

  useEffect(() => {
    if (
      mode !== "graph" ||
      !workspace?.slug ||
      graphConcept.trim().length < 2
    ) {
      setGraphSuggestions([]);
      return;
    }
    clearTimeout(suggestionTimer.current);
    suggestionTimer.current = setTimeout(async () => {
      const concepts = await MindMap.concepts(workspace.slug, graphConcept, 10);
      setGraphSuggestions(concepts);
      setActiveSuggestionIndex(0);
      setShowGraphSuggestions(concepts.length > 0);
    }, 180);
    return () => clearTimeout(suggestionTimer.current);
  }, [graphConcept, mode, workspace?.slug]);

  const generate = useCallback(
    async (body) => {
      if (!workspace?.slug || !body) return;
      setMode("ai");
      setLoading(true);
      setNotice(null);
      setSelectedNode(null);
      setSelectedEdge(null);
      setEvidenceTarget(null);
      setEvidenceData(null);
      setNodeMetrics(null);
      setGraphEmptyReason(null);
      const result = await MindMap.generate(workspace.slug, {
        layout,
        theme,
        threadSlug,
        ...body,
      });
      setLoading(false);

      if (result.error) {
        showToast(result.error || "生成思维导图失败。", "error");
        return;
      }

      if (!result.mindMap && result.suitability?.status === "not_recommended") {
        setPendingBody(body);
        setNotice({
          type: "recommendation",
          message: result.suitability.recommendation,
          documentStatusWarning: result.documentStatusWarning,
        });
        return;
      }

      setPendingBody(null);
      setNotice(
        result.cached
          ? { type: "cached", message: "已命中缓存，直接打开已有思维导图。" }
          : result.documentStatusWarning
            ? {
                type: "warning",
                message: result.documentStatusWarning.message,
              }
            : null
      );
      setActiveMap(result.mindMap);
      setLayout(
        result.mindMap?.schema?.layout || result.mindMap?.layout || layout
      );
      setTheme(result.mindMap?.schema?.theme || result.mindMap?.theme || theme);
      setCollapsed(new Set());
      refreshSavedMaps();
    },
    [workspace?.slug, layout, theme, threadSlug, refreshSavedMaps]
  );

  const loadGraph = useCallback(
    async (concept = graphConcept) => {
      const query = String(concept || "").trim();
      if (!workspace?.slug || !query) return;
      setMode("graph");
      setLoading(true);
      setNotice(null);
      setSelectedNode(null);
      setSelectedEdge(null);
      setEvidenceTarget(null);
      setEvidenceData(null);
      setNodeMetrics(null);
      setGraphEmptyReason(null);
      setPathResult(null);
      setSelectedPathIndex(0);
      graphPositionCache.current = new Map();
      setShowGraphSuggestions(false);
      const result = await MindMap.graph(workspace.slug, {
        concept: query,
        layout,
        maxDepth: 2,
        maxExpandedNodes: 60,
        confidenceCutoff: 0.45,
      });
      setLoading(false);
      if (result.error) {
        showToast(result.error || "加载知识图谱失败。", "error");
        return;
      }
      setGraphStatus(result.graphStatus || graphStatus);
      if (!result.mindMap) {
        setActiveMap(null);
        setGraphEmptyReason(result.emptyReason || "concept_not_found");
        return;
      }
      setActiveMap(result.mindMap);
      setGraphConcept(result.mindMap.sourceTitle || query);
      setLayout(
        result.mindMap?.schema?.layout || result.mindMap?.layout || layout
      );
      setTheme(
        result.mindMap?.schema?.theme || result.mindMap?.theme || "napkin"
      );
      setCollapsed(defaultCollapsed(result.mindMap.schema));
      setNotice(
        result.cache?.hit
          ? { type: "cached", message: "已命中图谱缓存，直接打开关系图。" }
          : null
      );
      return result;
    },
    [graphConcept, graphStatus, layout, workspace?.slug]
  );

  const loadPathFor = useCallback(
    async (sourceValue, targetValue) => {
      const source = String(sourceValue || "").trim();
      const target = String(targetValue || "").trim();
      if (!workspace?.slug || !source || !target) {
        showToast("请输入路径起点和终点。", "warning");
        return null;
      }
      setPathLoading(true);
      const result = await MindMap.graphPath(workspace.slug, {
        source,
        target,
        maxDepth: 4,
        limit: 3,
        confidenceCutoff: 0.45,
        includeEvidence: true,
      });
      setPathLoading(false);
      if (result?.error) {
        showToast(result.error, "error");
        return result;
      }
      setPathResult(result);
      setSelectedPathIndex(0);
      if (!result.paths?.length) {
        showToast("未找到可解释的多跳关系链。", "warning");
      }
      return result;
    },
    [workspace?.slug]
  );

  const loadPath = useCallback(async () => {
    const source = String(pathSource || graphConcept || "").trim();
    const target = String(pathTarget || selectedNode?.label || "").trim();
    return loadPathFor(source, target);
  }, [graphConcept, loadPathFor, pathSource, pathTarget, selectedNode?.label]);

  useEffect(() => {
    if (!request?.id || request.id === lastRequestId.current) return;
    lastRequestId.current = request.id;
    const body = request.body || {};
    async function handleRequest() {
      if (body.sourceType === "graph") {
        await loadGraph(body.concept || body.text || body.source);
        return;
      }
      if (body.sourceType === "graphPath") {
        const source = body.source || body.concept;
        const target = body.target;
        setPathSource(source || "");
        setPathTarget(target || "");
        await loadGraph(source);
        if (source && target) await loadPathFor(source, target);
        return;
      }
      if (body.sourceType === "evidence") {
        const concept = body.concept || body.text || "";
        const targetType = body.targetType === "edge" ? "edge" : "node";
        const targetId = body.targetId;
        await loadGraph(concept);
        if (targetId) {
          setEvidencePage(1);
          setEvidenceTarget({
            type: targetType,
            id: targetId,
            label: body.label || concept,
          });
        }
        return;
      }
      generate(body);
    }
    handleRequest();
  }, [request, generate, loadGraph, loadPathFor]);

  useEffect(() => {
    let cancelled = false;
    async function computeLayout() {
      if (!activeSchema) {
        setNodes([]);
        setEdges([]);
        return;
      }
      const result = await layoutMindMap(activeSchema, collapsed, {
        positionCache: isGraphMap ? graphPositionCache.current : null,
      });
      if (cancelled) return;
      setNodes(result.nodes);
      setEdges(result.edges);
      setTimeout(() => {
        if (activeMap?.viewport && !isGraphMap) {
          setViewport(activeMap.viewport, { duration: 200 });
          return;
        }
        fitView({ padding: 0.18, duration: 260 });
      }, 50);
    }
    computeLayout();
    return () => {
      cancelled = true;
    };
  }, [
    activeSchema,
    activeMap?.viewport,
    collapsed,
    fitView,
    isGraphMap,
    setViewport,
  ]);

  const onNodeClick = useCallback(
    (_, node) => {
      setSelectedNode(node.data);
      setSelectedEdge(null);
      if (isGraphMap && node.data?.sourceNodeId) {
        setEvidencePage(1);
        setEvidenceTarget({
          type: "node",
          id: node.data.sourceNodeId,
          label: node.data.label,
        });
      }
    },
    [isGraphMap]
  );

  const onNodeMouseEnter = useCallback((_, node) => {
    setHoveredNode(node.data);
  }, []);

  const onNodeMouseLeave = useCallback(() => {
    setHoveredNode(null);
  }, []);

  const onEdgeClick = useCallback(
    (_, edge) => {
      const data = edge.data || edge;
      if (data.isLayoutEdge || data.clickable === false) return;
      setSelectedEdge(data);
      setSelectedNode(null);
      const graphEdgeId = parseGraphEdgeId(data.id);
      if (isGraphMap && graphEdgeId) {
        setEvidencePage(1);
        setEvidenceTarget({
          type: "edge",
          id: graphEdgeId,
          label: data.label || data.relationType,
        });
      }
    },
    [isGraphMap]
  );

  useEffect(() => {
    function handleGraphEdgeClick(event) {
      const detail = event.detail || {};
      if (!detail.data) return;
      onEdgeClick(event, { id: detail.id, data: detail.data });
    }
    document.addEventListener("mindmap-graph-edge-click", handleGraphEdgeClick);
    return () =>
      document.removeEventListener(
        "mindmap-graph-edge-click",
        handleGraphEdgeClick
      );
  }, [onEdgeClick]);

  const onNodeDoubleClick = useCallback((_, node) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, []);

  const saveViewport = useCallback(() => {
    if (!activeMap?.id || !workspace?.slug || isGraphMap) return;
    clearTimeout(saveViewportTimer.current);
    saveViewportTimer.current = setTimeout(() => {
      MindMap.updateViewport(workspace.slug, activeMap.id, getViewport());
    }, 600);
  }, [activeMap?.id, workspace?.slug, getViewport, isGraphMap]);

  const exportPng = async () => {
    if (!flowRef.current || !activeMap) return;
    const dataUrl = await toPng(flowRef.current, {
      cacheBust: true,
      backgroundColor: "#f8fafc",
      pixelRatio: 2,
    });
    saveAs(dataUrl, `${safeFilename(activeMap.title)}.png`);
  };

  const exportMarkdown = () => {
    if (!activeMap) return;
    saveBlob(activeMap.markdown || "", `${safeFilename(activeMap.title)}.md`);
  };

  const exportJson = () => {
    if (!activeMap) return;
    saveBlob(
      JSON.stringify(activeSchema || activeMap.schema, null, 2),
      `${safeFilename(activeMap.title)}.json`,
      "application/json"
    );
  };

  const explainSelected = (autoSubmit) => {
    if (!selectedNode) return;
    const prompt = `请进一步解释这个思维导图节点：${selectedNode.label}\n\n相关信息：${selectedNode.description || ""}`;
    if (autoSubmit) sendCommand({ text: prompt, autoSubmit: true });
    else setMessage(prompt);
  };

  const focusSelectedNode = () => {
    if (!selectedNode?.label) return;
    loadGraph(selectedNode.label);
  };

  const runGraphRepair = async () => {
    if (!workspace?.slug) return;
    setLoading(true);
    const result = await MindMap.repair(workspace.slug, {
      batchSize: 25,
      scanLimit: 100,
    });
    setLoading(false);
    if (result?.error) {
      showToast(result.error, "error");
      return;
    }
    showToast("知识图谱自修复已完成一轮。", "success");
    refreshGraphStatus();
  };

  const releaseQuarantine = async (issueId) => {
    if (!workspace?.slug || !issueId) return;
    const result = await MindMap.releaseQuarantine(workspace.slug, issueId);
    if (result?.error) {
      showToast(result.error, "error");
      return;
    }
    showToast("已解除该修复项隔离。", "success");
    refreshGraphStatus();
  };

  const handleGraphKeyDown = (event) => {
    if (!showGraphSuggestions || graphSuggestions.length === 0) {
      if (event.key === "Enter") loadGraph();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestionIndex((idx) =>
        Math.min(idx + 1, graphSuggestions.length - 1)
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestionIndex((idx) => Math.max(idx - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = graphSuggestions[activeSuggestionIndex];
      loadGraph(selected?.canonicalName || graphConcept);
    }
  };

  const graphConceptSearchInput = (
    <div className="relative min-w-[220px] flex-1">
      <MagnifyingGlass
        size={14}
        className="absolute left-2 top-2.5 text-slate-400"
      />
      <input
        value={graphConcept}
        onChange={(event) => setGraphConcept(event.target.value)}
        onFocus={() => setShowGraphSuggestions(graphSuggestions.length > 0)}
        onKeyDown={handleGraphKeyDown}
        className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-7 pr-3 text-xs text-slate-800 outline-none focus:border-blue-300"
        placeholder="搜索概念，例如 Gene duplication / HP1 / Chromatin"
      />
      {showGraphSuggestions && graphSuggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-[240px] overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
          {graphSuggestions.map((concept, index) => (
            <button
              key={concept.id}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => loadGraph(concept.canonicalName)}
              className={`w-full border-b border-slate-100 px-3 py-2 text-left last:border-b-0 ${
                index === activeSuggestionIndex
                  ? "bg-blue-50"
                  : "hover:bg-slate-50"
              }`}
            >
              <span className="block text-xs font-medium text-slate-800">
                {concept.displayNameZh || concept.canonicalName}
              </span>
              {concept.displayNameZh && (
                <span className="mt-0.5 block text-[11px] text-slate-500">
                  {concept.displayNameEn || concept.canonicalName}
                </span>
              )}
              {!!concept.aliases?.length && (
                <span className="mt-0.5 block text-[11px] text-slate-500">
                  {formatAliases(concept.aliases).slice(0, 3).join(" / ")}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const graphCompactStats = graphStatus
    ? `节点 ${graphStatus.nodes || 0} · 关系 ${graphStatus.edges || 0} · 证据 ${
        graphStatus.evidence || 0
      }`
    : "知识图谱状态加载中";

  if (isCollapsed) {
    return (
      <div
        className={`h-full flex-shrink-0 w-[56px] right-0 inset-y-0 bg-zinc-950/80 md:bg-transparent ${
          floating ? "fixed z-30" : "fixed md:relative md:ml-3 z-30 md:z-auto"
        }`}
      >
        <button
          type="button"
          onClick={() => setIsCollapsed(false)}
          className="mt-4 md:mt-[16px] h-[calc(100%-32px)] w-[48px] rounded-l-2xl md:rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-xl flex flex-col items-center justify-center gap-3 hover:bg-slate-50"
          aria-label="展开思维导图"
        >
          <CaretLeft size={18} weight="bold" />
          <span
            className="text-xs font-medium tracking-wide"
            style={{ writingMode: "vertical-rl" }}
          >
            展开导图
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={`h-full overflow-hidden motion-hover flex-shrink-0 w-full md:w-[720px] md:min-w-[680px] xl:w-[860px] 2xl:w-[980px] bg-zinc-950/80 md:bg-transparent ${
        floating
          ? "fixed right-0 inset-y-0 z-30"
          : "fixed md:relative inset-0 md:ml-4 z-30 md:z-auto"
      }`}
    >
      <div className="w-full md:w-[720px] md:min-w-[680px] xl:w-[860px] 2xl:w-[980px] h-full md:h-[calc(100%-32px)] md:mt-[16px] bg-[#f8fafc] light:bg-[#f8fafc] md:rounded-[16px] border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-white flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-slate-900 font-semibold">
              <Sparkle size={18} weight="fill" className="text-blue-500" />
              <span className="truncate">
                {mode === "graph" ? "知识图谱导图" : "AI 思维导图"}
              </span>
            </div>
            <p className="text-xs text-slate-500 truncate">
              {activeMap?.title ||
                (mode === "graph"
                  ? "从 Knowledge Graph 探索概念关系"
                  : "从对话、选中文本或文档生成结构化导图")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsCollapsed(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              aria-label="收起思维导图"
            >
              <CaretRight size={14} weight="bold" />
              收起
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-500 hover:text-slate-900"
              aria-label="关闭思维导图"
            >
              <X size={18} weight="bold" />
            </button>
          </div>
        </div>

        <div className="px-4 pt-3 bg-white border-b border-slate-200">
          <div className="flex gap-2">
            <ModeButton
              active={mode === "ai"}
              onClick={() => {
                setMode("ai");
                if (activeMap?.sourceType === "graph") setActiveMap(null);
              }}
              label="AI 思维导图"
            />
            <ModeButton
              active={mode === "graph"}
              onClick={() => {
                setMode("graph");
                if (activeMap?.sourceType !== "graph") setActiveMap(null);
              }}
              label="知识图谱"
            />
          </div>

          {mode === "graph" && (
            <div className="mt-3 space-y-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  {graphConceptSearchInput}
                  <ToolbarButton
                    label="展开关系"
                    onClick={() => loadGraph()}
                    Icon={GitFork}
                  />
                  <ToolbarButton
                    label="适应视图"
                    onClick={() => fitView({ padding: 0.18, duration: 260 })}
                    Icon={ArrowsOut}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setGraphControlsCollapsed((previous) => !previous)
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                  >
                    {graphControlsCollapsed ? (
                      <CaretDown size={14} weight="bold" />
                    ) : (
                      <CaretRight size={14} weight="bold" />
                    )}
                    {graphControlsCollapsed ? "展开工具" : "折叠工具"}
                  </button>
                  <span className="ml-auto rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-500">
                    {graphCompactStats}
                  </span>
                </div>
                {!graphControlsCollapsed && (
                  <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
                    <GraphStatusBar status={graphStatus} />
                    <RepairStatusBar
                      repair={repairStatus}
                      onRepair={runGraphRepair}
                      onReleaseQuarantine={releaseQuarantine}
                    />
                    {graphStatus?.isSparse && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        当前知识图谱数据较少，结果可能不完整。建议先运行
                        Knowledge Graph backfill。
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setMainOnly((prev) => !prev)}
                        className={`rounded-lg border px-2 py-1 text-xs ${
                          mainOnly
                            ? "border-blue-200 bg-blue-50 text-blue-700"
                            : "border-slate-200 bg-white text-slate-700"
                        }`}
                      >
                        只看主线
                      </button>
                      <button
                        type="button"
                        onClick={() => setHideWeakRelations((prev) => !prev)}
                        className={`rounded-lg border px-2 py-1 text-xs ${
                          hideWeakRelations
                            ? "border-blue-200 bg-blue-50 text-blue-700"
                            : "border-slate-200 bg-white text-slate-700"
                        }`}
                      >
                        隐藏弱关系
                      </button>
                      <button
                        type="button"
                        onClick={() => setHideRelatedTo((prev) => !prev)}
                        className={`rounded-lg border px-2 py-1 text-xs ${
                          hideRelatedTo
                            ? "border-blue-200 bg-blue-50 text-blue-700"
                            : "border-slate-200 bg-white text-slate-700"
                        }`}
                      >
                        隐藏“相关”
                      </button>
                      <select
                        className="text-xs rounded-lg border border-slate-200 bg-white px-2 py-1 text-slate-700"
                        value={relationTypeFilter}
                        onChange={(event) =>
                          setRelationTypeFilter(event.target.value)
                        }
                      >
                        {relationFilterOptions.map((item) => (
                          <option key={item.value} value={item.value}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className="text-xs rounded-lg border border-slate-200 bg-white px-2 py-1 text-slate-700"
                        value={labelMode}
                        onChange={(event) => setLabelMode(event.target.value)}
                      >
                        {labelModes.map((item) => (
                          <option key={item.value} value={item.value}>
                            标签：{item.label}
                          </option>
                        ))}
                      </select>
                      <ToolbarButton
                        label="Focus Node"
                        onClick={focusSelectedNode}
                        Icon={ArrowsOut}
                      />
                    </div>
                    {graphNeedsSimplification && (
                      <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                        已自动简化关系视图，可关闭过滤器手动展开全部关系。
                      </div>
                    )}
                    <PathViewControls
                      source={pathSource}
                      setSource={setPathSource}
                      target={pathTarget}
                      setTarget={setPathTarget}
                      defaultSource={graphConcept}
                      selectedNode={selectedNode}
                      loading={pathLoading}
                      result={pathResult}
                      selectedIndex={selectedPathIndex}
                      setSelectedIndex={setSelectedPathIndex}
                      onLoad={loadPath}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          <div
            className={`mt-3 flex flex-wrap gap-2 items-center ${
              mode === "graph" && graphControlsCollapsed ? "hidden" : "pb-3"
            }`}
          >
            {mode === "ai" && (
              <>
                <select
                  className="text-xs rounded-lg border border-slate-200 bg-white px-2 py-1 text-slate-700"
                  value={!isGraphMap ? activeMap?.id || "" : ""}
                  onChange={(e) => {
                    const map = savedMaps.find(
                      (item) => item.id === Number(e.target.value)
                    );
                    if (!map) return;
                    setActiveMap(map);
                    setLayout(map.schema?.layout || map.layout || "tree");
                    setTheme(map.schema?.theme || map.theme || "napkin");
                    setCollapsed(new Set());
                  }}
                >
                  <option value="">历史导图</option>
                  {savedMaps.map((map) => (
                    <option key={map.id} value={map.id}>
                      {map.title}
                    </option>
                  ))}
                </select>
                {documents.length > 0 && (
                  <DocumentGenerateMenu
                    documents={documents}
                    show={showDocumentMenu}
                    setShow={setShowDocumentMenu}
                    menuRef={documentMenuRef}
                    buttonRef={documentButtonRef}
                    generate={generate}
                  />
                )}
              </>
            )}
            <select
              className="text-xs rounded-lg border border-slate-200 bg-white px-2 py-1 text-slate-700"
              value={layout}
              onChange={(e) => setLayout(e.target.value)}
            >
              {layouts.map((item) => (
                <option key={item} value={item}>
                  {layoutLabels[item] || item}
                </option>
              ))}
            </select>
            <select
              className="text-xs rounded-lg border border-slate-200 bg-white px-2 py-1 text-slate-700"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              {themes.map((item) => (
                <option key={item} value={item}>
                  {themeLabels[item] || item}
                </option>
              ))}
            </select>
            <ToolbarButton
              label="PNG"
              onClick={exportPng}
              Icon={DownloadSimple}
            />
            <ToolbarButton
              label="Markdown"
              onClick={exportMarkdown}
              Icon={FileText}
            />
            <ToolbarButton
              label="JSON"
              onClick={exportJson}
              Icon={ListBullets}
            />
            <ToolbarButton
              label="适应视图"
              onClick={() => fitView({ padding: 0.18, duration: 260 })}
              Icon={ArrowsOut}
            />
          </div>
        </div>

        {notice && (
          <Notice
            notice={notice}
            pendingBody={pendingBody}
            generate={generate}
          />
        )}

        <div className="relative flex-1 min-h-0" ref={flowRef}>
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 text-slate-700 text-sm">
              {mode === "graph" ? "正在加载知识图谱..." : "正在生成思维导图..."}
            </div>
          )}
          {hoveredNode && mode === "graph" && (
            <HoverPreview node={hoveredNode} />
          )}
          {activeMap ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              minZoom={0.15}
              maxZoom={2}
              nodesDraggable={false}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onNodeMouseEnter={onNodeMouseEnter}
              onNodeMouseLeave={onNodeMouseLeave}
              onEdgeClick={onEdgeClick}
              onMoveEnd={saveViewport}
            >
              <Background color="#cbd5e1" gap={24} size={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor="#bfdbfe" />
            </ReactFlow>
          ) : mode === "graph" && graphEmptyReason ? (
            <GraphEmptyState status={graphStatus} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center px-8 text-slate-500">
              <GitFork size={34} className="mb-3 text-blue-500" />
              <p className="text-sm font-medium text-slate-700">
                {mode === "graph"
                  ? "搜索一个概念，探索知识图谱中的关系。"
                  : "从助手回复、选中文本或文档生成思维导图。"}
              </p>
            </div>
          )}
        </div>

        {(selectedNode || selectedEdge) &&
          (isGraphMap ? (
            <EvidencePanel
              node={selectedNode}
              edge={selectedEdge}
              data={evidenceData}
              loading={evidenceLoading}
              sort={evidenceSort}
              setSort={setEvidenceSort}
              cluster={evidenceCluster}
              setCluster={setEvidenceCluster}
              page={evidencePage}
              setPage={setEvidencePage}
              expanded={expandedEvidence}
              setExpanded={setExpandedEvidence}
              onClose={() => {
                setSelectedNode(null);
                setSelectedEdge(null);
                setEvidenceTarget(null);
                setEvidenceData(null);
                setNodeMetrics(null);
                setExpandedEvidence(new Set());
              }}
              workspaceSlug={workspace?.slug}
              setMessage={setMessage}
              nodeMetrics={nodeMetrics}
              nodeMetricsLoading={nodeMetricsLoading}
            />
          ) : (
            <SelectionPanel
              node={selectedNode}
              edge={selectedEdge}
              explainSelected={explainSelected}
              setMessage={setMessage}
            />
          ))}
      </div>
    </div>
  );
}

function DocumentGenerateMenu({
  documents,
  show,
  setShow,
  menuRef,
  buttonRef,
  generate,
}) {
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setShow((prev) => !prev)}
        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
        aria-expanded={show}
      >
        从文档生成
        <CaretDown size={12} weight="bold" />
      </button>
      {show && (
        <div
          ref={menuRef}
          className="absolute left-0 top-[calc(100%+6px)] z-40 w-[280px] max-w-[72vw] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"
        >
          <div className="max-h-[320px] overflow-y-auto overscroll-contain py-1">
            {documents.map((doc) => {
              const docId = doc.docId || doc.id;
              const docPath = doc.docpath || doc.filePath;
              const title = documentTitle(doc);
              const subtitle = documentSubtitle(doc, title);
              return (
                <button
                  key={docId || docPath || title}
                  type="button"
                  onClick={() => {
                    if (!docId && !docPath) return;
                    setShow(false);
                    generate({
                      sourceType: "document",
                      ...(docId ? { docId } : { docPath }),
                    });
                  }}
                  className="w-full border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
                >
                  <span className="block whitespace-normal break-words text-xs font-medium leading-5 text-slate-800">
                    {title}
                  </span>
                  {subtitle && (
                    <span className="mt-0.5 block whitespace-normal break-words text-[11px] leading-4 text-slate-500">
                      {subtitle}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PathViewControls({
  source,
  setSource,
  target,
  setTarget,
  defaultSource,
  selectedNode,
  loading,
  result,
  selectedIndex,
  setSelectedIndex,
  onLoad,
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[180px] flex-1">
          <label className="mb-1 block text-[11px] font-medium text-slate-500">
            Path View 起点
          </label>
          <input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-blue-300"
            placeholder={defaultSource || "起点概念"}
          />
        </div>
        <div className="min-w-[180px] flex-1">
          <label className="mb-1 block text-[11px] font-medium text-slate-500">
            终点
          </label>
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-blue-300"
            placeholder={selectedNode?.label || "终点概念"}
          />
        </div>
        <button
          type="button"
          onClick={onLoad}
          disabled={loading}
          className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
        >
          {loading ? "查找中..." : "解释 A → D"}
        </button>
      </div>
      {!!result?.paths?.length && (
        <div className="mt-3 space-y-2">
          <div className="font-medium text-slate-800">推理关系链</div>
          {result.paths.map((path, index) => (
            <button
              type="button"
              key={`${path.edgeIds?.join("-")}-${index}`}
              onClick={() => setSelectedIndex(index)}
              className={`w-full rounded-lg border px-2 py-2 text-left ${
                selectedIndex === index
                  ? "border-blue-200 bg-blue-50 text-blue-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              <div className="font-medium">
                {(path.nodes || [])
                  .map((node) => node.displayNameZh || node.canonicalName)
                  .join(" → ")}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {path.trustSummary?.level || "medium"} · score{" "}
                {Number(path.trustSummary?.score || path.score || 0).toFixed(2)}
              </div>
            </button>
          ))}
        </div>
      )}
      {result?.emptyReason && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">
          未找到路径：{result.emptyReason}
        </div>
      )}
    </div>
  );
}

function ModeButton({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
        active
          ? "border border-blue-200 bg-blue-50 text-blue-700 shadow-sm"
          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      {label}
    </button>
  );
}

function GraphStatusBar({ status }) {
  if (!status) return null;
  const statusLabel =
    status.backfillStatus === "complete"
      ? "Backfill 完成"
      : status.backfillStatus === "empty"
        ? "未构建"
        : "部分构建";
  return (
    <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
      <StatusPill label="节点" value={status.nodes || 0} />
      <StatusPill label="关系" value={status.edges || 0} />
      <StatusPill label="证据" value={status.evidence || 0} />
      <StatusPill
        label="已处理文档"
        value={`${status.graphProcessedDocuments ?? status.processedDocuments ?? 0}/${status.eligibleVectorDocuments ?? status.vectorDocuments ?? 0}`}
      />
      <StatusPill label="构建状态" value={statusLabel} />
    </div>
  );
}

function RepairStatusBar({ repair, onRepair, onReleaseQuarantine }) {
  if (!repair) return null;
  const latest = repair.latestRun;
  const counts = repair.counts || {};
  const hasAttention =
    Number(counts.open || 0) > 0 ||
    Number(counts.needsReembed || 0) > 0 ||
    Number(counts.quarantined || 0) > 0;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium text-slate-800">
          {hasAttention ? (
            <ShieldWarning size={16} className="text-amber-500" />
          ) : (
            <Wrench size={16} className="text-blue-500" />
          )}
          <span>自修复状态</span>
          {latest?.createdAt && (
            <span className="font-normal text-slate-400">
              最近巡检 {formatRelativeTime(latest.createdAt)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onRepair}
          className="rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
        >
          运行一轮修复
        </button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatusPill label="待修复" value={counts.open || 0} />
        <StatusPill label="需重嵌入" value={counts.needsReembed || 0} />
        <StatusPill label="隔离" value={counts.quarantined || 0} />
        <StatusPill
          label="成功率"
          value={`${Math.round(Number(latest?.successRate || 0) * 100)}%`}
        />
      </div>
      {latest && (
        <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatusPill
            label="Provider失败"
            value={`${Math.round(Number(latest.providerFailureRate || 0) * 100)}%`}
          />
          <StatusPill
            label="低置信关系"
            value={`${Math.round(Number(latest.lowConfidenceRelationRatio || 0) * 100)}%`}
          />
          <StatusPill
            label="related_to"
            value={`${Math.round(Number(latest.relatedToRatio || 0) * 100)}%`}
          />
          <StatusPill
            label="耗时"
            value={`${Math.round(Number(latest.durationMs || 0) / 1000)}s`}
          />
        </div>
      )}
      {!!repair.recentIssues?.length && (
        <div className="mt-3 space-y-2">
          {repair.recentIssues.slice(0, 3).map((issue) => (
            <div
              key={issue.id}
              className="rounded-lg border border-slate-200 bg-white px-2 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-slate-700">
                    {repairIssueLabel(issue)}
                  </div>
                  <div className="mt-1 break-words text-[11px] text-slate-500">
                    {issue.quarantineReason ||
                      issue.explainReason ||
                      issue.lastError ||
                      "等待下一轮自修复处理。"}
                  </div>
                  {(issue.repairMethod || issue.repairConfidence) && (
                    <div className="mt-1 text-[11px] text-slate-400">
                      方法 {issue.repairMethod || "待定"} · 置信度{" "}
                      {issue.repairConfidence || "待定"}
                    </div>
                  )}
                </div>
                {issue.status === "quarantined" && (
                  <button
                    type="button"
                    onClick={() => onReleaseQuarantine(issue.id)}
                    className="shrink-0 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-700 hover:bg-amber-100"
                  >
                    解除隔离
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ label, value }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1">
      <span className="text-slate-400">{label}</span>
      <span className="ml-1 font-semibold text-slate-700">{value}</span>
    </div>
  );
}

function repairIssueLabel(issue = {}) {
  const labels = {
    missing_vector_cache: "缺少 vector-cache",
    missing_graph_job: "缺少图谱任务",
    stale_processing_job: "任务卡住",
    failed_graph_job: "抽取失败",
    missing_graph_text: "缺少可恢复文本",
    suspicious_relation_density: "关系密度异常",
  };
  const statusLabels = {
    open: "待修复",
    repaired: "已修复",
    needs_reembed: "需手动重嵌入",
    quarantined: "已隔离",
    unrecoverable: "不可恢复",
  };
  return `${labels[issue.issueType] || issue.issueType} · ${
    statusLabels[issue.status] || issue.status
  }`;
}

function formatRelativeTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function Notice({ notice, pendingBody, generate }) {
  return (
    <div
      className={`mx-4 mt-3 rounded-xl border px-3 py-2 text-xs ${
        notice.type === "recommendation"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-blue-200 bg-blue-50 text-blue-800"
      }`}
    >
      <div>{notice.message}</div>
      {notice.documentStatusWarning && (
        <div className="mt-1">{notice.documentStatusWarning.message}</div>
      )}
      {notice.type === "recommendation" && pendingBody && (
        <button
          type="button"
          onClick={() => generate({ ...pendingBody, force: true })}
          className="mt-2 rounded-lg bg-amber-600 px-3 py-1 text-white"
        >
          仍然生成
        </button>
      )}
    </div>
  );
}

function GraphEmptyState({ status }) {
  return (
    <div className="h-full flex flex-col items-center justify-center px-8 text-center">
      <GitFork size={34} className="mb-3 text-slate-400" />
      <p className="text-sm font-semibold text-slate-800">没有找到该概念。</p>
      <p className="mt-2 text-xs text-slate-500">你可以尝试：</p>
      <div className="mt-3 space-y-1 text-xs text-slate-500">
        <div>换一个关键词</div>
        <div>先运行 Knowledge Graph backfill</div>
        <div>在已生成节点中搜索</div>
      </div>
      <div className="mt-5 w-full max-w-sm">
        <GraphStatusBar status={status} />
      </div>
    </div>
  );
}

function HoverPreview({ node }) {
  return (
    <div className="absolute left-4 top-4 z-20 w-[280px] rounded-xl border border-slate-200 bg-white/95 p-3 text-xs text-slate-600 shadow-xl backdrop-blur">
      <div className="font-semibold text-slate-900">{node.label}</div>
      {!!node.aliases?.length && (
        <div className="mt-1">
          别名：{formatAliases(node.aliases).slice(0, 4).join(" / ")}
        </div>
      )}
      <div className="mt-2 grid grid-cols-2 gap-1">
        <span>证据：{node.evidenceCount || 0}</span>
        <span>重要度：{formatScore(node.importanceScore)}</span>
        <span>工作区：{formatScore(node.workspaceImportanceScore)}</span>
        <span>近期：{formatScore(node.recentImportanceScore)}</span>
      </div>
      {!!node.topChunks?.length && (
        <div className="mt-2">
          <div className="font-medium text-slate-700">相关片段</div>
          {node.topChunks.slice(0, 3).map((chunk) => (
            <div key={chunk.chunkId} className="mt-1 truncate text-slate-500">
              {chunk.title || chunk.documentId}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EvidencePanel({
  node,
  edge,
  data,
  loading,
  nodeMetrics,
  nodeMetricsLoading,
  sort,
  setSort,
  cluster,
  setCluster,
  page,
  setPage,
  expanded,
  setExpanded,
  onClose,
  workspaceSlug,
  setMessage,
}) {
  const [showFullRadar, setShowFullRadar] = useState(false);
  const [showMetricBasis, setShowMetricBasis] = useState(false);
  const targetType = edge ? "edge" : "node";
  const targetId = edge ? parseGraphEdgeId(edge.id) : node?.sourceNodeId;
  const title = edge
    ? data?.edge
      ? `${conceptName(data.edge.sourceConcept)} → ${conceptName(
          data.edge.targetConcept
        )}`
      : edge.label || edge.relationType || "关系证据"
    : data?.concept
      ? conceptName(data.concept)
      : node?.label || "概念证据";

  const recordUsage = (action) => {
    if (!workspaceSlug || !targetId) return;
    MindMap.recordEvidenceUsage(workspaceSlug, {
      targetType,
      targetId: String(targetId),
      action,
    });
  };

  const toggleFullChunk = (item) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    recordUsage("expand_chunk");
  };

  const jumpToEvidence = (item) => {
    setExpanded((prev) => new Set(prev).add(item.id));
    recordUsage("jump");
    setTimeout(() => {
      document
        .getElementById(`kg-evidence-source-${item.id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 40);
  };

  const copyCitation = async (item) => {
    const citation = [
      `> ${item.snippet || "无 snippet"}`,
      "",
      `来源：${item.document?.filename || item.documentId || "未知文档"}`,
      `chunk: ${item.chunkId}`,
      item.relation?.relationType
        ? `relation: ${item.relation.relationType}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    await navigator.clipboard?.writeText(citation).catch(() => null);
    recordUsage("copy");
    showToast("已复制引用。", "success");
  };

  const askWithEvidence = (item) => {
    setMessage(
      `请基于下面这段原始证据继续解释，不要脱离原文：\n\n${item.snippet || ""}\n\n来源：${
        item.document?.filename || item.documentId || "未知文档"
      }\nchunk: ${item.chunkId}`
    );
    recordUsage("ask");
  };

  return (
    <div className="max-h-[42%] min-h-[190px] overflow-hidden border-t border-slate-200 bg-white">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
            {edge && (
              <span>
                {data?.edge?.relationLabelZh
                  ? `${data.edge.relationLabelZh} · `
                  : ""}
                {data?.edge?.relationType || edge.relationType}
              </span>
            )}
            {data?.trustLevel && (
              <TrustBadge level={data.trustLevel} score={data.trustScore} />
            )}
            {data?.stabilityLevel && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                {stabilityLabel(data.stabilityLevel)}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <select
            value={sort}
            onChange={(event) => {
              setPage(1);
              setSort(event.target.value);
            }}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
          >
            <option value="trust">可信度优先</option>
            <option value="rank">最可靠</option>
            <option value="timeline">时间线</option>
          </select>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900"
            aria-label="关闭证据详情"
          >
            <X size={14} weight="bold" />
          </button>
        </div>
      </div>

      <div className="h-[calc(100%-46px)] overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="py-8 text-center text-xs text-slate-500">
            正在加载原始证据...
          </div>
        ) : data?.error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {data.error}
          </div>
        ) : (
          <>
            <EvidenceSummary data={data} />
            {!edge && (
              <ImportanceRadar
                metrics={nodeMetrics}
                loading={nodeMetricsLoading}
                showFull={showFullRadar}
                setShowFull={setShowFullRadar}
                showBasis={showMetricBasis}
                setShowBasis={setShowMetricBasis}
              />
            )}
            <ClusterFilter
              clusters={data?.clusters || []}
              active={cluster}
              setActive={(value) => {
                setPage(1);
                setCluster(value);
              }}
            />
            <WhyNoEvidence info={data?.whyNoEvidence} />
            <div className="mt-3 space-y-3">
              {(data?.evidence || []).map((item) => (
                <EvidenceCard
                  key={item.id}
                  item={item}
                  expanded={expanded.has(item.id)}
                  onToggle={() => toggleFullChunk(item)}
                  onJump={() => jumpToEvidence(item)}
                  onCopy={() => copyCitation(item)}
                  onAsk={() => askWithEvidence(item)}
                />
              ))}
            </div>
            <EvidencePagination
              pagination={data?.pagination}
              page={page}
              setPage={setPage}
            />
          </>
        )}
      </div>
    </div>
  );
}

const radarLabels = {
  evidenceStrength: "证据强度",
  bridgeValue: "桥接价值",
  knowledgeConnectivity: "知识连接度",
  traversalImportance: "推理核心度",
  crossDocumentPresence: "跨文档出现率",
  freshness: "近期活跃度",
  relationDiversity: "关系多样性",
  sourceAuthority: "来源可信度",
  stability: "稳定性",
  conflictSafety: "冲突安全度",
};
const compactRadarKeys = [
  "evidenceStrength",
  "bridgeValue",
  "traversalImportance",
  "sourceAuthority",
];

function ImportanceRadar({
  metrics,
  loading,
  showFull,
  setShowFull,
  showBasis,
  setShowBasis,
}) {
  const [activeMetric, setActiveMetric] = useState(null);
  if (loading) {
    return (
      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
        正在加载重要性指标...
      </div>
    );
  }
  if (metrics?.error) {
    return (
      <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
        {metrics.error}
      </div>
    );
  }
  if (!metrics?.radar?.length) {
    return (
      <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-3 text-xs text-blue-800">
        <div className="font-semibold">暂无重要性指标</div>
        <div className="mt-1">
          已请求后台计算，可稍后刷新，或运行 CLI 重新计算节点指标。
        </div>
      </div>
    );
  }

  const radarItems = showFull
    ? metrics.radar
    : metrics.radar.filter((item) => compactRadarKeys.includes(item.key));
  const active = activeMetric || radarItems[0];

  return (
    <div className="mt-3 rounded-2xl border border-blue-100 bg-gradient-to-br from-white to-blue-50/50 p-3 text-xs text-slate-700">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-slate-900">重要性雷达图</div>
          <div className="mt-1 max-w-[520px] text-[11px] leading-4 text-slate-500">
            该雷达图表示当前 workspace 图谱结构下的相对重要性，不代表客观真理。
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setShowFull(!showFull)}
            className="rounded-lg border border-blue-200 bg-white px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-50"
          >
            {showFull ? "核心维度" : "完整 10 维"}
          </button>
          <button
            type="button"
            onClick={() => setShowBasis(!showBasis)}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
          >
            查看计算依据
          </button>
        </div>
      </div>
      {metrics.stale && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          指标可能过期，后台会自动刷新。
        </div>
      )}
      {metrics.warning && (
        <div className="mt-2 rounded-lg border border-orange-200 bg-orange-50 px-2 py-1 text-[11px] text-orange-800">
          该节点指标近期波动异常，建议检查 evidence / repair 状态。
        </div>
      )}
      <div className="mt-3 grid gap-3 md:grid-cols-[180px_1fr]">
        <RadarSvg
          items={radarItems}
          activeKey={active?.key}
          onActive={setActiveMetric}
        />
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {radarItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onMouseEnter={() => setActiveMetric(item)}
                onFocus={() => setActiveMetric(item)}
                className={`rounded-lg border px-2 py-1 text-left transition ${
                  active?.key === item.key
                    ? "border-blue-200 bg-blue-50 text-blue-800"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span className="block text-[11px] font-medium">
                  {item.labelZh || radarLabels[item.key] || item.key}
                </span>
                <span className="mt-0.5 block text-sm font-semibold">
                  {item.score}
                </span>
              </button>
            ))}
          </div>
          {active && (
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
              <div className="font-semibold text-slate-800">
                {active.labelZh || radarLabels[active.key]}{" "}
                <span className="font-normal text-slate-400">
                  {active.labelEn}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                formulaVersion:{" "}
                {active.formulaVersion || metrics.formulaVersion}
              </div>
              <div className="mt-2 space-y-1 text-[11px] leading-4 text-slate-600">
                {(active.reasons || []).slice(0, 4).map((reason, index) => (
                  <div key={`${active.key}-${index}`}>{reason}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {showBasis && <MetricBasis metrics={metrics} />}
    </div>
  );
}

function RadarSvg({ items = [], activeKey, onActive }) {
  const size = 168;
  const center = size / 2;
  const radius = 58;
  const angleStep = (Math.PI * 2) / Math.max(1, items.length);
  const points = items.map((item, index) => {
    const angle = -Math.PI / 2 + angleStep * index;
    const valueRadius = radius * (Number(item.score || 0) / 100);
    return {
      item,
      x: center + Math.cos(angle) * valueRadius,
      y: center + Math.sin(angle) * valueRadius,
      axisX: center + Math.cos(angle) * radius,
      axisY: center + Math.sin(angle) * radius,
    };
  });
  const polygon = points.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-[180px] w-full rounded-xl border border-blue-100 bg-white"
      role="img"
      aria-label="重要性雷达图"
    >
      {[0.33, 0.66, 1].map((scale) => (
        <circle
          key={scale}
          cx={center}
          cy={center}
          r={radius * scale}
          fill="none"
          stroke="#dbeafe"
          strokeWidth="1"
        />
      ))}
      {points.map((point) => (
        <line
          key={`axis-${point.item.key}`}
          x1={center}
          y1={center}
          x2={point.axisX}
          y2={point.axisY}
          stroke="#e2e8f0"
          strokeWidth="1"
        />
      ))}
      <polygon
        points={polygon}
        fill="#60a5fa"
        fillOpacity="0.22"
        stroke="#2563eb"
        strokeWidth="2"
      />
      {points.map((point) => (
        <g key={point.item.key}>
          <circle
            cx={point.x}
            cy={point.y}
            r={activeKey === point.item.key ? 4.5 : 3.5}
            fill={activeKey === point.item.key ? "#1d4ed8" : "#60a5fa"}
            tabIndex="0"
            onMouseEnter={() => onActive(point.item)}
            onFocus={() => onActive(point.item)}
            className="cursor-pointer outline-none"
          />
          <title>
            {point.item.labelZh || radarLabels[point.item.key]}:{" "}
            {point.item.score}
          </title>
        </g>
      ))}
    </svg>
  );
}

function MetricBasis({ metrics }) {
  const inputs = metrics.normalizedInputs || {};
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
      <div className="font-semibold text-slate-800">计算依据</div>
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        {Object.entries(inputs).map(([key, value]) => (
          <div
            key={key}
            className="rounded-lg border border-slate-100 bg-slate-50 px-2 py-1"
          >
            <div className="text-[10px] uppercase text-slate-400">{key}</div>
            <div className="mt-0.5 break-all text-[11px] font-semibold text-slate-700">
              {String(value)}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {(metrics.radar || []).map((item) => (
          <details
            key={item.key}
            className="rounded-lg border border-slate-100 bg-slate-50 px-2 py-1"
          >
            <summary className="cursor-pointer text-[11px] font-medium text-slate-700">
              {item.labelZh || radarLabels[item.key]} · {item.score} ·{" "}
              {item.formulaVersion || metrics.formulaVersion}
            </summary>
            <div className="mt-1 space-y-0.5 text-[11px] leading-4 text-slate-500">
              {(item.reasons || []).map((reason, index) => (
                <div key={`${item.key}-basis-${index}`}>{reason}</div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function EvidenceSummary({ data }) {
  if (!data) return null;
  return (
    <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
      <StatusPill
        label="证据可信度"
        value={trustLabel(data.trustLevel, data.trustScore)}
      />
      <StatusPill
        label="证据数量"
        value={data.pagination?.total || data.evidence?.length || 0}
      />
      <StatusPill
        label="关系数量"
        value={data.relationCount ?? data.edge?.weight ?? 0}
      />
      <StatusPill label="漂移" value={driftLabel(data.drift?.driftLevel)} />
      {data.stabilityExplanation && (
        <div className="col-span-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600 md:col-span-4">
          证据稳定性：{data.stabilityExplanation}
        </div>
      )}
      {data.drift?.driftLevel && data.drift.driftLevel !== "none" && (
        <div className="col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800 md:col-span-4">
          Evidence drift：{data.drift.explanation}
        </div>
      )}
    </div>
  );
}

function ClusterFilter({ clusters = [], active, setActive }) {
  const visible = clusters.filter((item) => item.count > 0);
  if (!visible.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      <button
        type="button"
        onClick={() => setActive("")}
        className={`rounded-full border px-2 py-0.5 text-[11px] ${
          !active
            ? "border-blue-200 bg-blue-50 text-blue-700"
            : "border-slate-200 text-slate-600"
        }`}
      >
        全部
      </button>
      {visible.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => setActive(item.key)}
          className={`rounded-full border px-2 py-0.5 text-[11px] ${
            active === item.key
              ? "border-blue-200 bg-blue-50 text-blue-700"
              : "border-slate-200 text-slate-600"
          }`}
        >
          {item.label} {item.count}
        </button>
      ))}
    </div>
  );
}

function WhyNoEvidence({ info }) {
  if (!info) return null;
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <div className="font-semibold">为什么没有强证据？</div>
      <div className="mt-1">{(info.reasons || []).join("；")}</div>
      {info.recommendedAction && (
        <div className="mt-1 text-amber-700">{info.recommendedAction}</div>
      )}
    </div>
  );
}

function EvidenceCard({ item, expanded, onToggle, onJump, onCopy, onAsk }) {
  return (
    <div
      id={`kg-evidence-${item.id}`}
      className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <TrustBadge level={item.trustLevel} score={item.trustScore} />
        <span className="rounded-full bg-white px-2 py-0.5 text-slate-600">
          {item.clusterLabel || "其他"}
        </span>
        <span className="rounded-full bg-white px-2 py-0.5 text-slate-600">
          {stabilityLabel(item.stabilityLevel)}
        </span>
        {item.conflicts?.length > 0 && (
          <span
            className={`rounded-full px-2 py-0.5 ${conflictClass(
              item.conflicts
            )}`}
          >
            冲突：{conflictSeverityLabel(item.conflicts)}
          </span>
        )}
      </div>
      <div className="mt-2 rounded-lg bg-white p-2 leading-5 text-slate-800">
        {highlightText(item.snippet || "暂无 snippet", item.highlightTerms)}
      </div>
      {(item.contextBefore || item.contextAfter) && (
        <div className="mt-2 rounded-lg border border-slate-100 bg-white/70 p-2 text-[11px] leading-5 text-slate-500">
          {item.contextBefore && (
            <div>{highlightText(item.contextBefore, item.highlightTerms)}</div>
          )}
          {item.contextAfter && (
            <div>{highlightText(item.contextAfter, item.highlightTerms)}</div>
          )}
        </div>
      )}
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <ReasonBlock
          title="为什么选中这段证据？"
          lines={[item.whyThisEvidence]}
        />
        <ReasonBlock title="为什么可信/不可信？" lines={item.trustReasons} />
        <ReasonBlock title="来源权威性" lines={item.sourceAuthorityReasons} />
        {item.drift?.explanation && (
          <ReasonBlock
            title="Evidence drift"
            lines={[item.drift.explanation]}
          />
        )}
      </div>
      <div className="mt-2 break-all text-[11px] text-slate-500">
        来源：{item.document?.filename || item.documentId || "未知文档"} · chunk{" "}
        {item.chunkId} · relation {item.relation?.relationType || "n/a"}
      </div>
      {expanded && item.fullChunk && (
        <SourceMarkdownReader item={item} onCollapse={onToggle} />
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <EvidenceAction label="跳转原文" onClick={onJump} />
        <EvidenceAction
          label={expanded ? "收起完整 chunk" : "展开完整 chunk"}
          onClick={onToggle}
        />
        <EvidenceAction label="复制引用" onClick={onCopy} />
        <EvidenceAction label="继续提问" onClick={onAsk} />
      </div>
    </div>
  );
}

function SourceMarkdownReader({ item, onCollapse }) {
  const sourceTitle = item.document?.filename || item.documentId || "未知文档";
  return (
    <div
      id={`kg-evidence-source-${item.id}`}
      className="mt-3 overflow-hidden rounded-xl border border-blue-100 bg-white shadow-sm"
    >
      <div className="flex items-start justify-between gap-3 border-b border-blue-50 bg-blue-50/70 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-800">原文上下文</div>
          <div className="mt-0.5 break-all text-[11px] text-slate-500">
            {sourceTitle} · chunk {item.chunkId}
          </div>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          className="shrink-0 rounded-lg border border-blue-100 bg-white px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-50"
        >
          收起原文
        </button>
      </div>
      <div
        className="kg-evidence-markdown markdown max-h-[340px] overflow-y-auto px-4 py-3 text-[12px] leading-6 text-slate-700 [&_*]:!text-slate-700 [&_a]:!text-blue-700 [&_code]:!text-slate-800 [&_h1]:!text-slate-900 [&_h2]:!text-slate-900 [&_h3]:!text-slate-900 [&_li::marker]:!text-slate-500 [&_strong]:!font-semibold [&_strong]:!text-slate-900 [&_.hljs]:!max-w-full"
        dangerouslySetInnerHTML={{
          __html: DOMPurify.sanitize(renderMarkdown(item.fullChunk || "")),
        }}
      />
    </div>
  );
}

function ReasonBlock({ title, lines = [] }) {
  const visible = (lines || []).filter(Boolean).slice(0, 4);
  if (!visible.length) return null;
  return (
    <div className="rounded-lg border border-slate-100 bg-white px-2 py-1.5">
      <div className="font-medium text-slate-700">{title}</div>
      <div className="mt-1 space-y-0.5 text-[11px] leading-4 text-slate-500">
        {visible.map((line, index) => (
          <div key={`${title}-${index}`}>{line}</div>
        ))}
      </div>
    </div>
  );
}

function EvidenceAction({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
    >
      {label}
    </button>
  );
}

function EvidencePagination({ pagination, page, setPage }) {
  if (!pagination || pagination.totalPages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
      <span>
        第 {pagination.page} / {pagination.totalPages} 页，共 {pagination.total}{" "}
        条证据
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage(Math.max(1, page - 1))}
          className="rounded-lg border border-slate-200 px-2 py-1 disabled:opacity-40"
        >
          上一页
        </button>
        <button
          type="button"
          disabled={page >= pagination.totalPages}
          onClick={() => setPage(page + 1)}
          className="rounded-lg border border-slate-200 px-2 py-1 disabled:opacity-40"
        >
          下一页
        </button>
      </div>
    </div>
  );
}

function SelectionPanel({ node, edge, explainSelected, setMessage }) {
  if (edge) {
    return (
      <div className="border-t border-slate-200 bg-white p-3">
        <div className="text-sm font-semibold text-slate-900">
          {edge.label || edge.relationType || "Relation"}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {edge.relationLabelZh ? `${edge.relationLabelZh} · ` : ""}
          置信度 {formatScore(edge.confidence)} · 证据{" "}
          {edge.evidenceCount || edge.evidence?.length || 0}
        </div>
        <EvidenceList evidence={edge.evidence} chunkIds={edge.chunkIds} />
      </div>
    );
  }

  if (!node) return null;
  return (
    <div className="border-t border-slate-200 bg-white p-3">
      <div className="text-sm font-semibold text-slate-900">{node.label}</div>
      {node.description && (
        <div className="mt-1 text-xs text-slate-500">{node.description}</div>
      )}
      <EvidenceList chunks={node.topChunks} />
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => explainSelected(true)}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white"
        >
          在对话中解释
        </button>
        <button
          type="button"
          onClick={() =>
            setMessage(
              `请帮我基于知识图谱证据解释：${node.label}\n\n${node.description || ""}`
            )
          }
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700"
        >
          填入输入框
        </button>
      </div>
    </div>
  );
}

function EvidenceList({ evidence = [], chunks = [], chunkIds = [] }) {
  const items = evidence?.length ? evidence : chunks;
  if (!items?.length && !chunkIds?.length) return null;
  return (
    <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs text-slate-600">
      {(items || []).slice(0, 3).map((item) => (
        <div key={item.id || item.chunkId} className="mb-2 last:mb-0">
          {item.snippet && <div className="text-slate-700">{item.snippet}</div>}
          <div className="mt-0.5 break-all text-[11px] text-slate-400">
            {item.title || item.documentId || item.path} · chunk{" "}
            {item.chunkId || ""}
          </div>
        </div>
      ))}
      {!items?.length && chunkIds?.length && (
        <div className="break-all text-[11px] text-slate-400">
          chunks: {chunkIds.slice(0, 3).join(", ")}
        </div>
      )}
    </div>
  );
}

function ToolbarButton({ label, onClick, Icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function filterGraphSchema(schema = {}, options = {}) {
  const selectedEdgeIds = new Set(
    (options.selectedPath?.edgeIds || []).map((id) => `kg-edge-${id}`)
  );
  const autoSimplified = Boolean(options.autoSimplified);
  const edges = (schema.edges || [])
    .map((edge) => ({
      ...edge,
      labelMode:
        options.labelMode === "auto"
          ? edge.labelModeDefault || "auto"
          : options.labelMode,
      isPathEdge: selectedEdgeIds.has(edge.id),
      isSelectedEdge: options.selectedEdgeId === edge.id,
    }))
    .filter((edge) => {
      if (edge.isLayoutEdge || edge.edgeRole === "layout") return true;
      if (options.mainOnly) return edge.isMainEdge;
      if (
        (autoSimplified || options.hideWeakRelations) &&
        (edge.isWeakRelation ||
          edge.relationType === "related_to" ||
          Number(edge.confidence ?? 1) < 0.55 ||
          Number(edge.evidenceCount || 0) === 0)
      )
        return false;
      if (options.hideRelatedTo && edge.relationType === "related_to")
        return false;
      if (options.relationTypeFilter === "conflict") return edge.isConflictEdge;
      if (
        options.relationTypeFilter &&
        options.relationTypeFilter !== "all" &&
        edge.relationType !== options.relationTypeFilter
      )
        return false;
      return true;
    });
  const budgetedEdges = applyEdgeBudget(edges, autoSimplified);
  const pathNodeIds = new Set(
    (options.selectedPath?.nodeIds || []).map((id) => `kg-${id}`)
  );
  return {
    ...schema,
    edgeLabelMode:
      autoSimplified && options.labelMode === "auto"
        ? "main"
        : options.labelMode,
    nodes: (schema.nodes || []).map((node) => ({
      ...node,
      isPathNode: pathNodeIds.has(node.id),
    })),
    edges: budgetedEdges,
  };
}

function applyEdgeBudget(edges = [], autoSimplified = false) {
  const main = edges.filter((edge) => edge.isMainEdge || edge.isLayoutEdge);
  const rest = edges
    .filter((edge) => !edge.isMainEdge && !edge.isLayoutEdge)
    .sort(edgeSortScore);
  const counts = new Map();
  const kept = [...main];
  for (const edge of rest) {
    const role = edge.edgeRole || "support";
    const limit =
      role === "branch" ? 6 : role === "support" ? 4 : autoSimplified ? 0 : 2;
    const sourceCount = counts.get(edge.source) || 0;
    const targetCount = counts.get(edge.target) || 0;
    if (sourceCount >= limit || targetCount >= limit) continue;
    kept.push(edge);
    counts.set(edge.source, sourceCount + 1);
    counts.set(edge.target, targetCount + 1);
  }
  return kept;
}

function edgeSortScore(a = {}, b = {}) {
  const roleWeight = { branch: 5, support: 3, conflict: 4, weak: 1 };
  const score = (edge) =>
    (roleWeight[edge.edgeRole] || 2) * 10 +
    Number(edge.confidence || 0) * 4 +
    Math.min(3, Number(edge.weight || 0)) +
    Math.min(3, Number(edge.evidenceCount || 0)) -
    (edge.relationType === "related_to" ? 5 : 0);
  return score(b) - score(a);
}

function defaultCollapsed(schema = {}) {
  return new Set(
    (schema.nodes || [])
      .filter((node) => node.collapsedByDefault)
      .map((node) => node.id)
  );
}

function safeFilename(value = "mind-map") {
  return String(value || "mind-map")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function documentTitle(doc = {}) {
  return (
    doc.filename ||
    doc.title ||
    doc.name ||
    doc.docpath ||
    doc.filePath ||
    "未命名文档"
  );
}

function documentSubtitle(doc = {}, title = "") {
  const candidate = doc.docpath || doc.filePath || doc.location || doc.type;
  if (!candidate || candidate === title) return "";
  return candidate;
}

function saveBlob(content, filename, type = "text/markdown") {
  saveAs(new Blob([content], { type }), filename);
}

function formatScore(value) {
  return Number(value || 0).toFixed(2);
}

function formatAliases(aliases = []) {
  return (Array.isArray(aliases) ? aliases : [])
    .flatMap((alias) => {
      if (alias && typeof alias === "object") {
        return [alias.zh, alias.en].filter(Boolean);
      }
      return [alias].filter(Boolean);
    })
    .map((alias) => String(alias));
}

function parseGraphEdgeId(value = "") {
  const match = String(value || "").match(/^kg-edge-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function conceptName(concept = {}) {
  if (!concept) return "";
  return (
    concept.displayNameZh ||
    concept.displayNameEn ||
    concept.canonicalName ||
    ""
  );
}

function trustLabel(level, score) {
  const labels = { high: "高可信", medium: "中可信", low: "低可信" };
  return `${labels[level] || "待评估"} ${formatScore(score)}`;
}

function driftLabel(level) {
  const labels = {
    none: "稳定",
    watch: "观察",
    degrading: "下降",
  };
  return labels[level] || "无";
}

function stabilityLabel(level) {
  const labels = {
    stable: "长期稳定",
    emerging: "新出现",
    unstable: "低稳定",
    weak: "证据较弱",
  };
  return labels[level] || "待评估";
}

function TrustBadge({ level, score }) {
  const classes = {
    high: "bg-emerald-50 text-emerald-700 border-emerald-200",
    medium: "bg-blue-50 text-blue-700 border-blue-200",
    low: "bg-amber-50 text-amber-700 border-amber-200",
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] ${
        classes[level] || "border-slate-200 bg-slate-50 text-slate-600"
      }`}
    >
      {trustLabel(level, score)}
    </span>
  );
}

function conflictSeverityLabel(conflicts = []) {
  if (conflicts.some((item) => item.severity === "severe")) return "严重";
  if (conflicts.some((item) => item.severity === "moderate")) return "中度";
  return "轻度";
}

function conflictClass(conflicts = []) {
  const severity = conflictSeverityLabel(conflicts);
  if (severity === "严重") return "bg-rose-50 text-rose-700";
  if (severity === "中度") return "bg-orange-50 text-orange-700";
  return "bg-amber-50 text-amber-700";
}

function highlightText(text = "", terms = []) {
  const value = String(text || "");
  const cleanTerms = [...new Set((terms || []).filter(Boolean).map(String))]
    .filter((term) => term.length >= 2)
    .slice(0, 8);
  if (!cleanTerms.length) return value;
  const pattern = new RegExp(
    `(${cleanTerms.map(escapeRegExp).join("|")})`,
    "gi"
  );
  return value.split(pattern).map((part, index) => {
    const isMatch = cleanTerms.some(
      (term) => term.toLowerCase() === part.toLowerCase()
    );
    if (!isMatch) return <span key={`${part}-${index}`}>{part}</span>;
    return (
      <mark
        key={`${part}-${index}`}
        className="rounded bg-yellow-100 px-0.5 text-slate-900"
      >
        {part}
      </mark>
    );
  });
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
