import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Brain,
  Compass,
  FileText,
  Graph,
  Heartbeat,
  Lightning,
  Path,
  Sparkle,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import WorkspaceOverviewModel from "@/models/workspaceOverview";

const OVERVIEW_CACHE_TTL_MS = 60_000;
const overviewCache = new Map();

function formatTime(value) {
  if (!value) return "暂无";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "暂无";
  }
}

function statusStyle(status) {
  switch (status) {
    case "healthy":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "warning":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "degraded":
      return "bg-orange-50 text-orange-700 border-orange-200";
    case "critical":
      return "bg-rose-50 text-rose-700 border-rose-200";
    default:
      return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

function scoreTone(score) {
  if (score === null || score === undefined) return "text-slate-500";
  if (score >= 90) return "text-emerald-600";
  if (score >= 70) return "text-amber-600";
  if (score >= 50) return "text-orange-600";
  return "text-rose-600";
}

export default function WorkspaceOverview({
  workspace,
  threadSlug = null,
  isVisible = true,
  onOpenGraph,
  onOpenPath,
  onOpenEvidence,
  onOpenDocument,
  onUploadDocument,
}) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(new Set());
  const [pageSessionId, setPageSessionId] = useState(null);
  const cacheKey = useMemo(
    () => `${workspace?.slug || "workspace"}:${threadSlug || "default"}`,
    [threadSlug, workspace?.slug]
  );
  const requestRef = useRef({ id: 0, controller: null });

  useEffect(() => {
    if (typeof crypto !== "undefined" && crypto.randomUUID)
      setPageSessionId(crypto.randomUUID());
    else
      setPageSessionId(
        `overview-${workspace?.slug || "workspace"}-${Date.now()}`
      );
  }, [workspace?.slug]);
  const reportedImpressionsRef = useRef(new Set());

  const loadOverview = useCallback(
    async ({ force = false } = {}) => {
      if (!workspace?.slug || (!isVisible && !force)) return;
      const cached = overviewCache.get(cacheKey);
      if (cached?.overview && !force) {
        setOverview(cached.overview);
        setLoading(false);
        if (Date.now() - cached.updatedAt < OVERVIEW_CACHE_TTL_MS) return;
      } else {
        setLoading(true);
      }

      requestRef.current.controller?.abort();
      const controller = new AbortController();
      const requestId = requestRef.current.id + 1;
      requestRef.current = { id: requestId, controller };

      const result = await WorkspaceOverviewModel.get(
        workspace.slug,
        {
          threadSlug,
        },
        {
          signal: controller.signal,
        }
      );
      if (controller.signal.aborted || requestRef.current.id !== requestId)
        return;
      if (!result?.error) {
        overviewCache.set(cacheKey, {
          overview: result,
          updatedAt: Date.now(),
        });
      }
      setOverview(result);
      setLoading(false);
    },
    [cacheKey, isVisible, threadSlug, workspace?.slug]
  );

  useEffect(() => {
    if (!isVisible) return;
    loadOverview();
    return () => requestRef.current.controller?.abort();
  }, [isVisible, loadOverview]);

  const recordUsage = useCallback(
    (recommendation, action) => {
      if (!workspace?.slug || !recommendation?.recommendationId) return;
      if (action === "impression" && !pageSessionId) return;
      if (
        action === "impression" &&
        reportedImpressionsRef.current.has(recommendation.recommendationId)
      )
        return;
      if (action === "impression")
        reportedImpressionsRef.current.add(recommendation.recommendationId);
      WorkspaceOverviewModel.recordUsage(workspace.slug, {
        recommendationId: recommendation.recommendationId,
        formulaVersion: recommendation.formulaVersion,
        type: recommendation.type,
        targetType: recommendation.target?.targetType,
        targetId: recommendation.target?.targetId,
        action,
        pageSessionId,
      });
    },
    [pageSessionId, workspace?.slug]
  );

  const activateRecommendation = useCallback(
    (recommendation, action = "click") => {
      recordUsage(recommendation, action);
      const target = recommendation.target || {};
      if (target.targetType === "path") {
        onOpenPath?.({
          source: target.sourceConcept,
          target: target.targetConcept,
          title: recommendation.title,
        });
        return;
      }
      if (target.targetType === "edge") {
        onOpenEvidence?.({
          targetType: "edge",
          targetId: target.edgeId || target.targetId,
          concept: target.sourceConcept || target.concept,
        });
        return;
      }
      if (target.targetType === "document") {
        onOpenDocument?.(target);
        return;
      }
      onOpenGraph?.(
        target.concept || target.displayName || recommendation.title
      );
    },
    [onOpenDocument, onOpenEvidence, onOpenGraph, onOpenPath, recordUsage]
  );

  const recommendations = useMemo(
    () =>
      (overview?.personalizedRecommendations || []).filter(
        (item) => !dismissed.has(item.recommendationId)
      ),
    [dismissed, overview?.personalizedRecommendations]
  );

  if (loading) {
    return (
      <div className="w-full max-w-6xl mx-auto px-4 md:px-8 py-10 text-slate-500">
        正在整理你的研究导航...
      </div>
    );
  }

  if (overview?.error) {
    return (
      <div className="w-full max-w-4xl mx-auto px-4 md:px-8 py-12">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 shadow-sm">
          <div className="flex items-center gap-3 text-amber-900 font-semibold text-lg">
            <WarningCircle size={22} className="text-amber-600" />
            动态首页暂时加载失败
          </div>
          <p className="mt-3 text-sm leading-6 text-amber-800">
            这不是因为知识库没有数据，而是首页聚合接口返回了异常。请刷新重试，或查看后端日志。
          </p>
          <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-amber-900">
            {overview.error}
          </p>
          <button
            type="button"
            onClick={() => loadOverview({ force: true })}
            className="mt-5 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-amber-800 hover:bg-amber-100"
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }

  if (overview?.emptyState?.show) {
    return (
      <div className="w-full max-w-4xl mx-auto px-4 md:px-8 py-12">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex items-center gap-3 text-slate-900 font-semibold text-lg">
            <Compass size={22} className="text-blue-500" />
            动态知识库首页还在等待数据
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            当前 workspace
            还没有足够的知识图谱、证据或使用记录。你可以先上传文档、运行
            Knowledge Graph backfill，或继续聊天来积累研究信号。
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onUploadDocument}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              上传文档
            </button>
            <button
              type="button"
              onClick={() => loadOverview({ force: true })}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              重新检查
            </button>
          </div>
        </div>
      </div>
    );
  }

  const focus =
    overview?.userCognitiveState?.currentFocusConcepts?.[0]?.displayName ||
    overview?.userCognitiveState?.activeTopics?.[0]?.displayName ||
    "等待新的研究焦点";
  const health = overview?.healthLite || {};

  return (
    <div className="w-full h-full overflow-y-auto bg-slate-50 light:bg-slate-50">
      <div className="w-full max-w-6xl mx-auto px-4 md:px-8 pt-7 md:pt-9 pb-72">
        <section className="rounded-2xl border border-white/70 bg-white/80 p-5 md:p-6 shadow-sm backdrop-blur-xl">
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold tracking-wide text-blue-600">
                个性化知识推荐首页
              </p>
              <h1 className="mt-2 text-2xl md:text-3xl font-semibold text-slate-950">
                {workspace?.name || "Workspace"}
              </h1>
              <p className="mt-3 text-sm md:text-base text-slate-600">
                当前研究焦点：
                <span className="font-semibold text-slate-900">{focus}</span>
              </p>
              <p className="mt-2 text-xs text-slate-500">
                最近活动：{formatTime(overview?.recentActivity?.[0]?.createdAt)}
              </p>
            </div>
            <div
              className={`rounded-xl border px-4 py-3 min-w-[180px] ${statusStyle(
                health.status
              )}`}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Heartbeat size={18} />
                工作区健康
              </div>
              <div
                className={`mt-2 text-3xl font-semibold ${scoreTone(health.score)}`}
              >
                {health.score ?? "未知"}
              </div>
              <p className="mt-1 text-xs">
                {health.summary || "健康状态暂不可用"}
              </p>
            </div>
          </div>
        </section>

        <div className="mt-5 grid grid-cols-1 xl:grid-cols-[1.35fr_0.65fr] gap-5">
          <main className="space-y-5">
            <OverviewSection
              icon={<Path size={18} />}
              title="继续上次研究"
              empty="暂无可恢复的研究路径。"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {(overview?.unfinishedExplorations || [])
                  .slice(0, 4)
                  .map((item) => (
                    <RecommendationCard
                      key={item.recommendationId}
                      recommendation={item}
                      isVisible={isVisible}
                      onImpression={recordUsage}
                      onActivate={(rec) =>
                        activateRecommendation(rec, "continue")
                      }
                      actionLabel="继续"
                    />
                  ))}
              </div>
            </OverviewSection>

            <OverviewSection
              icon={<Sparkle size={18} />}
              title="为你推荐"
              empty="暂无推荐。继续查看概念或证据后，这里会变得更聪明。"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {recommendations.slice(0, 8).map((item) => (
                  <RecommendationCard
                    key={item.recommendationId}
                    recommendation={item}
                    isVisible={isVisible}
                    onImpression={recordUsage}
                    onActivate={activateRecommendation}
                    onDismiss={(rec) => {
                      recordUsage(rec, "dismiss");
                      setDismissed(
                        (prev) => new Set([...prev, rec.recommendationId])
                      );
                    }}
                  />
                ))}
              </div>
            </OverviewSection>

            <OverviewSection
              icon={<WarningCircle size={18} />}
              title="知识缺口"
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {(overview?.curiosityRecommendations || [])
                  .slice(0, 6)
                  .map((item) => (
                    <SmallInsight
                      key={item.recommendationId}
                      item={item}
                      onClick={() => activateRecommendation(item)}
                    />
                  ))}
              </div>
            </OverviewSection>
          </main>

          <aside className="space-y-5">
            <StatsPanel overview={overview} />
            <ActivityPanel activities={overview?.recentActivity || []} />
            <DebugPanel debug={overview?.recommendationDebug} />
          </aside>
        </div>
      </div>
    </div>
  );
}

function OverviewSection({ icon, title, empty, children }) {
  const hasContent = Boolean(children?.props?.children?.length ?? children);
  return (
    <section className="rounded-2xl border border-white/70 bg-white/80 p-4 shadow-sm backdrop-blur-xl">
      <div className="mb-3 flex items-center gap-2 text-slate-900 font-semibold">
        <span className="text-blue-500">{icon}</span>
        {title}
      </div>
      {hasContent ? (
        children
      ) : (
        <p className="text-sm text-slate-500">{empty}</p>
      )}
    </section>
  );
}

function RecommendationCard({
  recommendation,
  isVisible = true,
  onImpression,
  onActivate,
  onDismiss,
  actionLabel = "打开",
}) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && isVisible)
          onImpression?.(recommendation, "impression");
      },
      { threshold: 0.5 }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [isVisible, onImpression, recommendation]);

  return (
    <article
      ref={ref}
      className="group relative rounded-xl border border-slate-200/80 bg-white/65 p-4 shadow-sm backdrop-blur hover:border-blue-200 hover:bg-blue-50/55 transition-colors"
    >
      {onDismiss && (
        <button
          type="button"
          onClick={() => onDismiss(recommendation)}
          className="absolute right-2 top-2 rounded-md p-1 text-slate-400 hover:bg-white hover:text-slate-700"
          aria-label="隐藏该推荐"
        >
          <X size={14} />
        </button>
      )}
      <div className="flex items-center gap-2 text-xs text-blue-600">
        <Brain size={15} />
        推荐分 {recommendation.score}
      </div>
      <h3 className="mt-2 pr-6 text-sm font-semibold leading-5 text-slate-950">
        {recommendation.title}
      </h3>
      <ul className="mt-3 space-y-1.5">
        {(recommendation.reasonZh || []).slice(0, 3).map((reason, index) => (
          <li key={index} className="text-xs leading-5 text-slate-600">
            {reason}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onActivate?.(recommendation)}
        className="mt-4 inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 shadow-sm hover:border-blue-300 hover:bg-blue-100"
      >
        {actionLabel}
        <ArrowRight size={13} />
      </button>
    </article>
  );
}

function SmallInsight({ item, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-xl border border-slate-200 bg-slate-50 p-3 hover:border-blue-200 hover:bg-blue-50/50"
    >
      <div className="text-xs text-slate-500">可信度 {item.confidence}</div>
      <div className="mt-1 text-sm font-semibold text-slate-900">
        {item.title}
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-600">
        {item.reasonZh?.[0] || "来自真实图谱信号。"}
      </p>
    </button>
  );
}

function StatsPanel({ overview }) {
  const summary = overview?.todaySummary || {};
  return (
    <section className="rounded-2xl border border-white/70 bg-white/80 p-4 shadow-sm backdrop-blur-xl">
      <div className="flex items-center gap-2 text-slate-900 font-semibold">
        <Lightning size={18} className="text-blue-500" />
        今日知识变化
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Metric label="证据" value={summary.evidenceAddedToday || 0} />
        <Metric label="关系" value={summary.relationsAddedToday || 0} />
        <Metric label="文档" value={summary.documentsUpdatedToday || 0} />
      </div>
      <div className="mt-4 space-y-2">
        {(summary.recentDocuments || []).slice(0, 4).map((doc) => (
          <div
            key={doc.docId}
            className="flex items-start gap-2 text-xs text-slate-600"
          >
            <FileText size={14} className="mt-0.5 text-slate-400" />
            <span className="line-clamp-2">{doc.filename || doc.docpath}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3 text-center">
      <div className="text-lg font-semibold text-slate-900">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function ActivityPanel({ activities }) {
  return (
    <section className="rounded-2xl border border-white/70 bg-white/80 p-4 shadow-sm backdrop-blur-xl">
      <div className="flex items-center gap-2 text-slate-900 font-semibold">
        <Graph size={18} className="text-blue-500" />
        最近变化
      </div>
      <div className="mt-4 space-y-3">
        {activities.slice(0, 6).map((activity, index) => (
          <div
            key={`${activity.type}-${index}`}
            className="border-l-2 border-blue-200 pl-3"
          >
            <div className="text-sm font-medium text-slate-900">
              {activity.title}
            </div>
            <div className="text-xs leading-5 text-slate-500">
              {activity.detail}
            </div>
            <div className="text-[11px] text-slate-400">
              {formatTime(activity.createdAt)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DebugPanel({ debug }) {
  if (!debug || import.meta.env.PROD) return null;
  return (
    <details className="rounded-2xl border border-white/70 bg-white/80 p-4 shadow-sm backdrop-blur-xl">
      <summary className="cursor-pointer text-sm font-semibold text-slate-900">
        推荐调试信息
      </summary>
      <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
        {JSON.stringify(debug, null, 2)}
      </pre>
    </details>
  );
}
