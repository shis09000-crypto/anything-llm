import { useNavigate } from "react-router-dom";
import { Play, PencilSimple, X } from "@phosphor-icons/react";
import paths from "@/utils/paths";
import { humanizeCron } from "../utils/cron";
import { useTranslation } from "react-i18next";

// One row of the scheduled-jobs list. Clicking the name navigates to the
// run history; CRUD callbacks come from the parent.
export default function JobRow({ job, onTrigger, onToggle, onEdit, onDelete }) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  // A job has at most one in-flight run; disable "Run now" while it's queued
  // or running so users get visible feedback that their click registered and
  // so the backend dedup never has to drop a manual trigger silently.
  const inFlight =
    job.latestRun?.status === "running" || job.latestRun?.status === "queued";

  const statusText = job.latestRun
    ? t(`scheduledJobs.status.${job.latestRun.status}`, job.latestRun.status)
    : t("scheduledJobs.row.neverRun");

  const stop = (handler) => (e) => {
    e.stopPropagation();
    handler();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(paths.settings.scheduledJobRuns(job.id))}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(paths.settings.scheduledJobRuns(job.id));
        }
      }}
      className="flex items-center justify-between px-4 h-14 hover:bg-[var(--soft-control-hover)] motion-hover cursor-pointer"
      title={t("scheduledJobs.row.viewRuns")}
    >
      <span className="w-[150px] text-sm font-bold text-[var(--soft-text-primary)] truncate">
        {job.name}
      </span>
      <span className="w-[180px] text-sm font-medium text-[var(--soft-text-secondary)] truncate">
        {humanizeCron(job.schedule, i18n.language)}
      </span>
      <span className="w-[120px] text-sm font-medium text-[var(--soft-text-secondary)] truncate">
        {statusText}
      </span>
      <span className="w-[180px] text-sm font-medium text-[var(--soft-text-secondary)] truncate">
        {job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "—"}
      </span>
      <span className="w-[180px] text-sm font-medium text-[var(--soft-text-secondary)] truncate">
        {job.enabled && job.nextRunAt
          ? new Date(job.nextRunAt).toLocaleString()
          : "—"}
      </span>
      <div className="w-[140px] flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={stop(() => onDelete(job.id))}
          className="border-none p-2 rounded-full text-[var(--soft-text-muted)] hover:text-red-500 hover:bg-red-50 motion-hover"
          title={t("scheduledJobs.row.delete")}
        >
          <X className="h-4 w-4 shrink-0" />
        </button>
        <button
          type="button"
          onClick={stop(() => onEdit(job))}
          className="border-none p-2 rounded-full text-[var(--soft-text-muted)] hover:text-[#2152ff] hover:bg-[var(--soft-control-hover)] motion-hover"
          title={t("scheduledJobs.row.edit")}
        >
          <PencilSimple className="h-4 w-4 shrink-0" />
        </button>
        <button
          type="button"
          onClick={stop(() => onTrigger(job.id))}
          disabled={inFlight}
          className="border-none p-2 rounded-full text-[var(--soft-text-muted)] hover:text-[#2152ff] hover:bg-[var(--soft-control-hover)] motion-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title={t("scheduledJobs.row.runNow")}
        >
          <Play className="h-4 w-4 shrink-0" />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={job.enabled}
          onClick={stop(() => onToggle(job.id))}
          title={
            job.enabled
              ? t("scheduledJobs.row.disable")
              : t("scheduledJobs.row.enable")
          }
          className={`border-none relative h-[17px] w-8 rounded-full p-0.5 motion-hover shadow-inner ${
            job.enabled
              ? "bg-[linear-gradient(310deg,#2152ff,#21d4fd)]"
              : "bg-slate-300 dark:bg-slate-700"
          }`}
        >
          <span
            className={`block h-[13px] w-[13px] rounded-full bg-white shadow motion-hover ${
              job.enabled ? "translate-x-[15px]" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}
