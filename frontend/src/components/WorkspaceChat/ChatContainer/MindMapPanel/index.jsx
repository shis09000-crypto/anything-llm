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
  Sparkle,
  X,
} from "@phosphor-icons/react";
import MindMap from "@/models/mindMap";
import NodeSupplement from "@/models/nodeSupplement";
import WorkspaceOverviewModel from "@/models/workspaceOverview";
import showToast from "@/utils/toast";
import renderMarkdown from "@/utils/chat/markdown";
import DOMPurify from "@/utils/chat/purify";
import AppButton from "@/components/lib/AppButton";
import AppDropdownButton from "@/components/lib/AppDropdownButton";
import AppToggleButton from "@/components/lib/AppToggleButton";
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
    const stats = await MindMap.graphStats(workspace.slug);
    setGraphStatus(stats);
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
        const result = await loadGraph(
          body.concept || body.text || body.source
        );
        const targetNode = findGraphNode(result?.mindMap?.schema, body);
        if (targetNode) {
          setSelectedNode(targetNode);
          setSelectedEdge(null);
          if (targetNode.sourceNodeId) {
            setEvidencePage(1);
            setEvidenceTarget({
              type: "node",
              id: targetNode.sourceNodeId,
              label: targetNode.label,
            });
          }
        }
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
        className={`fixed right-0 inset-y-0 z-30 h-full flex-shrink-0 w-[56px] bg-zinc-950/80 md:bg-transparent ${
          floating ? "" : "md:right-[16px]"
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
      className={`fixed inset-y-0 right-0 z-30 h-full w-full overflow-hidden bg-zinc-950/45 motion-hover md:pointer-events-none md:flex md:justify-end md:bg-transparent ${
        floating ? "" : "md:right-[16px]"
      }`}
    >
      <div className="pointer-events-auto h-full w-full bg-[#f8fafc] light:bg-[#f8fafc] shadow-2xl flex flex-col overflow-hidden md:mt-[16px] md:h-[calc(100%-32px)] md:w-[720px] md:rounded-[16px] md:border md:border-slate-200 xl:w-[820px] 2xl:w-[900px]">
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
            <AppButton
              variant="secondary"
              size="sm"
              onClick={() => setIsCollapsed(true)}
              leftIcon={<CaretRight weight="bold" />}
              aria-label="收起思维导图"
            >
              收起
            </AppButton>
            <AppButton
              variant="secondary"
              size="sm"
              iconOnly
              onClick={onClose}
              leftIcon={<X weight="bold" />}
              aria-label="关闭思维导图"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col bg-[#f8fafc]">
          <div
            className={`relative z-30 max-h-[45%] shrink-0 overscroll-contain border-b border-slate-200 bg-white px-4 pt-3 ${
              showGraphSuggestions ? "overflow-visible" : "overflow-y-auto"
            }`}
          >
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
                <div className="relative z-30 rounded-xl border border-slate-200 bg-slate-50/80 p-2">
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
                    <AppButton
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setGraphControlsCollapsed((previous) => !previous)
                      }
                      leftIcon={
                        graphControlsCollapsed ? (
                          <CaretDown weight="bold" />
                        ) : (
                          <CaretRight weight="bold" />
                        )
                      }
                    >
                      {graphControlsCollapsed ? "展开工具" : "折叠工具"}
                    </AppButton>
                    <span className="ml-auto rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-500">
                      {graphCompactStats}
                    </span>
                  </div>
                  {!graphControlsCollapsed && (
                    <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
                      <GraphStatusBar status={graphStatus} />
                      {graphStatus?.isSparse && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          当前知识图谱数据较少，结果可能不完整。建议先运行
                          Knowledge Graph backfill。
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <AppToggleButton
                          size="sm"
                          selected={mainOnly}
                          onClick={() => setMainOnly((prev) => !prev)}
                          className="app-toggle-button-compact"
                        >
                          只看主线
                        </AppToggleButton>
                        <AppToggleButton
                          size="sm"
                          selected={hideWeakRelations}
                          onClick={() => setHideWeakRelations((prev) => !prev)}
                          className="app-toggle-button-compact"
                        >
                          隐藏弱关系
                        </AppToggleButton>
                        <AppToggleButton
                          size="sm"
                          selected={hideRelatedTo}
                          onClick={() => setHideRelatedTo((prev) => !prev)}
                          className="app-toggle-button-compact"
                        >
                          隐藏“相关”
                        </AppToggleButton>
                        <MindMapDropdown
                          label="关系筛选"
                          value={relationTypeFilter}
                          options={relationFilterOptions}
                          onSelect={setRelationTypeFilter}
                        />
                        <MindMapDropdown
                          label="标签"
                          value={labelMode}
                          options={labelModes.map((item) => ({
                            ...item,
                            label: `标签：${item.label}`,
                          }))}
                          onSelect={setLabelMode}
                        />
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
                  <MindMapDropdown
                    label="历史导图"
                    value={!isGraphMap ? activeMap?.id || "" : ""}
                    options={[
                      { value: "", label: "历史导图", disabled: true },
                      ...savedMaps.map((map) => ({
                        value: map.id,
                        label: map.title,
                      })),
                    ]}
                    onSelect={(value) => {
                      const map = savedMaps.find(
                        (item) => item.id === Number(value)
                      );
                      if (!map) return;
                      setActiveMap(map);
                      setLayout(map.schema?.layout || map.layout || "tree");
                      setTheme(map.schema?.theme || map.theme || "napkin");
                      setCollapsed(new Set());
                    }}
                    menuWidth={280}
                  />
                  {documents.length > 0 && (
                    <DocumentGenerateMenu
                      documents={documents}
                      show={showDocumentMenu}
                      setShow={setShowDocumentMenu}
                      generate={generate}
                    />
                  )}
                </>
              )}
              <MindMapDropdown
                label="布局"
                value={layout}
                options={layouts.map((item) => ({
                  value: item,
                  label: layoutLabels[item] || item,
                }))}
                onSelect={setLayout}
              />
              <MindMapDropdown
                label="主题"
                value={theme}
                options={themes.map((item) => ({
                  value: item,
                  label: themeLabels[item] || item,
                }))}
                onSelect={setTheme}
              />
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

          <div className="relative min-h-0 flex-1" ref={flowRef}>
            {loading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 text-slate-700 text-sm">
                {mode === "graph"
                  ? "正在加载知识图谱..."
                  : "正在生成思维导图..."}
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
                sendCommand={sendCommand}
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
    </div>
  );
}

function DocumentGenerateMenu({ documents, show, setShow, generate }) {
  const menu = (
    <div className="max-h-[320px] overflow-y-auto overscroll-contain py-1">
      {documents.map((doc) => {
        const docId = doc.docId || doc.id;
        const docPath = doc.docpath || doc.filePath;
        const title = documentTitle(doc);
        const subtitle = documentSubtitle(doc, title);
        return (
          <AppDropdownButton.Item
            key={docId || docPath || title}
            disabled={!docId && !docPath}
            onClick={() => {
              if (!docId && !docPath) return;
              setShow(false);
              generate({
                sourceType: "document",
                ...(docId ? { docId } : { docPath }),
              });
            }}
            className="min-h-0 !items-start !rounded-lg !px-3 !py-2.5"
          >
            <span className="block min-w-0">
              <span className="block whitespace-normal break-words text-xs font-medium leading-5 text-slate-800">
                {title}
              </span>
              {subtitle && (
                <span className="mt-0.5 block whitespace-normal break-words text-[11px] leading-4 text-slate-500">
                  {subtitle}
                </span>
              )}
            </span>
          </AppDropdownButton.Item>
        );
      })}
    </div>
  );

  return (
    <AppDropdownButton
      size="sm"
      open={show}
      onOpenChange={setShow}
      onClick={() => setShow((prev) => !prev)}
      menu={menu}
      menuWidth={280}
      portalMenu
      className="app-dropdown-button-compact"
    >
      从文档生成
    </AppDropdownButton>
  );
}

function MindMapDropdown({
  label,
  value,
  options,
  onSelect,
  menuWidth = 190,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((item) => String(item.value) === String(value));
  const menu = (
    <>
      {options.map((item) => (
        <AppDropdownButton.Item
          key={item.value}
          disabled={item.disabled}
          onClick={() => {
            setOpen(false);
            onSelect(item.value, item);
          }}
        >
          {item.label}
        </AppDropdownButton.Item>
      ))}
    </>
  );

  return (
    <AppDropdownButton
      size="sm"
      open={open}
      onOpenChange={setOpen}
      onClick={() => setOpen((previous) => !previous)}
      menu={menu}
      menuWidth={menuWidth}
      portalMenu
      disabled={disabled}
      className="app-dropdown-button-compact"
      aria-label={label}
    >
      {selected?.label || label}
    </AppDropdownButton>
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
    <AppToggleButton
      size="sm"
      selected={active}
      onClick={onClick}
      className="app-toggle-button-compact"
    >
      {label}
    </AppToggleButton>
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

function StatusPill({ label, value }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1">
      <span className="text-slate-400">{label}</span>
      <span className="ml-1 font-semibold text-slate-700">{value}</span>
    </div>
  );
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
  sendCommand,
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
            {!edge && (
              <NodeSupplementSection
                workspaceSlug={workspaceSlug}
                node={node}
                setMessage={setMessage}
                sendCommand={sendCommand}
              />
            )}
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

function MissingNodeKeyNotice({ node, reason }) {
  const nodeLabel = node?.label || node?.canonicalName || "当前节点";
  const reasonText =
    {
      ambiguous_node_identity:
        "当前名称匹配到多个图谱节点，需要先选择具体节点。",
      low_confidence_node_identity:
        "当前名称只能低置信匹配，系统不会自动绑定。",
      node_identity_not_found: "未在当前工作区图谱中找到可绑定的稳定节点。",
    }[reason] || "该节点暂时缺少可确认的稳定身份。";
  return (
    <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-900">
      <div className="font-semibold">该节点暂不能添加节点补充</div>
      <div className="mt-1 leading-5 text-amber-800">
        「{nodeLabel}」还没有被唯一解析为当前工作区内的稳定图谱节点。
        {reasonText}
        请从图谱中的具体节点打开详情，或先重建/修复图谱身份后再添加节点补充。
      </div>
    </div>
  );
}

function identitySourceLabel(source = "") {
  return (
    {
      nodeId: "节点 ID",
      nodeKey: "nodeKey",
      canonicalKey: "规范键",
      alias: "别名",
      label_exact: "名称精确匹配",
      label_fuzzy: "名称高置信匹配",
    }[source] || "自动解析"
  );
}

function buildNodeSupplementPrompt(nodeLabel = "当前节点") {
  const label = String(nodeLabel || "当前节点").trim() || "当前节点";
  return `请根据书中的资料，围绕「${label}」这个知识节点做一份补充说明。请优先使用当前工作区已上传文档和原书材料，不要脱离来源。请用 Markdown 输出：
- 这个节点在书中的基本含义
- 它与主线问题或相邻概念的关系
- 容易误解或需要区分的地方
- 可以作为节点补充保存的简明摘要

如果资料不足，请明确标注“待确认”。`;
}

function findGraphNode(schema, target = {}) {
  const nodes = Array.isArray(schema?.nodes) ? schema.nodes : [];
  if (!nodes.length) return null;
  const nodeKey = String(target.nodeKey || "").trim();
  const nodeId = String(target.nodeId || "").trim();
  const concept = String(
    target.concept || target.displayName || target.label || ""
  )
    .trim()
    .toLowerCase();

  return (
    nodes.find((node) => nodeKey && node.nodeKey === nodeKey) ||
    nodes.find(
      (node) =>
        nodeId &&
        [node.sourceNodeId, node.nodeId, node.id].some(
          (value) => String(value || "") === nodeId
        )
    ) ||
    nodes.find((node) => {
      const label = String(node.label || node.canonicalName || "")
        .trim()
        .toLowerCase();
      return concept && label === concept;
    }) ||
    null
  );
}

function NodeSupplementSection({
  workspaceSlug,
  node,
  setMessage,
  sendCommand,
}) {
  const inputRef = useRef(null);
  const visualInputRef = useRef(null);
  const [resolvedIdentity, setResolvedIdentity] = useState(
    node?.nodeKey
      ? {
          node: {
            nodeId: node?.sourceNodeId || node?.nodeId || node?.id || null,
            nodeKey: node.nodeKey,
            canonicalKey: node?.canonicalKey || null,
            nodeLabel: node?.label || node?.canonicalName || "当前节点",
            nodeType: node?.entityType || node?.type || "concept",
            identitySource: "nodeKey",
          },
        }
      : null
  );
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityCandidates, setIdentityCandidates] = useState([]);
  const [identityReason, setIdentityReason] = useState("");
  const [supplements, setSupplements] = useState([]);
  const [graphContext, setGraphContext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [visualSaving, setVisualSaving] = useState(false);
  const [nodeBackground, setNodeBackground] = useState(null);
  const [textOpen, setTextOpen] = useState(false);
  const [textDraft, setTextDraft] = useState({ title: "", text: "" });
  const [savingText, setSavingText] = useState(false);
  const identityNode = resolvedIdentity?.node || null;
  const effectiveNode = identityNode
    ? {
        ...node,
        sourceNodeId: identityNode.nodeId,
        nodeKey: identityNode.nodeKey,
        canonicalKey: identityNode.canonicalKey,
        label: identityNode.nodeLabel,
        entityType: identityNode.nodeType,
      }
    : node;
  const nodeKey = effectiveNode?.nodeKey;
  const nodeLabel =
    effectiveNode?.label || effectiveNode?.canonicalName || "当前节点";
  const nodeType =
    effectiveNode?.entityType || effectiveNode?.type || "concept";
  const nodeContext = useMemo(
    () => ({
      nodeKey,
      nodeId: effectiveNode?.sourceNodeId || effectiveNode?.id || null,
      nodeLabel,
      nodeType,
    }),
    [
      effectiveNode?.id,
      effectiveNode?.sourceNodeId,
      nodeKey,
      nodeLabel,
      nodeType,
    ]
  );

  useEffect(() => {
    setResolvedIdentity(
      node?.nodeKey
        ? {
            node: {
              nodeId: node?.sourceNodeId || node?.nodeId || node?.id || null,
              nodeKey: node.nodeKey,
              canonicalKey: node?.canonicalKey || null,
              nodeLabel: node?.label || node?.canonicalName || "当前节点",
              nodeType: node?.entityType || node?.type || "concept",
              identitySource: "nodeKey",
            },
          }
        : null
    );
    setIdentityCandidates([]);
    setIdentityReason("");
  }, [
    node?.nodeKey,
    node?.sourceNodeId,
    node?.nodeId,
    node?.id,
    node?.canonicalKey,
    node?.label,
    node?.canonicalName,
    node?.entityType,
    node?.type,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function resolveIdentity() {
      if (!workspaceSlug || node?.nodeKey) return;
      const label = node?.label || node?.canonicalName || "";
      if (!node?.sourceNodeId && !node?.nodeId && !node?.canonicalKey && !label)
        return;
      setIdentityLoading(true);
      const result = await MindMap.resolveNode(workspaceSlug, {
        nodeId: node?.sourceNodeId || node?.nodeId || null,
        canonicalKey: node?.canonicalKey || null,
        label,
      });
      if (cancelled) return;
      setIdentityLoading(false);
      if (result?.success && result.node) {
        setResolvedIdentity({ node: result.node });
        setIdentityCandidates([]);
        setIdentityReason("");
        return;
      }
      setIdentityCandidates(result?.candidates || []);
      setIdentityReason(
        result?.reason || result?.error || "node_identity_not_found"
      );
    }
    resolveIdentity();
    return () => {
      cancelled = true;
    };
  }, [
    workspaceSlug,
    node?.nodeKey,
    node?.sourceNodeId,
    node?.nodeId,
    node?.canonicalKey,
    node?.label,
    node?.canonicalName,
  ]);

  const loadSupplements = useCallback(async () => {
    if (!workspaceSlug || !nodeKey) return;
    setLoading(true);
    const result = await NodeSupplement.list(workspaceSlug, nodeKey);
    setSupplements(result?.supplements || []);
    if (result?.error) showToast(result.error, "error");
    setLoading(false);
  }, [workspaceSlug, nodeKey]);

  useEffect(() => {
    loadSupplements();
  }, [loadSupplements]);

  useEffect(() => {
    let cancelled = false;
    async function loadNodeBackground() {
      setNodeBackground(null);
      if (!workspaceSlug || !nodeKey) return;
      const result = await WorkspaceOverviewModel.listVisualAssets(
        workspaceSlug,
        {
          scopeType: "node",
          nodeKey,
        }
      );
      if (!cancelled && result?.success) {
        setNodeBackground(result.assets?.[0] || null);
      }
    }
    loadNodeBackground();
    return () => {
      cancelled = true;
    };
  }, [workspaceSlug, nodeKey]);

  useEffect(() => {
    let cancelled = false;
    async function loadGraphContext() {
      if (!workspaceSlug || !nodeKey) return;
      const result = await MindMap.graphContext(workspaceSlug, {
        nodeKey,
        nodeId: effectiveNode?.sourceNodeId || null,
        intent: "detail",
        recordView: true,
        budget: {
          supplementChunks: 2,
          originalChunks: 3,
          paths: 2,
          neighbors: 5,
          vectorChunks: 0,
          contextChars: 5000,
        },
      });
      if (!cancelled && !result?.error) setGraphContext(result);
    }
    loadGraphContext();
    return () => {
      cancelled = true;
    };
  }, [workspaceSlug, nodeKey, effectiveNode?.sourceNodeId]);

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !workspaceSlug || !nodeKey) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file, file.name);
      formData.append("nodeKey", nodeKey);
      formData.append("nodeId", effectiveNode?.sourceNodeId || "");
      formData.append("canonicalKey", effectiveNode?.canonicalKey || "");
      formData.append("nodeLabel", nodeLabel);
      formData.append("nodeType", nodeType);
      const result = await NodeSupplement.upload(workspaceSlug, formData);
      if (!result?.success) {
        throw new Error(result?.error || "补充文档上传失败。");
      }
      setSupplements((prev) => {
        const rest = prev.filter((item) => item.id !== result.supplement.id);
        return [result.supplement, ...rest];
      });
      showToast(`已为「${nodeLabel}」添加补充文档。`, "success");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setUploading(false);
    }
  };

  const uploadNodeBackground = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !workspaceSlug || !nodeKey) return;
    setVisualSaving(true);
    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("scopeType", "node");
    formData.append("role", "hero_background");
    formData.append("nodeKey", nodeKey);
    formData.append("nodeLabel", nodeLabel);
    formData.append("nodeType", nodeType);
    const result = await WorkspaceOverviewModel.uploadVisualAsset(
      workspaceSlug,
      formData
    );
    setVisualSaving(false);
    if (!result?.success) {
      showToast(result?.error || "节点背景图上传失败。", "error");
      return;
    }
    setNodeBackground(result.asset);
    showToast(`已更新「${nodeLabel}」背景图。`, "success");
  };

  const removeNodeBackground = async () => {
    if (!nodeBackground?.id || !workspaceSlug) return;
    setVisualSaving(true);
    const result = await WorkspaceOverviewModel.deleteVisualAsset(
      workspaceSlug,
      nodeBackground.id
    );
    setVisualSaving(false);
    if (!result?.success) {
      showToast(result?.error || "移除节点背景图失败。", "error");
      return;
    }
    setNodeBackground(null);
    showToast("已移除节点背景图。", "success");
  };

  const saveTextSupplement = async () => {
    if (!textDraft.text.trim()) {
      showToast("请先输入节点补充文本。", "error");
      return;
    }
    setSavingText(true);
    const result = await NodeSupplement.createText(workspaceSlug, {
      nodeKey,
      nodeId: effectiveNode?.sourceNodeId || null,
      canonicalKey: effectiveNode?.canonicalKey || null,
      nodeLabel,
      nodeType,
      title: textDraft.title || `节点补充 - ${nodeLabel}`,
      text: textDraft.text,
    });
    setSavingText(false);
    if (!result?.success) {
      showToast(result?.error || "节点补充文本保存失败。", "error");
      return;
    }
    setSupplements((prev) => {
      const rest = prev.filter((item) => item.id !== result.supplement.id);
      return [result.supplement, ...rest];
    });
    setTextDraft({ title: "", text: "" });
    setTextOpen(false);
    showToast(`已为「${nodeLabel}」添加文本补充。`, "success");
  };

  const removeSupplement = async (supplement) => {
    const result = await NodeSupplement.delete(workspaceSlug, supplement.id);
    if (!result?.success) {
      showToast(result?.error || "解除绑定失败。", "error");
      return;
    }
    setSupplements((prev) => prev.filter((item) => item.id !== supplement.id));
    showToast("已解除节点补充绑定，原文档仍保留在知识库。", "success");
  };

  const copyNodeSupplementPrompt = async () => {
    if (!nodeKey) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard_unavailable");
      }
      await navigator.clipboard.writeText(buildNodeSupplementPrompt(nodeLabel));
      showToast("已复制节点 Prompt", "success");
    } catch {
      showToast("复制节点 Prompt 失败，请稍后重试。", "error");
    }
  };

  const explainWithSupplement = () => {
    const prompt = `请围绕知识节点「${nodeLabel}」做一段讲解。优先使用该节点绑定的补充文档，再结合原书主线和已有证据，不要脱离来源。`;
    if (sendCommand) {
      sendCommand({ text: prompt, autoSubmit: true, nodeContext });
      return;
    }
    setMessage?.(prompt);
  };

  return (
    <div className="mb-3 rounded-2xl border border-blue-100 bg-blue-50/45 p-3 text-xs text-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-slate-900">
            <FileText size={14} className="text-blue-500" />
            节点补充
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            为「{nodeLabel}」上传补充文档，上传后会正常入库并绑定到该节点。
          </div>
          {nodeKey ? (
            <>
              <div className="mt-1 text-[11px] font-medium text-blue-700">
                {node?.nodeKey ? "稳定身份" : "已自动解析"} ·{" "}
                {identitySourceLabel(identityNode?.identitySource || "nodeKey")}
              </div>
              <div className="mt-1 max-w-full truncate rounded-md bg-white/70 px-2 py-1 font-mono text-[10px] text-slate-500">
                nodeKey: {nodeKey}
              </div>
            </>
          ) : identityLoading ? (
            <div className="mt-1 text-[11px] text-slate-500">
              正在解析节点身份...
            </div>
          ) : identityCandidates.length > 0 ? (
            <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/80 p-2 text-[11px] text-amber-900">
              <div className="font-semibold">需要选择具体图谱节点</div>
              <div className="mt-1 text-amber-800">
                当前名称匹配到多个候选，选择一个后才能添加节点补充。
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {identityCandidates.slice(0, 6).map((candidate) => (
                  <button
                    key={candidate.nodeKey}
                    type="button"
                    onClick={() => {
                      setResolvedIdentity({ node: candidate });
                      setIdentityCandidates([]);
                      setIdentityReason("");
                    }}
                    className="rounded-lg border border-amber-200 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                  >
                    {candidate.nodeLabel} ·{" "}
                    {identitySourceLabel(candidate.identitySource)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MissingNodeKeyNotice node={node} reason={identityReason} />
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading || !nodeKey}
            className="rounded-lg border border-blue-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? "上传中..." : "上传补充文档"}
          </button>
          <button
            type="button"
            onClick={() => visualInputRef.current?.click()}
            disabled={visualSaving || !nodeKey}
            className="rounded-lg border border-cyan-200 bg-cyan-50 px-2.5 py-1.5 text-[11px] font-semibold text-cyan-800 hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {visualSaving ? "处理中..." : "上传节点背景图"}
          </button>
          {nodeBackground?.id && (
            <button
              type="button"
              onClick={removeNodeBackground}
              disabled={visualSaving || !nodeKey}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              移除背景图
            </button>
          )}
          <button
            type="button"
            onClick={() => setTextOpen((value) => !value)}
            disabled={!nodeKey}
            className="rounded-lg border border-blue-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-50"
          >
            输入补充文本
          </button>
          <button
            type="button"
            onClick={copyNodeSupplementPrompt}
            disabled={!nodeKey}
            className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            复制节点 Prompt
          </button>
          <button
            type="button"
            onClick={explainWithSupplement}
            disabled={!nodeKey}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
          >
            基于补充讲解
          </button>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={handleUpload}
      />
      <input
        ref={visualInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={uploadNodeBackground}
      />
      {textOpen && (
        <div className="mt-3 space-y-2 rounded-xl border border-blue-100 bg-white/70 p-2">
          <input
            value={textDraft.title}
            onChange={(event) =>
              setTextDraft((prev) => ({ ...prev, title: event.target.value }))
            }
            placeholder="标题，例如：柏拉图理念论补充"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-[11px]"
          />
          <textarea
            value={textDraft.text}
            onChange={(event) =>
              setTextDraft((prev) => ({ ...prev, text: event.target.value }))
            }
            rows={5}
            placeholder="输入与该节点直接相关的补充说明、摘录、例子或解析。"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] leading-5"
          />
          <button
            type="button"
            disabled={savingText}
            onClick={saveTextSupplement}
            className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {savingText ? "保存中..." : "生成 Markdown 并绑定"}
          </button>
        </div>
      )}
      <div className="mt-3">
        {graphContext?.workspaceProfile && (
          <div className="mb-2 flex flex-wrap gap-1.5 text-[11px] text-slate-600">
            <span className="rounded-full bg-white/80 px-2 py-0.5">
              画像 {graphContext.workspaceProfile.profileType}
            </span>
            {graphContext.bookStructure?.structureType && (
              <span className="rounded-full bg-white/80 px-2 py-0.5">
                结构 {graphContext.bookStructure.structureType}
              </span>
            )}
            <span className="rounded-full bg-white/80 px-2 py-0.5">
              掌握度{" "}
              {Number(graphContext.learningState?.masteryScore || 0).toFixed(2)}
            </span>
          </div>
        )}
        {!!graphContext?.keyPaths?.length && (
          <div className="mb-2 rounded-lg bg-white/70 px-2 py-1.5 text-[11px] text-slate-600">
            关键路径：
            {graphContext.keyPaths
              .slice(0, 2)
              .map((path) => path.summary)
              .join(" / ")}
          </div>
        )}
        <div className="text-[11px] font-medium text-slate-600">
          {loading
            ? "正在加载补充文档..."
            : `已添加 ${supplements.length} 份补充文档`}
        </div>
        {supplements.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {supplements.map((supplement) => (
              <div
                key={supplement.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-white/80 bg-white/80 px-2 py-1.5"
              >
                <span className="min-w-0 truncate text-[11px] text-slate-700">
                  {supplement.documentName || supplement.documentId}
                </span>
                <button
                  type="button"
                  onClick={() => removeSupplement(supplement)}
                  className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                >
                  解除绑定
                </button>
              </div>
            ))}
          </div>
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
    <AppButton
      variant="secondary"
      size="sm"
      onClick={onClick}
      leftIcon={<Icon />}
    >
      {label}
    </AppButton>
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
