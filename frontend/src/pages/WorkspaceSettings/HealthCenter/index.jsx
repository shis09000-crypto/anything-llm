import React, { useState } from "react";
import {
  ArrowClockwise,
  Activity,
  CaretDown,
  CheckCircle,
  Pulse,
  WarningCircle,
} from "@phosphor-icons/react";
import { useWorkspaceHealth } from "@/contexts/WorkspaceHealthProvider";

function formatTime(value) {
  if (!value) return "暂无";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "暂无";
  }
}

function statusMeta(beacon) {
  if (!beacon || beacon.unknown) {
    return {
      label: "未知",
      eyebrow: "状态暂不可用",
      accent: "from-slate-400 to-slate-500",
      badge:
        "bg-slate-500/10 text-slate-200 light:bg-slate-100 light:text-slate-700",
      ring: "border-slate-400/20",
      icon: <WarningCircle size={18} weight="fill" />,
    };
  }
  if (beacon.processing) {
    return {
      label: "处理中",
      eyebrow: "后台任务运行中",
      accent: "from-sky-400 to-blue-500",
      badge: "bg-sky-500/10 text-sky-100 light:bg-sky-50 light:text-sky-700",
      ring: "border-sky-400/30",
      icon: <Pulse size={18} weight="fill" />,
    };
  }
  if (beacon.score >= 90) {
    return {
      label: "健康",
      eyebrow: "运行状态良好",
      accent: "from-emerald-400 to-teal-500",
      badge:
        "bg-emerald-500/10 text-emerald-100 light:bg-emerald-50 light:text-emerald-700",
      ring: "border-emerald-400/30",
      icon: <CheckCircle size={18} weight="fill" />,
    };
  }
  if (beacon.score >= 70) {
    return {
      label: "需关注",
      eyebrow: "存在轻微风险",
      accent: "from-yellow-300 to-amber-500",
      badge:
        "bg-yellow-500/10 text-yellow-100 light:bg-yellow-50 light:text-yellow-700",
      ring: "border-yellow-400/30",
      icon: <WarningCircle size={18} weight="fill" />,
    };
  }
  if (beacon.score >= 50) {
    return {
      label: "降级",
      eyebrow: "需要排查",
      accent: "from-orange-400 to-amber-600",
      badge:
        "bg-orange-500/10 text-orange-100 light:bg-orange-50 light:text-orange-700",
      ring: "border-orange-400/30",
      icon: <WarningCircle size={18} weight="fill" />,
    };
  }
  return {
    label: "严重",
    eyebrow: "需要立即处理",
    accent: "from-red-400 to-rose-600",
    badge: "bg-red-500/10 text-red-100 light:bg-red-50 light:text-red-700",
    ring: "border-red-400/30",
    icon: <WarningCircle size={18} weight="fill" />,
  };
}

function localizeActivityTitle(title = "") {
  return String(title)
    .replace(/node metrics/g, "节点指标")
    .replace(/KG extraction/g, "知识图谱提取")
    .replace(/graph repair/g, "图谱修复")
    .replace(/重新计算 节点指标/g, "重新计算节点指标");
}

function localizeActivityDetail(detail = "") {
  return String(detail)
    .replace(/processed/gi, "处理")
    .replace(/succeeded/gi, "成功")
    .replace(/failed/gi, "失败")
    .replace(/skipped/gi, "跳过");
}

function severityLabel(severity = "warning") {
  if (severity === "critical") return "严重";
  if (severity === "warning") return "警告";
  return "信息";
}

