import { useState } from "react";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";
import { useTranslation } from "react-i18next";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";

export default function ResetDatabase({ workspace }) {
  const [deleting, setDeleting] = useState(false);
  const { t } = useTranslation();
  const resetVectorDatabase = async () => {
    if (
      !(await showAppConfirm({
        tone: "danger",
        title: "重置向量数据库？",
        description: `${t("vector-workspace.reset.confirm")}`,
        confirmText: "重置",
      }))
    )
      return false;

    setDeleting(true);
    const success = await Workspace.wipeVectorDb(workspace.slug);
    if (!success) {
      showToast(
        t("vector-workspace.reset.error"),
        t("vector-workspace.common.error"),
        {
          clear: true,
        }
      );
      setDeleting(false);
      return;
    }

    showToast(
      t("vector-workspace.reset.success"),
      t("vector-workspace.common.success"),
      {
        clear: true,
      }
    );
    setDeleting(false);
  };

  return (
    <button
      disabled={deleting}
      onClick={resetVectorDatabase}
      type="button"
      className="w-60 motion-hover border border-transparent rounded-lg whitespace-nowrap text-sm px-5 py-2.5 focus:z-10 bg-red-500/25 text-red-200 light:text-red-500 hover:light:text-[#FFFFFF] hover:text-[#FFFFFF] hover:bg-red-600 disabled:bg-red-600 disabled:text-red-200 disabled:animate-pulse"
    >
      {deleting
        ? t("vector-workspace.reset.resetting")
        : t("vector-workspace.reset.reset")}
    </button>
  );
}
