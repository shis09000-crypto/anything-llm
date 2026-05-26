import { useTranslation } from "react-i18next";
import useUser from "@/hooks/useUser";

/**
 * Quick action buttons for home and empty workspace states.
 * @param {Object} props
 * @param {boolean} props.hasAvailableWorkspace - Whether the user has a workspace they can use
 * @param {Function} props.onCreateAgent - Handler for "Create an Agent" action
 * @param {Function} props.onEditWorkspace - Handler for "Edit Workspace" action
 * @param {Function} props.onUploadDocument - Handler for "Upload a Document" action
 */
export default function QuickActions({
  hasAvailableWorkspace,
  onCreateAgent,
  onEditWorkspace,
  onUploadDocument,
}) {
  const { t } = useTranslation();
  const { user } = useUser();

  return (
    <div className="flex flex-wrap justify-center gap-2 mt-6">
      <QuickActionButton
        label={t("main-page.quickActions.createAgent")}
        onClick={onCreateAgent}
        show={!user || ["admin"].includes(user?.role)}
      />
      <QuickActionButton
        label={t("main-page.quickActions.editWorkspace")}
        onClick={onEditWorkspace}
        show={
          hasAvailableWorkspace &&
          (!user || ["admin", "manager"].includes(user?.role))
        }
      />
      <QuickActionButton
        label={t("main-page.quickActions.uploadDocument")}
        onClick={onUploadDocument}
        // Any user can upload documents.
        show={true}
      />
    </div>
  );
}

function QuickActionButton({ label, onClick, show = true }) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2 rounded-full border border-slate-200 bg-white/70 text-slate-700 text-sm font-medium leading-5 shadow-sm backdrop-blur hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors dark:bg-zinc-800/70 dark:text-white/80 dark:border-white/10 dark:hover:bg-zinc-700"
    >
      {label}
    </button>
  );
}
