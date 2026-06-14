import paths from "@/utils/paths";
import { ArrowUUpLeft, Wrench } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { useMatch } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function SettingsButton() {
  const { t } = useTranslation();
  const isInSettings = !!useMatch("/settings/*");

  if (isInSettings)
    return (
      <div className="flex w-fit">
        <Link
          to={paths.home()}
          className="motion-hover p-2 rounded-full bg-theme-sidebar-footer-icon hover:bg-theme-sidebar-footer-icon-hover"
          aria-label={t("common.controls.backToWorkspace")}
          data-tooltip-id="footer-item"
          data-tooltip-content={t("common.controls.backToWorkspace")}
        >
          <ArrowUUpLeft
            className="h-5 w-5 text-white light:text-slate-800"
            weight="fill"
          />
        </Link>
      </div>
    );

  return (
    <div className="flex w-fit">
      <Link
        to={paths.settings.interface()}
        className="motion-hover p-2 rounded-full bg-theme-sidebar-footer-icon hover:bg-theme-sidebar-footer-icon-hover"
        aria-label={t("common.controls.settings")}
        data-tooltip-id="footer-item"
        data-tooltip-content={t("common.controls.settingsDescription")}
      >
        <Wrench
          className="h-5 w-5 text-white light:text-slate-800"
          weight="fill"
        />
      </Link>
    </div>
  );
}
