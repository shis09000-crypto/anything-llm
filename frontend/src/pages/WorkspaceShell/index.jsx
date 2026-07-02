import React from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "@/components/Sidebar";
import { ChatThreadDraftProviderBoundary } from "@/contexts/ChatThreadDraftProvider";
import { mobileRuntimeActive } from "@/utils/mobileRuntime";

export default function WorkspaceShell() {
  if (mobileRuntimeActive()) return <Outlet />;

  return (
    <ChatThreadDraftProviderBoundary>
      <div className="w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex">
        <Sidebar />
        <Outlet />
      </div>
    </ChatThreadDraftProviderBoundary>
  );
}
