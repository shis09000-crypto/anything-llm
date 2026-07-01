import { useSoftSettingsShell } from "@/components/SoftSettings/context";
import { isPersistentSettingsRoute } from "@/utils/settingsRoutes";

export default function PreLoader({ size = "16" }) {
  return (
    <div
      className={`h-${size} w-${size} animate-spin rounded-full border-4 border-solid border-primary border-t-transparent`}
    ></div>
  );
}

export function FullScreenLoader({ surface = null }) {
  const hasPersistentSettingsShell = useSoftSettingsShell();
  const isSettingsSurface =
    surface === "settings" ||
    (typeof window !== "undefined" &&
      isPersistentSettingsRoute(window.location.pathname));

  if (hasPersistentSettingsShell) {
    return (
      <div className="flex h-full min-h-[320px] w-full items-center justify-center bg-transparent">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-solid border-[var(--theme-loader)] border-t-transparent"></div>
      </div>
    );
  }

  if (isSettingsSurface) {
    return (
      <div
        id="preloader"
        className="fixed left-0 top-0 z-999999 flex h-screen w-screen items-center justify-center bg-[#f5f5f7]"
      >
        <div className="h-14 w-14 animate-spin rounded-full border-4 border-solid border-slate-300 border-t-slate-500"></div>
      </div>
    );
  }

  return (
    <div
      id="preloader"
      className="fixed left-0 top-0 z-999999 flex h-screen w-screen items-center justify-center bg-theme-bg-primary"
    >
      <div className="h-16 w-16 animate-spin rounded-full border-4 border-solid border-[var(--theme-loader)] border-t-transparent"></div>
    </div>
  );
}
