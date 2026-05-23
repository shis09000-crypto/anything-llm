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
import MindMapNode from "./MindMapNode";
import { layoutMindMap } from "./layout";

const nodeTypes = { mindMapNode: MindMapNode };
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

  const documents = workspace?.documents || [];
  const isGraphMap = activeMap?.sourceType === "graph";
  const activeSchema = useMemo(() => {
    if (!activeMap?.schema) return null;
    const schema = {
      ...activeMap.schema,
      layout,
      theme,
    };
    if (!isGraphMap || !hideWeakRelations) return schema;
    return filterWeakGraphSchema(schema);
  }, [activeMap, layout, theme, isGraphMap, hideWeakRelations]);

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
      setGraphEmptyReason(null);
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
    },
    [graphConcept, graphStatus, layout, workspace?.slug]
  );

  useEffect(() => {
    if (!request?.id || request.id === lastRequestId.current) return;
    lastRequestId.current = request.id;
    generate(request.body);
  }, [request, generate]);

  useEffect(() => {
    let cancelled = false;
    async function computeLayout() {
      if (!activeSchema) {
        setNodes([]);
        setEdges([]);
        return;
      }
      const result = await layoutMindMap(activeSchema, collapsed);
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

  const onNodeClick = useCallback((_, node) => {
    setSelectedNode(node.data);
    setSelectedEdge(null);
  }, []);

  const onNodeMouseEnter = useCallback((_, node) => {
    setHoveredNode(node.data);
  }, []);

  const onNodeMouseLeave = useCallback(() => {
    setHoveredNode(null);
  }, []);

  const onEdgeClick = useCallback((_, edge) => {
    setSelectedEdge(edge.data || edge);
    setSelectedNode(null);
  }, []);

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
      className={`h-full overflow-hidden transition-all duration-500 flex-shrink-0 w-full md:w-[720px] md:min-w-[680px] xl:w-[860px] 2xl:w-[980px] bg-zinc-950/80 md:bg-transparent ${
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
              <GraphStatusBar status={graphStatus} />
              <RepairStatusBar
                repair={repairStatus}
                onRepair={runGraphRepair}
                onReleaseQuarantine={releaseQuarantine}
              />
              {graphStatus?.isSparse && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  当前知识图谱数据较少，结果可能不完整。建议先运行 Knowledge
                  Graph backfill。
                </div>
              )}
              {graphStatus?.missingVectorCacheDocuments > 0 && (
                <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                  有 {graphStatus.missingVectorCacheDocuments} 个旧文档缺少
                  vector-cache 文本，已从可构建范围中单独标记；不会重新生成
                  embedding。
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[240px] flex-1">
                  <MagnifyingGlass
                    size={14}
                    className="absolute left-2 top-2.5 text-slate-400"
                  />
                  <input
                    value={graphConcept}
                    onChange={(event) => setGraphConcept(event.target.value)}
                    onFocus={() =>
                      setShowGraphSuggestions(graphSuggestions.length > 0)
                    }
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
                              {formatAliases(concept.aliases)
                                .slice(0, 3)
                                .join(" / ")}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <ToolbarButton
                  label="Expand Related Concepts"
                  onClick={() => loadGraph()}
                  Icon={GitFork}
                />
                <button
                  type="button"
                  onClick={() => setHideWeakRelations((prev) => !prev)}
                  className={`rounded-lg border px-2 py-1 text-xs ${
                    hideWeakRelations
                      ? "border-blue-200 bg-blue-50 text-blue-700"
                      : "border-slate-200 bg-white text-slate-700"
                  }`}
                >
                  Hide Weak Relations
                </button>
                <ToolbarButton
                  label="Focus Node"
                  onClick={focusSelectedNode}
                  Icon={ArrowsOut}
                />
              </div>
            </div>
          )}

          <div className="mt-3 pb-3 flex flex-wrap gap-2 items-center">
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

        {(selectedNode || selectedEdge) && (
          <SelectionPanel
            node={selectedNode}
            edge={selectedEdge}
            explainSelected={explainSelected}
            setMessage={setMessage}
          />
        )}
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
      <StatusPill label="Nodes" value={status.nodes || 0} />
      <StatusPill label="Edges" value={status.edges || 0} />
      <StatusPill label="Evidence" value={status.evidence || 0} />
      <StatusPill
        label="Processed"
        value={`${status.graphProcessedDocuments ?? status.processedDocuments ?? 0}/${status.eligibleVectorDocuments ?? status.vectorDocuments ?? 0}`}
      />
      <StatusPill
        label="Missing cache"
        value={status.missingVectorCacheDocuments || 0}
      />
      <StatusPill label="Status" value={statusLabel} />
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
          Aliases: {formatAliases(node.aliases).slice(0, 4).join(" / ")}
        </div>
      )}
      <div className="mt-2 grid grid-cols-2 gap-1">
        <span>Evidence: {node.evidenceCount || 0}</span>
        <span>Importance: {formatScore(node.importanceScore)}</span>
        <span>Workspace: {formatScore(node.workspaceImportanceScore)}</span>
        <span>Recent: {formatScore(node.recentImportanceScore)}</span>
      </div>
      {!!node.topChunks?.length && (
        <div className="mt-2">
          <div className="font-medium text-slate-700">Top chunks</div>
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

function SelectionPanel({ node, edge, explainSelected, setMessage }) {
  if (edge) {
    return (
      <div className="border-t border-slate-200 bg-white p-3">
        <div className="text-sm font-semibold text-slate-900">
          {edge.label || edge.relationType || "Relation"}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {edge.relationLabelZh ? `${edge.relationLabelZh} · ` : ""}
          Confidence {formatScore(edge.confidence)} · Evidence{" "}
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

function filterWeakGraphSchema(schema = {}) {
  const strongEdges = (schema.edges || []).filter(
    (edge) => edge.type === "parent" || Number(edge.confidence ?? 1) >= 0.55
  );
  return { ...schema, edges: strongEdges };
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
