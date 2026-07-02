import React, { useEffect, useRef, useState } from "react";
import { default as WorkspaceChatContainer } from "@/components/WorkspaceChat";
import { useParams } from "react-router-dom";
import Workspace from "@/models/workspace";
import PasswordModal, {
  AuthBootstrapError,
  usePasswordModal,
} from "@/components/Modals/Password";
import { FullScreenLoader } from "@/components/Preloader";
import { warmWorkspaceChat } from "@/utils/chat/workspaceChatPrefetch";
import { rememberLastVisitedWorkspace } from "@/utils/lastVisitedWorkspace";
import { useWorkspaceLayout } from "@/contexts/WorkspaceLayoutProvider";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { mobileRuntimeActive } from "@/utils/mobileRuntime";

const MobileWebPwa = React.lazy(() =>
  import("@/components/MobileWeb").then((module) => ({
    default: module.MobileWebPwa,
  }))
);

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

function delayUnlessAborted(ms, signal) {
  if (signal?.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

export default function WorkspaceChat() {
  const { loading, requiresAuth, mode, error } = usePasswordModal();
  const { slug, threadSlug = null } = useParams();

  if (loading) return <FullScreenLoader />;
  if (error) return <AuthBootstrapError message={error} />;
  if (requiresAuth !== false) {
    return <>{requiresAuth !== null && <PasswordModal mode={mode} />}</>;
  }

  if (mobileRuntimeActive()) {
    return (
      <React.Suspense fallback={<FullScreenLoader />}>
        <MobileWebPwa
          initialWorkspaceSlug={slug}
          initialThreadSlug={threadSlug}
        />
      </React.Suspense>
    );
  }

  return <ShowWorkspaceChat />;
}

function ShowWorkspaceChat() {
  const { slug, threadSlug = null } = useParams();
  const workspaceLayout = useWorkspaceLayout();
  const dispatchLayoutEvent = workspaceLayout?.dispatchLayoutEvent;
  const [workspace, setWorkspace] = useState(null);
  // Tracks which workspace `workspace` belongs to. While a new workspace's
  // data is in flight, we keep the previous workspace's chat mounted
  // (Slack/Linear-style transition) instead of flashing a skeleton.
  const [loadedSlug, setLoadedSlug] = useState(null);
  const workspaceFetchSeqRef = useRef(0);
  const workspaceFetchAbortRef = useRef(null);
  const workspaceRef = useRef(workspace);
  const loadedSlugRef = useRef(loadedSlug);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    loadedSlugRef.current = loadedSlug;
  }, [loadedSlug]);

  useEffect(() => {
    dispatchLayoutEvent?.({
      type: "WORKSPACE_CHANGED",
      workspaceId: slug || null,
    });
    dispatchLayoutEvent?.({
      type: "THREAD_CHANGED",
      threadId: threadSlug || null,
    });
  }, [dispatchLayoutEvent, slug, threadSlug]);

  useEffect(() => {
    const seq = workspaceFetchSeqRef.current + 1;
    workspaceFetchSeqRef.current = seq;
    workspaceFetchAbortRef.current?.abort();
    const controller = new AbortController();
    workspaceFetchAbortRef.current = controller;
    const startedAt = performance.now();
    const retainedWorkspaceSlug = workspaceRef.current?.slug || null;
    const isCurrent = () =>
      !controller.signal.aborted && workspaceFetchSeqRef.current === seq;
    const freshCachedWorkspace = workspaceNavigationCache.getWorkspaceDetail(
      slug,
      { allowStale: false }
    );
    if (freshCachedWorkspace) {
      workspaceNavigationCache.debug("workspace-detail:hit", {
        targetSlug: slug,
        ...workspaceNavigationCache.getWorkspaceDetailMeta(slug),
      });
      setWorkspace(freshCachedWorkspace);
      setLoadedSlug(slug);
      warmWorkspaceChat(slug);
      return () => {
        controller.abort();
      };
    }

    const staleCachedWorkspace =
      workspaceNavigationCache.getWorkspaceDetail(slug);
    if (staleCachedWorkspace) {
      workspaceNavigationCache.debug("workspace-detail:stale", {
        targetSlug: slug,
        ...workspaceNavigationCache.getWorkspaceDetailMeta(slug),
      });
      setWorkspace(staleCachedWorkspace);
      setLoadedSlug(slug);
    }

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
        _workspace = await workspaceNavigationCache.runInFlight(
          `workspace-detail:${slug}`,
          () =>
            requestPriorityQueue.schedule(
              () => Workspace.bySlug(slug, { signal: controller.signal }),
              {
                priority: staleCachedWorkspace ? "P3" : "P0",
                label: "workspacechat:workspace-detail",
                signal: controller.signal,
                dedupeKey: `workspace-detail:${slug}`,
              }
            )
        );
      } catch (error) {
        if (error?.name === "AbortError" || !isCurrent()) {
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
        if (staleCachedWorkspace) {
          setLoadedSlug(slug);
          return;
        }
        setWorkspace(null);
        setLoadedSlug(slug);
        return;
      }

      if (!isCurrent()) {
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
        if (staleCachedWorkspace) {
          setLoadedSlug(slug);
          return;
        }
        setWorkspace(null);
        setLoadedSlug(slug);
        return;
      }

      const nextWorkspace = {
        ..._workspace,
        suggestedMessages:
          _workspace.suggestedMessages ||
          staleCachedWorkspace?.suggestedMessages ||
          [],
        showAgentCommand:
          _workspace.showAgentCommand ??
          staleCachedWorkspace?.showAgentCommand ??
          true,
      };

      if (!isCurrent()) {
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
      workspaceNavigationCache.setWorkspaceDetail(slug, nextWorkspace);
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
        suggestedMessageCount: nextWorkspace.suggestedMessages?.length || 0,
        showAgentCommand: nextWorkspace.showAgentCommand,
      });

      requestPriorityQueue
        .schedule(
          async () => {
            await delayUnlessAborted(5_500, controller.signal);
            return workspaceNavigationCache.runInFlight(
              `workspace-detail-extras:${slug}`,
              () =>
                Promise.all([
                  Workspace.getSuggestedMessages(slug, {
                    signal: controller.signal,
                  }),
                  Workspace.agentCommandAvailable(slug, {
                    signal: controller.signal,
                  }),
                ])
            );
          },
          {
            priority: "P4",
            label: "workspacechat:workspace-extras",
            signal: controller.signal,
            dedupeKey: `workspace-detail-extras:${slug}`,
          }
        )
        .then(([suggestedMessages, { showAgentCommand } = {}] = []) => {
          if (!isCurrent()) return;
          setWorkspace((current) => {
            if (current?.slug !== slug) return current;
            const updated = {
              ...current,
              suggestedMessages: suggestedMessages || [],
              showAgentCommand: showAgentCommand ?? true,
            };
            workspaceNavigationCache.setWorkspaceDetail(slug, updated);
            return updated;
          });
        })
        .catch((error) => {
          if (error?.name === "AbortError" || !isCurrent()) return;
          console.error(error);
        });
    }
    getWorkspace();
    return () => {
      controller.abort();
    };
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
