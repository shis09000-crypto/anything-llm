import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import AppButton from "@/components/lib/AppButton";
import showToast from "@/utils/toast";
import { syncMutationQueue } from "@/utils/syncV2/syncMutationQueue";
import { syncV2Runtime } from "@/utils/syncV2/syncV2Runtime";
import { syncV2StateStore } from "@/utils/syncV2/syncV2StateStore";

export default function SyncConflictCenter() {
  const { t } = useTranslation();
  const [issues, setIssues] = useState([]);
  const [workingId, setWorkingId] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  const refresh = useCallback(async () => {
    const queued = await syncMutationQueue.list();
    setIssues(
      queued.filter((item) => ["conflict", "failed"].includes(item.status))
    );
  }, []);

  useEffect(() => {
    void refresh();
    const handleConflict = () => {
      setCollapsed(false);
      void refresh();
    };
    window.addEventListener("athena-sync-v2-conflict", handleConflict);
    return () =>
      window.removeEventListener("athena-sync-v2-conflict", handleConflict);
  }, [refresh]);

  async function reconcile(item) {
    if (item.requiresFullSync) await syncV2Runtime.reconcile();
    await syncV2Runtime.refreshNode(item.mutation.nodeKey);
  }

  async function applyServerValue(item) {
    const mutationId = item.mutation.mutationId;
    setWorkingId(mutationId);
    try {
      await syncMutationQueue.discard(mutationId);
      await reconcile(item);
      await refresh();
      showToast(t("syncConflict.serverApplied"), "success");
    } catch (error) {
      showToast(error?.message || t("syncConflict.failed"), "error");
    } finally {
      setWorkingId(null);
    }
  }

  async function retryLocalValue(item) {
    const mutationId = item.mutation.mutationId;
    setWorkingId(mutationId);
    try {
      await reconcile(item);
      const descriptor = syncV2StateStore.descriptor(item.mutation.nodeKey);
      if (!descriptor) throw new Error(t("syncConflict.missingVersion"));
      await syncMutationQueue.retry(mutationId, {
        baseVersion: Number(descriptor.stateVersion || 0),
      });
      await refresh();
      showToast(t("syncConflict.localApplied"), "success");
    } catch (error) {
      showToast(error?.message || t("syncConflict.failed"), "error");
      await refresh();
    } finally {
      setWorkingId(null);
    }
  }

  if (!issues.length) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 right-4 z-[10000] rounded-full border border-amber-300/50 bg-theme-bg-primary px-4 py-2 text-xs font-semibold text-theme-text-primary shadow-xl"
        aria-label={t("syncConflict.expand")}
      >
        {t("syncConflict.title")} · {issues.length}
      </button>
    );
  }

  return (
    <aside
      className="fixed bottom-4 right-4 z-[10000] w-[min(420px,calc(100vw-2rem))] rounded-2xl border border-amber-300/40 bg-theme-bg-primary p-4 shadow-2xl"
      aria-live="polite"
      aria-label={t("syncConflict.title")}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-theme-text-primary">
          {t("syncConflict.title")}
        </h2>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="rounded-full px-2 py-1 text-xs font-semibold text-theme-text-secondary hover:bg-theme-bg-secondary"
          aria-label={t("syncConflict.collapse")}
        >
          {t("syncConflict.collapse")}
        </button>
      </div>
      <p className="mt-1 text-xs text-theme-text-secondary">
        {t("syncConflict.description", { count: issues.length })}
      </p>
      <div className="mt-3 max-h-72 space-y-3 overflow-auto">
        {issues.map((item) => {
          const mutationId = item.mutation.mutationId;
          const busy = workingId === mutationId;
          return (
            <div
              key={mutationId}
              className="rounded-xl border border-theme-sidebar-border bg-theme-bg-secondary p-3"
            >
              <div className="break-all text-xs font-medium text-theme-text-primary">
                {item.mutation.nodeKey}
              </div>
              <div className="mt-1 text-xs text-theme-text-secondary">
                {item.status === "failed"
                  ? t("syncConflict.failedMutation", {
                      error: item.lastError || t("syncConflict.failed"),
                    })
                  : item.requiresFullSync
                    ? t("syncConflict.historyExpired")
                    : t("syncConflict.sameField")}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <AppButton
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void applyServerValue(item)}
                >
                  {item.status === "failed"
                    ? t("syncConflict.discardLocal")
                    : t("syncConflict.useServer")}
                </AppButton>
                <AppButton
                  size="sm"
                  loading={busy}
                  onClick={() => void retryLocalValue(item)}
                >
                  {item.status === "failed"
                    ? t("syncConflict.retry")
                    : t("syncConflict.keepLocal")}
                </AppButton>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
