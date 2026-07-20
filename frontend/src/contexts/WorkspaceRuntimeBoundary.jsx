import { ChatThreadDraftProviderBoundary } from "@/contexts/ChatThreadDraftProvider";
import { WorkspaceLayoutProvider } from "@/contexts/WorkspaceLayoutProvider";
import { useWorkspaceNavigationSyncInvalidation } from "@/hooks/useWorkspaceSyncEvents";

function WorkspaceNavigationSyncBridge() {
  useWorkspaceNavigationSyncInvalidation();
  return null;
}

export default function WorkspaceRuntimeBoundary({ children }) {
  return (
    <WorkspaceLayoutProvider>
      <ChatThreadDraftProviderBoundary>
        <WorkspaceNavigationSyncBridge />
        {children}
      </ChatThreadDraftProviderBoundary>
    </WorkspaceLayoutProvider>
  );
}
