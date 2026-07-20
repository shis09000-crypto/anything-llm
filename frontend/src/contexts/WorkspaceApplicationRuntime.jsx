import { Outlet } from "react-router-dom";
import WorkspaceRuntimeBoundary from "@/contexts/WorkspaceRuntimeBoundary";

export default function WorkspaceApplicationRuntime() {
  return (
    <WorkspaceRuntimeBoundary>
      <Outlet />
    </WorkspaceRuntimeBoundary>
  );
}
