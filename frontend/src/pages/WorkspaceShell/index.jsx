import React from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "@/components/Sidebar";
import {
  mobileRuntimeActive,
  tabletDesktopRuntimeActive,
} from "@/utils/mobileRuntime";
import { SettingsDataProvider } from "@/pages/GeneralSettings/SettingsDataProvider";
import useWorkspaceViewportFrame from "@/hooks/useWorkspaceViewportFrame";

export default function WorkspaceShell() {
  const usesMobileShell = mobileRuntimeActive();
  const usesTabletDesktopShell =
    !usesMobileShell && tabletDesktopRuntimeActive();
  useWorkspaceViewportFrame({ enabled: usesTabletDesktopShell });

  return (
    <SettingsDataProvider>
      {usesMobileShell ? (
        <Outlet />
      ) : (
        <div
          className="athena-desktop-shell bg-zinc-950 light:bg-slate-50 flex"
          data-tablet-desktop-shell={
            usesTabletDesktopShell ? "true" : undefined
          }
        >
          <Sidebar />
          <Outlet />
        </div>
      )}
    </SettingsDataProvider>
  );
}
