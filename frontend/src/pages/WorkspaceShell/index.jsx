import React from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "@/components/Sidebar";
import { mobileRuntimeActive } from "@/utils/mobileRuntime";
import { SettingsDataProvider } from "@/pages/GeneralSettings/SettingsDataProvider";

export default function WorkspaceShell() {
  return (
    <SettingsDataProvider>
      {mobileRuntimeActive() ? (
        <Outlet />
      ) : (
        <div className="athena-desktop-shell bg-zinc-950 light:bg-slate-50 flex">
          <Sidebar />
          <Outlet />
        </div>
      )}
    </SettingsDataProvider>
  );
}
