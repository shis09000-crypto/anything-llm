import useLoginMode from "@/hooks/useLoginMode";
import usePfp from "@/hooks/usePfp";
import useUser from "@/hooks/useUser";
import paths from "@/utils/paths";
import { userFromStorage } from "@/utils/request";
import { Person } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function UserButton({ className = "" }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mode = useLoginMode();
  const { user } = useUser();

  if (mode === null || !user) return null;

  return (
    <button
      onClick={() => navigate(paths.settings.account())}
      type="button"
      className={`uppercase motion-hover inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-theme-sidebar-border bg-theme-sidebar-footer-icon p-0 text-xs font-semibold text-theme-text-primary hover:bg-theme-sidebar-footer-icon-hover light:bg-white light:text-slate-700 light:hover:bg-slate-100 ${className}`}
      aria-label={t("profile_settings.account")}
      data-tooltip-id="user-account-button"
      data-tooltip-content={t("profile_settings.account")}
    >
      {mode === "multi" ? <UserDisplay /> : <Person size={16} />}
    </button>
  );
}

function UserDisplay() {
  const { pfp } = usePfp();
  const user = userFromStorage();

  if (pfp) {
    return (
      <div className="h-full w-full overflow-hidden rounded-md bg-gray-100">
        <img
          src={pfp}
          alt="User profile picture"
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  return user?.username?.slice(0, 2) || "AA";
}