export default function HealthCenter() {
  const health = useWorkspaceHealth();
  const beacon = health?.beacon;
  const [expandedIssue, setExpandedIssue] = useState(null);
  const cooldownSeconds = Math.ceil((health?.cooldownRemainingMs || 0) / 1000);
  const meta = statusMeta(beacon);
  const score = beacon?.unknown ? "--" : (beacon?.score ?? "--");
  const scoreBreakdown = beacon?.scoreBreakdown || [];
  const expiredTraversalCache =
    beacon?.advanced?.cache?.staleGraphTraversalEntries || 0;

  return (
    <div className="max-w-6xl">
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-sky-400">
            工作区可观察性
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-white light:text-slate-900">
            工作区健康中心
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60 light:text-slate-500">
            这里展示知识图谱、修复任务、节点指标、后台
            Worker、队列、模型服务与缓存的轻量可观察状态。刷新只更新健康聚合缓存，不会触发嵌入、向量重建、知识图谱提取或修复任务。
          </p>
        </div>
        <button
          type="button"
          disabled={cooldownSeconds > 0 || health?.loading}
          onClick={() => health?.refreshBeacon?.()}
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 light:border-slate-200 px-4 py-2 text-sm font-semibold text-white/80 light:text-slate-700 hover:bg-white/5 light:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowClockwise size={16} />
          {cooldownSeconds > 0
            ? `${cooldownSeconds}s 后可刷新`
            : "刷新健康状态"}
        </button>
      </div>

      <div
        className={`overflow-hidden rounded-2xl border ${meta.ring} bg-white/[0.04] light:bg-white shadow-[0_18px_60px_rgba(15,23,42,0.10)]`}
      >
        <div className={`h-1.5 bg-gradient-to-r ${meta.accent}`} />
        <div className="p-6">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-sm font-semibold text-white/60 light:text-slate-500">
                工作区健康分数
              </div>
              <div className="mt-2 flex items-end gap-3">
                <span className="text-6xl font-bold tracking-tight text-white light:text-slate-950">
                  {score}
                </span>
                <span
                  className={`mb-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${meta.badge}`}
                >
                  {meta.icon}
                  {meta.label}
                </span>
              </div>
              <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-white/45 light:text-slate-400">
                {meta.eyebrow}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 light:border-slate-100 bg-black/10 light:bg-slate-50/80 px-4 py-3 text-sm leading-6 text-white/65 light:text-slate-600">
              <div>最后更新时间：{formatTime(beacon?.lastUpdatedAt)}</div>
              <div>
                摘要缓存：
                {formatTime(beacon?.sourceTimes?.summaryCacheUpdatedAt)}
              </div>
              <div>
                最新活动：{formatTime(beacon?.sourceTimes?.latestActivityAt)}
              </div>
              <div>
                Worker 心跳：
                {formatTime(beacon?.sourceTimes?.latestWorkerHeartbeatAt)}
              </div>
            </div>
          </div>
          <p className="mt-5 max-w-3xl text-sm leading-6 text-white/68 light:text-slate-600">
            {beacon?.summary || "健康状态暂时不可用"}
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.04] light:bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold text-white light:text-slate-800">
            <WarningCircle size={18} />
            当前问题
          </div>
          <div className="mt-4 space-y-3">
            {(beacon?.topIssues || []).map((item, index) => {
              const key = `${item.title}-${item.detail}-${index}`;
              const isOpen = expandedIssue === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    setExpandedIssue((current) =>
                      current === key ? null : key
                    )
                  }
                  className="w-full rounded-xl border border-yellow-400/20 bg-yellow-500/[0.06] light:bg-yellow-50/70 px-3 py-3 text-left transition-all hover:border-yellow-300/45 hover:shadow-[0_0_20px_rgba(250,204,21,0.12)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-white/85 light:text-slate-800">
                        {item.title}
                      </div>
                      <div className="mt-1 text-xs text-white/55 light:text-slate-500">
                        {item.detail}
                      </div>
                    </div>
                    <CaretDown
                      size={16}
                      className={`mt-0.5 shrink-0 text-white/45 light:text-slate-400 transition-transform ${
                        isOpen ? "rotate-180" : ""
                      }`}
                    />
                  </div>
                  {isOpen && (
                    <div className="mt-3 rounded-lg border border-white/10 light:border-yellow-100 bg-black/15 light:bg-white/70 p-3 text-xs leading-5 text-white/62 light:text-slate-600">
                      <div className="font-semibold text-white/80 light:text-slate-700">
                        具体扣分来源
                      </div>
                      {scoreBreakdown.length > 0 ? (
                        <div className="mt-2 space-y-2">
                          {scoreBreakdown.map((entry) => (
                            <div
                              key={entry.key}
                              className="rounded-lg border border-white/10 light:border-slate-100 bg-black/10 light:bg-white/80 p-2"
                            >
                              <div className="flex items-center justify-between gap-2 font-semibold text-white/80 light:text-slate-700">
                                <span>{entry.title}</span>
                                <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-yellow-100 light:text-yellow-700">
                                  -{entry.points} 分
                                </span>
                              </div>
                              <div className="mt-1 text-white/55 light:text-slate-500">
                                {entry.detail}
                              </div>
                              <div className="mt-1 text-white/45 light:text-slate-400">
                                严重程度：{severityLabel(entry.severity)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-1">
                          当前没有实际扣分项。该问题可能已在最新健康聚合中恢复。
                        </div>
                      )}
                      <div className="mt-3 rounded-lg border border-sky-400/15 bg-sky-500/10 p-2 text-sky-100 light:bg-sky-50 light:text-sky-700">
                        缓存说明：当前有 {expiredTraversalCache} 条过期
                        traversal 缓存。缓存会按需重建，不影响健康分数。
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
            {(!beacon?.topIssues || beacon.topIssues.length === 0) && (
              <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] light:bg-emerald-50/70 p-3 text-sm text-emerald-100 light:text-emerald-700">
                暂无需要立即处理的问题。
              </div>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.04] light:bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold text-white light:text-slate-800">
            <Pulse size={18} />
            正在处理
          </div>
          <div className="mt-4 space-y-2 text-sm text-white/65 light:text-slate-600">
            {(beacon?.processingMessages || []).map((message) => (
              <div
                key={message}
                className="rounded-lg bg-sky-500/10 px-3 py-2 text-sky-100 light:text-sky-700"
              >
                {message}
              </div>
            ))}
            {(!beacon?.processingMessages ||
              beacon.processingMessages.length === 0) && (
              <div className="rounded-xl border border-white/10 light:border-slate-100 bg-black/10 light:bg-slate-50/80 p-3">
                当前没有正在处理的健康任务。
              </div>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.04] light:bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold text-white light:text-slate-800">
            <Activity size={18} />
            最近活动时间线
          </div>
          <div className="mt-4 space-y-3">
            {(beacon?.latestActivities || []).map((activity) => (
              <div
                key={`${activity.type}-${activity.createdAt}-${activity.title}`}
                className="border-l-2 border-sky-400/50 pl-3"
              >
                <div className="text-sm font-medium text-white/80 light:text-slate-700">
                  {localizeActivityTitle(activity.title)}
                </div>
                <div className="mt-1 text-xs text-white/50 light:text-slate-500">
                  {localizeActivityDetail(activity.detail)} ·{" "}
                  {formatTime(activity.createdAt)}
                </div>
              </div>
            ))}
            {(!beacon?.latestActivities ||
              beacon.latestActivities.length === 0) && (
              <div className="text-sm text-white/50 light:text-slate-500">
                暂无最近活动。
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.04] light:bg-white p-4 shadow-sm">
        <div className="text-sm font-semibold text-white light:text-slate-800">
          高级诊断数据
        </div>
        <pre className="mt-4 max-h-[420px] overflow-auto rounded-lg bg-black/25 light:bg-slate-100 p-4 text-xs leading-6 text-white/65 light:text-slate-600">
          {JSON.stringify(beacon?.advanced || {}, null, 2)}
        </pre>
      </section>
    </div>
  );
}
