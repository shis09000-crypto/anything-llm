import React, { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import System from "@/models/system";
import showToast from "@/utils/toast";
import {
  ArrowClockwise,
  Database,
  FirstAidKit,
  HardDrives,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";

const severityStyles = {
  healthy: "text-green-400 border-green-500/40 bg-green-500/10",
  info: "text-blue-300 border-blue-500/40 bg-blue-500/10",
  warning: "text-yellow-300 border-yellow-500/40 bg-yellow-500/10",
  critical: "text-red-300 border-red-500/40 bg-red-500/10",
};

const categoryLabels = {
  storage: "数据盘",
  database: "主数据库",
  auth: "账号认证",
  vector: "向量库",
  workspace: "工作区数据",
  background: "后台任务",
};

function formatTime(value) {
  if (!value) return "未知";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function statusClass(severity = "healthy") {
  return severityStyles[severity] || severityStyles.info;
}

function compactJson(value) {
  return JSON.stringify(value || {}, null, 2);
}

export default function SystemPatrol() {
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(null);
  const [status, setStatus] = useState(null);
  const [previewing, setPreviewing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [repairPreview, setRepairPreview] = useState(null);
  const mountedRef = useRef(true);

  async function loadStatus() {
    const result = await System.patrolStatus();
    if (!mountedRef.current) return;
    if (!result?.success) {
      showToast(result?.error || "系统巡查状态读取失败。", "error");
    } else {
      setStatus(result);
    }
    setLoading(false);
  }

  async function run(mode) {
    setRunning(mode);
    const result = await System.runPatrol({ mode });
    if (!mountedRef.current) return;
    if (!result?.success) {
      showToast(result?.error || "系统巡查执行失败。", "error");
    } else {
      showToast(
        mode === "deep" ? "深度巡查完成。" : "轻量巡查完成。",
        "success"
      );
      await loadStatus();
    }
    setRunning(null);
  }

  async function previewRepair(repairId) {
    setPreviewing(repairId);
    const result = await System.patrolRepairPreview(repairId);
    if (!mountedRef.current) return;
    if (!result?.success) {
      showToast(result?.error || "修复预案生成失败。", "error");
    } else {
      setRepairPreview(result);
    }
    setPreviewing(null);
  }

  async function confirmRepair() {
    if (!repairPreview?.repairId) return;
    setConfirming(repairPreview.repairId);
    const result = await System.patrolRepairConfirm(repairPreview.repairId);
    if (!mountedRef.current) return;
    if (!result?.success) {
      showToast(result?.error || "修复执行失败。", "error");
    } else {
      showToast("修复动作已完成。", "success");
      setRepairPreview(null);
      await run("light");
    }
    setConfirming(null);
  }

  useEffect(() => {
    loadStatus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const latestRun = status?.latestRun;
  const report = latestRun?.report || null;
  const summary = report?.summary || null;
  const checks = report?.checks || [];
  const checksByCategory = useMemo(() => {
    return checks.reduce((acc, check) => {
      const category = check.category || "other";
      if (!acc[category]) acc[category] = [];
      acc[category].push(check);
      return acc;
    }, {});
  }, [checks]);

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <main className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll">
        <div className="flex flex-col gap-5 px-4 py-16 md:p-6">
          <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-5 border-b border-white/10 light:border-slate-200">
            <div>
              <div className="flex items-center gap-2 text-theme-text-primary">
                <FirstAidKit className="h-6 w-6 text-blue-400" />
                <h1 className="text-xl font-semibold">系统巡查中心</h1>
              </div>
              <p className="text-sm text-theme-text-secondary mt-2 max-w-3xl">
                检查数据盘、SQLite、共享认证库、账号绑定、LanceDB
                命名空间、文档/向量一致性和后台任务。修复动作需要管理员确认。
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!!running}
                onClick={() => run("light")}
                className="h-10 px-4 rounded-md bg-theme-action-menu-bg text-theme-text-primary hover:bg-theme-action-menu-item-hover disabled:opacity-60 flex items-center gap-2"
              >
                <ArrowClockwise className="h-4 w-4" />
                {running === "light" ? "巡查中" : "轻量巡查"}
              </button>
              <button
                type="button"
                disabled={!!running}
                onClick={() => run("deep")}
                className="h-10 px-4 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-60 flex items-center gap-2"
              >
                <Database className="h-4 w-4" />
                {running === "deep" ? "巡查中" : "深度巡查"}
              </button>
            </div>
          </header>

          {loading ? (
            <div className="text-theme-text-secondary">正在读取巡查状态...</div>
          ) : !latestRun ? (
            <section className="border border-white/10 light:border-slate-200 rounded-lg p-5">
              <p className="text-theme-text-primary font-medium">
                暂无巡查记录。
              </p>
              <p className="text-theme-text-secondary text-sm mt-1">
                点击轻量巡查即可生成第一份系统健康报告。
              </p>
            </section>
          ) : (
            <>
              <section className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <SummaryTile
                  label="健康分"
                  value={summary?.score ?? latestRun.summaryScore}
                  icon={<ShieldCheck className="h-5 w-5" />}
                  severity={summary?.status || latestRun.summaryStatus}
                />
                <SummaryTile
                  label="巡查模式"
                  value={latestRun.mode}
                  icon={<FirstAidKit className="h-5 w-5" />}
                  severity="info"
                />
                <SummaryTile
                  label="问题项"
                  value={
                    (summary?.counts?.critical || 0) +
                    (summary?.counts?.warning || 0)
                  }
                  icon={<WarningCircle className="h-5 w-5" />}
                  severity={
                    summary?.counts?.critical
                      ? "critical"
                      : summary?.counts?.warning
                        ? "warning"
                        : "healthy"
                  }
                />
                <SummaryTile
                  label="数据根目录"
                  value={status?.environment?.storageRoot || "未知"}
                  icon={<HardDrives className="h-5 w-5" />}
                  severity="info"
                  small
                />
              </section>

              <section className="text-sm text-theme-text-secondary">
                最近巡查：
                {formatTime(latestRun.completedAt || latestRun.startedAt)}
              </section>

              <section className="flex flex-col gap-4">
                {Object.entries(checksByCategory).map(([category, items]) => (
                  <div
                    key={category}
                    className="border border-white/10 light:border-slate-200 rounded-lg overflow-hidden"
                  >
                    <div className="px-4 py-3 bg-theme-bg-primary light:bg-slate-50 flex items-center justify-between">
                      <h2 className="text-theme-text-primary font-semibold">
                        {categoryLabels[category] || category}
                      </h2>
                      <span className="text-xs text-theme-text-secondary">
                        {items.length} 项
                      </span>
                    </div>
                    <div className="divide-y divide-white/10 light:divide-slate-200">
                      {items.map((check) => (
                        <CheckRow
                          key={check.id}
                          check={check}
                          previewing={previewing === check.repairAction?.id}
                          onPreview={previewRepair}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            </>
          )}
        </div>

        {repairPreview && (
          <RepairPreview
            payload={repairPreview}
            confirming={confirming === repairPreview.repairId}
            onClose={() => setRepairPreview(null)}
            onConfirm={confirmRepair}
          />
        )}
      </main>
    </div>
  );
}

function SummaryTile({ label, value, icon, severity, small = false }) {
  return (
    <div className={`border rounded-lg p-4 ${statusClass(severity)}`}>
      <div className="flex items-center gap-2 text-sm">
        {icon}
        <span>{label}</span>
      </div>
      <div
        className={`mt-3 font-semibold text-theme-text-primary break-words ${
          small ? "text-xs leading-5" : "text-2xl"
        }`}
      >
        {String(value ?? "未知")}
      </div>
    </div>
  );
}

function CheckRow({ check, onPreview, previewing }) {
  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-1 rounded border text-xs ${statusClass(
                check.severity
              )}`}
            >
              {check.severity}
            </span>
            <span className="text-theme-text-primary font-medium">
              {check.summary}
            </span>
          </div>
          <p className="text-xs text-theme-text-secondary mt-2">
            {check.id} · {formatTime(check.lastCheckedAt)}
          </p>
        </div>
        {check.repairAction && (
          <button
            type="button"
            disabled={previewing}
            onClick={() => onPreview(check.repairAction.id)}
            className="h-9 px-3 rounded-md bg-theme-action-menu-bg text-theme-text-primary hover:bg-theme-action-menu-item-hover disabled:opacity-60"
          >
            {previewing ? "生成中" : "查看修复预案"}
          </button>
        )}
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-theme-text-secondary">
          查看证据
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-black/30 light:bg-slate-100 p-3 text-xs text-theme-text-secondary whitespace-pre-wrap">
          {compactJson(check.evidence)}
        </pre>
      </details>
    </div>
  );
}

function RepairPreview({ payload, confirming, onClose, onConfirm }) {
  const preview = payload.preview || {};
  const manualOnly = preview.kind === "manual_runbook";
  const blocked = Boolean(preview.blocked);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-lg bg-theme-bg-secondary border border-white/10 light:border-slate-200 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-theme-text-primary">
              {preview.title || payload.action?.label || "修复预案"}
            </h3>
            <p className="text-sm text-theme-text-secondary mt-1">
              动作：{payload.action?.action} · 风险：{payload.action?.risk}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 rounded-md bg-theme-action-menu-bg text-theme-text-primary"
          >
            关闭
          </button>
        </div>

        <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-black/30 light:bg-slate-100 p-3 text-xs text-theme-text-secondary whitespace-pre-wrap">
          {compactJson(preview)}
        </pre>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-md bg-theme-action-menu-bg text-theme-text-primary"
          >
            取消
          </button>
          <button
            type="button"
            disabled={blocked || confirming}
            onClick={onConfirm}
            className="h-10 px-4 rounded-md bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
          >
            {manualOnly
              ? "确认已阅读"
              : confirming
                ? "执行中"
                : blocked
                  ? "预案阻断"
                  : "确认执行"}
          </button>
        </div>
      </div>
    </div>
  );
}
