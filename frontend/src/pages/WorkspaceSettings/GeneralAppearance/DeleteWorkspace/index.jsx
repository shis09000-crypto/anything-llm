import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import { requestWorkspaceDelete } from "@/utils/workspaceDeleteOptimisticController";

export default function DeleteWorkspace({ workspace }) {
  const [deleting, setDeleting] = useState(false);
  const mountedRef = useRef(true);
  const { t } = useTranslation();

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const deleteWorkspace = async () => {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: t("general.delete.title"),
        description: `${t("general.delete.confirm-start")} ${workspace.name} ${t(
          "general.delete.confirm-end"
        )}`,
        confirmText: t("general.delete.delete"),
      }))
    )
      return false;

    setDeleting(true);
    const action = requestWorkspaceDelete({ workspace });
    void action?.promise?.then((outcome) => {
      if (!outcome.ok && mountedRef.current) setDeleting(false);
    });
  };
  return (
    <div className="flex flex-col mt-10">
      <label className="block input-label">{t("general.delete.title")}</label>
      <p className="text-theme-text-secondary text-xs font-medium py-1.5">
        {t("general.delete.description")}
      </p>
      <button
        disabled={deleting}
        onClick={deleteWorkspace}
        type="button"
        className="w-60 mt-4 motion-hover border border-transparent rounded-lg whitespace-nowrap text-sm px-5 py-2.5 focus:z-10 bg-red-500/25 text-red-200 light:text-red-500 hover:light:text-[#FFFFFF] hover:text-[#FFFFFF] hover:bg-red-600 disabled:bg-red-600 disabled:text-red-200 disabled:animate-pulse"
      >
        {deleting ? t("general.delete.deleting") : t("general.delete.delete")}
      </button>
    </div>
  );
}
