import React, { useEffect, useRef, useState } from "react";
import { default as WorkspaceChatContainer } from "@/components/WorkspaceChat";
import Sidebar from "@/components/Sidebar";
import { useParams } from "react-router-dom";
import Workspace from "@/models/workspace";
import PasswordModal, { usePasswordModal } from "@/components/Modals/Password";
import { isMobile } from "react-device-detect";
import { FullScreenLoader } from "@/components/Preloader";
import { warmWorkspaceChat } from "@/utils/chat/workspaceChatPrefetch";
import { rememberLastVisitedWorkspace } from "@/utils/lastVisitedWorkspace";

function workspaceSwitchFlickerDebugEnabled() {
  try {
    return (
      import.meta.env.DEV &&
      (window.localStorage.getItem("threadSwitchFlickerDebug") === "true" ||
        window.localStorage.getItem("workspaceSwitchFlickerDebug") === "true")
    );
  } catch {
    return false;
  }
}

function debugWorkspaceSwitchFlicker(label, payload = {}) {
  if (!workspaceSwitchFlickerDebugEnabled()) return;
  console.debug("[workspace-switch-flicker]", label, payload);
}

export default function WorkspaceChat() {
  const { loading, requiresAuth, mode } = usePasswordModal();

  if (loading) return <FullScreenLoader />;
  if (requiresAuth !== false) {
    return <>{requiresAuth !== null && <PasswordModal mode={mode} />}</>;
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex">
      {!isMobile && <Sidebar />}
      <ShowWorkspaceChat />
    </div>
  );
}

function ShowWorkspaceChat() {
  const { slug, threadSlug = null } = useParams();
  const [workspace, setWorkspace] = useState(null);
  // Tracks which workspace `workspace` belongs to. While a new workspace's
  // data is in flight, we keep the previous workspace's chat mounted
  // (Slack/Linear-style transition) instead of flashing a skeleton.
  const [loadedSlug, setLoadedSlug] = useState(null);
  const workspaceFetchSeqRef = useRef(0);
  const workspaceRef = useRef(workspace);
  const loadedSlugRef = useRef(loadedSlug);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    loadedSlugRef.current = loadedSlug;
  }, [loadedSlug]);

  useEffect(() => {
    const seq = workspaceFetchSeqRef.current + 1;
    workspaceFetchSeqRef.current = seq;
    const startedAt = performance.now();
    const retainedWorkspaceSlug = workspaceRef.current?.slug || null;
    debugWorkspaceSwitchFlicker("WorkspaceChatPage:workspaceFetchStart", {
      seq,
      targetSlug: slug,
      retainedWorkspaceSlug,
      retainedUntilReady:
        !!retainedWorkspaceSlug && retainedWorkspaceSlug !== slug,
      loadedSlug: loadedSlugRef.current,
    });

    async function getWorkspace() {
      if (!slug) return;
      let _workspace = null;
      try {
        _workspace = await Workspace.bySlug(slug);
      } catch (error) {
        if (workspaceFetchSeqRef.current !== seq) {
          debugWorkspaceSwitchFlicker("WorkspaceChatPage:workspaceFetchStale", {
            seq,
            targetSlug: slug,
            durationMs: Math.round(performance.now() - startedAt),
            reason: "failed-after-newer-request",
          });
          return;
        }
        debugWorkspaceSwitchFlicker("WorkspaceChatPage:workspaceFetchFailed", {
          seq,
          targetSlug: slug,
          durationMs: Math.round(performance.now() - startedAt),
          message: error?.message || String(error),
          retainedWorkspaceSlug,
        });
        console.error(error);
        setWorkspace(null);
        setLoadedSlug(slug);
        return;
      }

      if (workspaceFetchSeqRef.current !== seq) {
        debugWorkspaceSwitchFlicker("WorkspaceChatPage:workspaceFetchStale", {
          seq,
          targetSlug: slug,
          durationMs: Math.round(performance.now() - startedAt),
          reason: "workspace-loaded-after-newer-request",
          loadedWorkspaceSlug: _workspace?.slug || null,
        });
        return;
      }

      if (!_workspace) {
        debugWorkspaceSwitchFlicker("WorkspaceChatPage:workspaceFetchFailed", {
          seq,
          targetSlug: slug,
          durationMs: Math.round(performance.now() - startedAt),
          reason: "not-found",
          retainedWorkspaceSlug,
        });
        setWorkspace(null);
        setLoadedSlug(slug);
        return;
      }

      let suggestedMessages = [];
      let showAgentCommand = false;
      try {
        [suggestedMessages, { showAgentCommand }] = await Promise.all([
          Workspace.getSuggestedMessages(slug),
          Workspace.agentCommandAvailable(slug),
        ]);
      } catch (error) {
        if (workspaceFetchSeqRef.current !== seq) {
          debugWorkspaceSwitchFlicker("WorkspaceChatPage:workspaceFetchStale", {
            seq,
            targetSlug: slug,
            durationMs: Math.round(performance.now() - startedAt),
            reason: "workspace-extras-failed-after-newer-request",
          });
          return;
        }
        debugWorkspaceSwitchFlicker("WorkspaceChatPage:workspaceFetchFailed", {
          seq,
          targetSlug: slug,
          durationMs: Math.round(performance.now() - startedAt),
          message: error?.message || String(error),
          reason: "workspace-extras-failed",
          retainedWorkspaceSlug,
        });
        console.error(error);
        setWorkspace(null);
        setLoadedSlug(slug);
        return;
      }

      const nextWorkspace = {
        ..._workspace,
        suggestedMessages,
        showAgentCommand,
      };

      if (workspaceFetchSeqRef.current !== seq) {
        debugWorkspaceSwitchFlicker("WorkspaceChatPage:workspaceFetchStale", {
          seq,
          targetSlug: slug,
          durationMs: Math.round(performance.now() - startedAt),
          reason: "workspace-extras-loaded-after-newer-request",
          loadedWorkspaceSlug: nextWorkspace.slug,
        });
        return;
      }

      setWorkspace(nextWorkspace);
      setLoadedSlug(slug);
      warmWorkspaceChat(_workspace.slug);
      debugWorkspaceSwitchFlicker("WorkspaceChatPage:workspaceFetchLoaded", {
        seq,
        targetSlug: slug,
        loadedWorkspaceSlug: nextWorkspace.slug,
        durationMs: Math.round(performance.now() - startedAt),
        retainedWorkspaceSlug,
        retainedUntilReady:
          !!retainedWorkspaceSlug &&
          retainedWorkspaceSlug !== nextWorkspace.slug,
        suggestedMessageCount: suggestedMessages?.length || 0,
        showAgentCommand,
      });
    }
    getWorkspace();
  }, [slug]);

  useEffect(() => {
    if (!workspace?.slug || workspace.slug !== slug) return;
    rememberLastVisitedWorkspace(workspace, threadSlug);
  }, [slug, threadSlug, workspace]);

  return (
    <WorkspaceChatContainer
      loading={loadedSlug !== slug}
      workspace={workspace}
    />
  );
}
