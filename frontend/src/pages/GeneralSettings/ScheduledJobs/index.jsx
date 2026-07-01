import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ScheduledJobs from "@/models/scheduledJobs";
import { subscribeToPushNotifications } from "@/hooks/useWebPushNotifications";
import useWebPushNotifications from "@/hooks/useWebPushNotifications";
import usePolling from "@/hooks/usePolling";
import JobFormModal from "./JobFormModal";
import ModalWrapper from "@/components/ModalWrapper";
import { useModal } from "@/hooks/useModal";
import showToast from "@/utils/toast";
import JobRow from "./components/JobRow";
import { Bell } from "@phosphor-icons/react";
import { Tooltip } from "react-tooltip";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import {
  SoftButton,
  SoftCard,
  SoftSettingsLayout,
} from "@/components/SoftSettings";

export default function ScheduledJobsPage() {
  const { t } = useTranslation();
  useWebPushNotifications(false);
  const { isOpen, openModal, closeModal } = useModal();
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState([]);
  const [editingJob, setEditingJob] = useState(null);
  const mountedRef = useRef(true);

  const fetchJobs = async () => {
    const { jobs: foundJobs } = await ScheduledJobs.list();
    if (!mountedRef.current) return;
    setJobs(foundJobs || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchJobs();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Poll every 5s while tab is visible so status badges and run timestamps stay in sync.
  usePolling(fetchJobs, 5000);

  const handleDelete = async (id) => {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: "删除定时任务？",
        description: t("scheduledJobs.confirmDelete"),
        confirmText: "删除",
      }))
    )
      return;
    await ScheduledJobs.delete(id);
    showToast(t("scheduledJobs.toast.deleted"), "success", { clear: true });
    fetchJobs();
  };

  const handleToggle = async (id) => {
    const result = await ScheduledJobs.toggle(id);
    if (result?.error) showToast(result.error, "error", { clear: true });
    fetchJobs();
  };

  const handleTrigger = async (id) => {
    const { success, skipped, error } = await ScheduledJobs.trigger(id);
    if (!success) {
      showToast(error || t("scheduledJobs.toast.triggerFailed"), "error", {
        clear: true,
      });
    } else if (skipped) {
      showToast(
        t(
          "scheduledJobs.toast.triggerSkipped",
          "A run is already in progress for this job"
        ),
        "info",
        { clear: true }
      );
    } else {
      showToast(t("scheduledJobs.toast.triggered"), "success", { clear: true });
    }
    fetchJobs();
  };

  const handleEdit = (job) => {
    setEditingJob(job);
    openModal();
  };

  const handleCreate = () => {
    setEditingJob(null);
    openModal();
  };

  if (loading) {
    return (
      <BaseLayout showNewJobButton={false} handleCreate={handleCreate}>
        <div className="w-full flex items-center justify-center text-zinc-400 light:text-slate-600 text-sm pt-8">
          {t("scheduledJobs.loading")}
        </div>
      </BaseLayout>
    );
  }

  return (
    <BaseLayout
      showNewJobButton={jobs.length !== 0}
      handleCreate={handleCreate}
    >
      <SoftCard className="mt-2">
        <div className="flex items-center justify-between px-4 pb-[18px] text-xs font-bold uppercase tracking-[1.4px] text-[var(--soft-text-muted)]">
          <span className="w-[150px]">{t("scheduledJobs.table.name")}</span>
          <span className="w-[180px]">{t("scheduledJobs.table.schedule")}</span>
          <span className="w-[120px]">{t("scheduledJobs.table.status")}</span>
          <span className="w-[180px]">{t("scheduledJobs.table.lastRun")}</span>
          <span className="w-[180px]">{t("scheduledJobs.table.nextRun")}</span>
          <span className="w-[140px] text-right">
            {t("scheduledJobs.table.actions")}
          </span>
        </div>
        <div className="h-px w-full bg-slate-200/80 dark:bg-white/10" />

        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-8 py-24 text-center">
            <div className="flex flex-col gap-1.5">
              <p className="text-base font-bold text-[var(--soft-text-primary)]">
                {t("scheduledJobs.emptyTitle")}
              </p>
              <p className="text-sm font-medium text-[var(--soft-text-secondary)]">
                {t("scheduledJobs.emptySubtitle")}
              </p>
            </div>
            <SoftButton type="button" onClick={handleCreate}>
              {t("scheduledJobs.newJob")}
            </SoftButton>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-slate-200/80 dark:divide-white/10">
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                onTrigger={handleTrigger}
                onToggle={handleToggle}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </SoftCard>

      <ModalWrapper isOpen={isOpen}>
        <JobFormModal
          job={editingJob}
          onClose={closeModal}
          onSaved={() => {
            closeModal();
            fetchJobs();
          }}
        />
      </ModalWrapper>
    </BaseLayout>
  );
}

function BaseLayout({
  showNewJobButton = false,
  handleCreate = () => {},
  children,
}) {
  const { t } = useTranslation();

  return (
    <SoftSettingsLayout
      title={t("scheduledJobs.title")}
      description={t("scheduledJobs.description")}
      actions={
        <>
          <NotificationBellButton />
          {showNewJobButton && (
            <SoftButton type="button" onClick={handleCreate}>
              {t("scheduledJobs.newJob")}
            </SoftButton>
          )}
        </>
      }
    >
      {children}
    </SoftSettingsLayout>
  );
}

function NotificationBellButton() {
  const { t } = useTranslation();
  const [permissionState, setPermissionState] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "denied"
  );

  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    permissionState === "granted"
  ) {
    return null;
  }

  const handleClick = async () => {
    await subscribeToPushNotifications();
    setPermissionState(Notification.permission);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        data-tooltip-id="notification-bell-tooltip"
        data-tooltip-content={t(
          "scheduledJobs.enableNotifications",
          "Enable browser notifications for job results"
        )}
        className="settings-soft-button settings-soft-button-outline settings-soft-button-md flex items-center justify-center !w-9 !px-0"
      >
        <Bell size={20} className="text-orange-400" />
      </button>
      <Tooltip
        id="notification-bell-tooltip"
        place="bottom"
        className="tooltip !text-xs"
      />
    </>
  );
}
