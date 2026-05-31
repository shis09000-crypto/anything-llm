import System from "@/models/system";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import Toggle from "@/components/lib/Toggle";
import { useTranslation } from "react-i18next";

export default function LiveSyncToggle({ enabled = false, onToggle }) {
  const [status, setStatus] = useState(enabled);
  const { t } = useTranslation();

  async function toggleFeatureFlag() {
    const updated =
      await System.experimentalFeatures.liveSync.toggleFeature(!status);
    if (!updated) {
      showToast(t("experimental-features.liveSync.errors.update"), "error", {
        clear: true,
      });
      return false;
    }

    setStatus(!status);
    showToast(
      !status
        ? t("experimental-features.liveSync.toasts.enabled")
        : t("experimental-features.liveSync.toasts.disabled"),
      "success",
      { clear: true }
    );
    onToggle();
  }

  return (
    <div className="p-4">
      <div className="flex flex-col gap-y-6 max-w-[500px]">
        <div className="flex items-center justify-between">
          <h2 className="text-theme-text-primary text-md font-bold">
            {t("experimental-features.liveSync.title")}
          </h2>
          <Toggle size="lg" enabled={status} onChange={toggleFeatureFlag} />
        </div>
        <div className="flex flex-col space-y-4">
          <p className="text-theme-text-secondary text-sm">
            {t("experimental-features.liveSync.description")}
          </p>
          <p className="text-theme-text-secondary text-sm">
            {t("experimental-features.liveSync.workspaceUpdate")}
          </p>
          <p className="text-theme-text-secondary text-xs italic">
            {t("experimental-features.liveSync.webOnly")}
          </p>
        </div>
      </div>
      <div className="mt-8">
        <ul className="space-y-2">
          <li>
            <a
              href="https://docs.anythingllm.com/beta-preview/active-features/live-document-sync"
              target="_blank"
              className="text-sm text-blue-400 light:text-blue-500 hover:underline flex items-center gap-x-1"
              rel="noreferrer"
            >
              <ArrowSquareOut size={14} />
              <span>{t("experimental-features.liveSync.docsLink")}</span>
            </a>
          </li>
          <li>
            <Link
              to={paths.experimental.liveDocumentSync.manage()}
              className="text-sm text-blue-400 light:text-blue-500 hover:underline"
            >
              {t("experimental-features.liveSync.manageLink")} &rarr;
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}
