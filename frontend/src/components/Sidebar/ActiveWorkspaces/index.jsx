import React, { useState, useEffect, useCallback, useRef } from "react";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import { useTranslation } from "react-i18next";
import Workspace from "@/models/workspace";
import ManageWorkspace, {
  useManageWorkspaceModal,
} from "../../Modals/ManageWorkspace";
import paths from "@/utils/paths";
import { Link, useParams, useNavigate, useMatch } from "react-router-dom";
import {
  CaretDown,
  CaretRight,
  GearSix,
  UploadSimple,
  DotsSixVertical,
} from "@phosphor-icons/react";
import ThreadContainer from "./ThreadContainer";
import { DragDropContext, Droppable, Draggable } from "react-beautiful-dnd";
import showToast from "@/utils/toast";
import {
  clearLastVisitedThread,
  getLastVisitedWorkspace,
  pathForLastVisitedThread,
  rememberLastVisitedWorkspace,
} from "@/utils/lastVisitedWorkspace";
import {
  dispatchThreadMoveVisual,
  WORKSPACE_CREATE_VISUAL_EVENT,
  WORKSPACE_DELETE_ANIMATION_MS,
  WORKSPACE_DELETE_VISUAL_EVENT,
  WORKSPACE_PATCH_VISUAL_EVENT,
  WORKSPACES_RESTORE_VISUAL_EVENT,
  WORKSPACES_REFRESH_EVENT,
} from "@/utils/workspaceEvents";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { guardGlobalRefresh } from "@/utils/globalRefreshPolicy";
import { markLoginBoot } from "@/utils/loginBootPerf";
import { markTaskPerformance } from "@/utils/tasks/taskScheduler";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";

const WORKSPACE_DND_TYPE = "WORKSPACE";
const THREAD_DND_TYPE = "THREAD";
const WORKSPACE_DROP_PREFIX = "workspace-drop:";
const THREAD_DRAG_PREFIX = "thread:";
const NAV_BOOT_REFRESH_COALESCE_MS = 1_500;
const NAV_DUPLICATE_REUSE_MS = 1_500;

function threadDraggableId(workspaceSlug, threadSlug) {
  return `${THREAD_DRAG_PREFIX}${workspaceSlug}:${threadSlug}`;
}

function parseThreadDraggableId(draggableId = "") {
  if (!draggableId.startsWith(THREAD_DRAG_PREFIX)) return null;
  const [, workspaceSlug, ...threadSlugParts] = draggableId.split(":");
  const threadSlug = threadSlugParts.join(":");
  if (!workspaceSlug || !threadSlug) return null;
  return { sourceWorkspaceSlug: workspaceSlug, threadSlug };
}

function parseWorkspaceDropId(droppableId = "") {
  if (!droppableId.startsWith(WORKSPACE_DROP_PREFIX)) return null;
  return droppableId.slice(WORKSPACE_DROP_PREFIX.length) || null;
}

export default function ActiveWorkspaces() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { slug } = useParams();
  const [loading, setLoading] = useState(true);
  const [navigationUnavailable, setNavigationUnavailable] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState({});
  const [creatingWorkspaces, setCreatingWorkspaces] = useState({});
  const [deletingWorkspaces, setDeletingWorkspaces] = useState({});
  const [selectedWs, setSelectedWs] = useState(null);
  const [draggingThread, setDraggingThread] = useState(null);
  const { showing, showModal, hideModal } = useManageWorkspaceModal();
  const isInWorkspaceSettings = !!useMatch("/workspace/:slug/settings/*");
  const isHomePage = !!useMatch("/");
  const refreshInFlightRef = useRef(null);
  const pendingForceRefreshRef = useRef(false);
  const pendingRefreshTimerRef = useRef(null);
  const navigationRetryAttemptRef = useRef(0);
  const deleteAnimationTimersRef = useRef(new Map());
  const bootCoalesceUntilRef = useRef(
    typeof window === "undefined"
      ? 0
      : window.performance.now() + NAV_BOOT_REFRESH_COALESCE_MS
  );

  const refreshWorkspaces = useCallback(async ({ force = false } = {}) => {
    if (refreshInFlightRef.current) {
      if (force) pendingForceRefreshRef.current = true;
      return refreshInFlightRef.current;
    }

    const inBootCoalesceWindow =
      typeof window !== "undefined" &&
      window.performance.now() < bootCoalesceUntilRef.current;
    if (force && inBootCoalesceWindow) {
      const freshDuringBoot = workspaceNavigationCache.getWorkspaces({
        allowStale: false,
      });
      if (Array.isArray(freshDuringBoot)) {
        pendingForceRefreshRef.current = true;
        setWorkspaces(Workspace.orderWorkspaces(freshDuringBoot));
        setLoading(false);
        return freshDuringBoot;
      }
    }

    const run = (async () => {
      const fresh = workspaceNavigationCache.getWorkspaces({
        allowStale: false,
      });
      if (!force && Array.isArray(fresh)) {
        workspaceNavigationCache.debug("workspaces:hit", {
          ...workspaceNavigationCache.getWorkspacesMeta(),
        });
        setLoading(false);
        setWorkspaces(Workspace.orderWorkspaces(fresh));
        performance?.mark?.("athena:workspace-switch:sidebar_ready");
        markLoginBoot("workspaces_loaded", {
          source: "cache",
          count: fresh.length,
        });
        return fresh;
      }

      const stale = workspaceNavigationCache.getWorkspaces();
      if (Array.isArray(stale)) {
        workspaceNavigationCache.debug("workspaces:stale", {
          force,
          ...workspaceNavigationCache.getWorkspacesMeta(),
        });
        setLoading(false);
        setWorkspaces(Workspace.orderWorkspaces(stale));
        performance?.mark?.("athena:workspace-switch:sidebar_ready");
        markTaskPerformance("sidebar_ready", {
          source: "cache",
          count: stale.length,
        });
      } else {
        workspaceNavigationCache.debug("workspaces:miss", { force });
        setLoading(true);
      }

      let workspaces;
      try {
        workspaces = await workspaceNavigationCache.runInFlight(
          "workspaces:all",
          ({ signal } = {}) =>
            Workspace.all({
              signal,
              task: false,
              preferSyncV2Cache: !force,
              throwOnError: true,
            }),
          {
            reuseResolvedWithinMs: force ? 0 : NAV_DUPLICATE_REUSE_MS,
            priority: "P0",
            label: "navigation:workspaces",
            scope: { route: "workspace-sidebar", surface: "workspaces" },
            policy: "foreground",
            emergency: false,
            intentRank: 0,
            dedupeKey: "navigation:workspaces",
          }
        );
      } catch (error) {
        if (error?.name === "AbortError") return null;
        setNavigationUnavailable(true);
        setLoading(false);
        navigationRetryAttemptRef.current += 1;
        const retryDelayMs = Math.min(
          2_000 * 2 ** Math.min(navigationRetryAttemptRef.current - 1, 3),
          10_000
        );
        if (pendingRefreshTimerRef.current) {
          window.clearTimeout(pendingRefreshTimerRef.current);
        }
        pendingRefreshTimerRef.current = window.setTimeout(() => {
          pendingRefreshTimerRef.current = null;
          refreshWorkspaces({ force: true });
        }, retryDelayMs);
        return stale || null;
      }
      if (!workspaces) return null;
      navigationRetryAttemptRef.current = 0;
      setNavigationUnavailable(false);
      workspaceNavigationCache.setWorkspaces(workspaces);
      setLoading(false);
      setWorkspaces(Workspace.orderWorkspaces(workspaces));
      performance?.mark?.("athena:workspace-switch:sidebar_ready");
      markTaskPerformance("sidebar_ready", {
        source: "network",
        count: workspaces.length,
      });
      markLoginBoot("workspaces_loaded", {
        source: "network",
        count: workspaces.length,
        force,
      });
      return workspaces;
    })();

    refreshInFlightRef.current = run.finally(() => {
      refreshInFlightRef.current = null;
      if (!pendingForceRefreshRef.current) return;
      pendingForceRefreshRef.current = false;
      const delayMs =
        typeof window === "undefined"
          ? 0
          : Math.max(
              0,
              bootCoalesceUntilRef.current - window.performance.now()
            );
      if (pendingRefreshTimerRef.current) {
        window.clearTimeout(pendingRefreshTimerRef.current);
      }
      pendingRefreshTimerRef.current = window.setTimeout(() => {
        pendingRefreshTimerRef.current = null;
        refreshWorkspaces({ force: true });
      }, delayMs);
    });

    return refreshInFlightRef.current;
  }, []);

  useEffect(() => {
    const clearDeleteAnimationTimer = (workspaceSlug) => {
      const timer = deleteAnimationTimersRef.current.get(workspaceSlug);
      if (!timer) return;
      window.clearTimeout(timer);
      deleteAnimationTimersRef.current.delete(workspaceSlug);
    };

    const removeWorkspaceFromState = (workspaceSlug) => {
      workspaceNavigationCache.removeWorkspace(workspaceSlug);
      setWorkspaces((prevWorkspaces) =>
        prevWorkspaces.filter((workspace) => workspace.slug !== workspaceSlug)
      );
      setDeletingWorkspaces((prev) => {
        if (!prev[workspaceSlug]) return prev;
        const next = { ...prev };
        delete next[workspaceSlug];
        return next;
      });
    };

    const upsertWorkspaceInState = (
      workspace,
      { animate = true, replaceSlug = null } = {}
    ) => {
      if (!workspace?.slug) return;
      setWorkspaces((prevWorkspaces) => {
        const nextWorkspaces = [
          workspace,
          ...prevWorkspaces.filter(
            (existingWorkspace) =>
              existingWorkspace.slug !== workspace.slug &&
              existingWorkspace.slug !== replaceSlug &&
              existingWorkspace.id !== workspace.id
          ),
        ];
        workspaceNavigationCache.setWorkspaces(nextWorkspaces);
        return nextWorkspaces;
      });
      if (!animate) return;
      setCreatingWorkspaces((prev) => ({
        ...prev,
        [workspace.slug]: true,
      }));
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setCreatingWorkspaces((prev) => {
            if (!prev[workspace.slug]) return prev;
            const next = { ...prev };
            delete next[workspace.slug];
            return next;
          });
        });
      });
    };

    const patchWorkspaceInState = (workspace) => {
      if (!workspace?.slug) return;
      setWorkspaces((prevWorkspaces) => {
        let found = false;
        const nextWorkspaces = prevWorkspaces.map((existingWorkspace) => {
          const isMatch =
            existingWorkspace.slug === workspace.slug ||
            (workspace.id && existingWorkspace.id === workspace.id);
          if (!isMatch) return existingWorkspace;
          found = true;
          return { ...existingWorkspace, ...workspace };
        });
        const resolvedWorkspaces = found
          ? nextWorkspaces
          : [workspace, ...prevWorkspaces];
        workspaceNavigationCache.setWorkspaces(resolvedWorkspaces);
        return resolvedWorkspaces;
      });
      const detail = workspaceNavigationCache.getWorkspaceDetail(
        workspace.slug,
        { allowStale: true }
      );
      workspaceNavigationCache.setWorkspaceDetail(workspace.slug, {
        ...(detail || {}),
        ...workspace,
      });
    };

    const scheduleWorkspaceRemoval = (
      workspaceSlug,
      { animate = true, navigateAfter = false } = {}
    ) => {
      if (!workspaceSlug) return;
      clearDeleteAnimationTimer(workspaceSlug);
      if (!animate) {
        removeWorkspaceFromState(workspaceSlug);
        if (navigateAfter) navigate(paths.home(), { replace: true });
        return;
      }
      setDeletingWorkspaces((prev) => ({ ...prev, [workspaceSlug]: true }));
      const timer = window.setTimeout(() => {
        deleteAnimationTimersRef.current.delete(workspaceSlug);
        removeWorkspaceFromState(workspaceSlug);
        if (navigateAfter) navigate(paths.home(), { replace: true });
      }, WORKSPACE_DELETE_ANIMATION_MS);
      deleteAnimationTimersRef.current.set(workspaceSlug, timer);
    };

    const handleWorkspaceDeleteVisual = (event) => {
      const workspaceSlug = event.detail?.workspaceSlug;
      if (!workspaceSlug) return;
      scheduleWorkspaceRemoval(workspaceSlug, {
        animate: event.detail?.animate !== false,
        navigateAfter: workspaceSlug === slug,
      });
    };

    const handleWorkspaceCreateVisual = (event) => {
      const workspace = event.detail?.workspace;
      if (!workspace?.slug) return;
      upsertWorkspaceInState(workspace, {
        animate: event.detail?.animate !== false,
        replaceSlug: event.detail?.replaceSlug || null,
      });
    };

    const handleWorkspacePatchVisual = (event) => {
      const workspace =
        event.detail?.workspace ||
        (event.detail?.workspaceSlug
          ? {
              slug: event.detail.workspaceSlug,
              name: event.detail.workspaceName,
            }
          : null);
      if (!workspace?.slug) return;
      patchWorkspaceInState(workspace);
    };

    const handleWorkspacesRestoreVisual = (event) => {
      const restoredWorkspaces = event.detail?.workspaces;
      if (!Array.isArray(restoredWorkspaces)) return;
      const restoredWorkspaceSlug = event.detail?.restoredWorkspaceSlug;
      if (restoredWorkspaceSlug) {
        clearDeleteAnimationTimer(restoredWorkspaceSlug);
        setDeletingWorkspaces((prev) => {
          if (!prev[restoredWorkspaceSlug]) return prev;
          const next = { ...prev };
          delete next[restoredWorkspaceSlug];
          return next;
        });
      }
      workspaceNavigationCache.setWorkspaces(restoredWorkspaces);
      setWorkspaces(Workspace.orderWorkspaces(restoredWorkspaces));
      const restoredWorkspace = event.detail?.workspace;
      if (restoredWorkspace?.slug) {
        workspaceNavigationCache.setWorkspaceDetail(
          restoredWorkspace.slug,
          restoredWorkspace
        );
      }
    };

    const handleWorkspacesRefresh = (event) => {
      const detail = event?.detail || {};
      const restoredWorkspaces = event.detail?.restoredWorkspaces;
      const restoredWorkspaceSlug = event.detail?.restoredWorkspaceSlug;
      if (restoredWorkspaceSlug) {
        clearDeleteAnimationTimer(restoredWorkspaceSlug);
        setDeletingWorkspaces((prev) => {
          if (!prev[restoredWorkspaceSlug]) return prev;
          const next = { ...prev };
          delete next[restoredWorkspaceSlug];
          return next;
        });
      }
      if (Array.isArray(restoredWorkspaces)) {
        setWorkspaces(Workspace.orderWorkspaces(restoredWorkspaces));
        if (event.detail?.skipRefresh) return;
      }

      const deletedWorkspaceSlug = event.detail?.deletedWorkspaceSlug;
      if (deletedWorkspaceSlug) {
        scheduleWorkspaceRemoval(deletedWorkspaceSlug, {
          animate: event.detail?.animate !== false,
          navigateAfter: deletedWorkspaceSlug === slug,
        });
      }

      const workspace = event.detail?.workspace;
      if (workspace?.id) {
        if (workspace.slug)
          workspaceNavigationCache.invalidateWorkspaceDetail(workspace.slug);
        setWorkspaces((prevWorkspaces) => {
          const workspaceExists = prevWorkspaces.some(
            (existingWorkspace) => existingWorkspace.id === workspace.id
          );
          if (workspaceExists) {
            const nextWorkspaces = prevWorkspaces.map((existingWorkspace) =>
              existingWorkspace.id === workspace.id
                ? { ...existingWorkspace, ...workspace }
                : existingWorkspace
            );
            workspaceNavigationCache.setWorkspaces(nextWorkspaces);
            return nextWorkspaces;
          }
          const nextWorkspaces = [...prevWorkspaces, workspace];
          workspaceNavigationCache.setWorkspaces(nextWorkspaces);
          return nextWorkspaces;
        });
      }
      if (event.detail?.skipRefresh) return;
      const guard = guardGlobalRefresh({
        detail,
        path: WORKSPACES_REFRESH_EVENT,
        source: "active-workspaces",
      });
      if (!guard.allowed) return;
      refreshWorkspaces({ force: !!event.detail?.force });
    };

    refreshWorkspaces();
    window.addEventListener(
      WORKSPACE_CREATE_VISUAL_EVENT,
      handleWorkspaceCreateVisual
    );
    window.addEventListener(
      WORKSPACE_PATCH_VISUAL_EVENT,
      handleWorkspacePatchVisual
    );
    window.addEventListener(WORKSPACES_REFRESH_EVENT, handleWorkspacesRefresh);
    window.addEventListener(
      WORKSPACES_RESTORE_VISUAL_EVENT,
      handleWorkspacesRestoreVisual
    );
    window.addEventListener(
      WORKSPACE_DELETE_VISUAL_EVENT,
      handleWorkspaceDeleteVisual
    );
    return () => {
      if (pendingRefreshTimerRef.current) {
        window.clearTimeout(pendingRefreshTimerRef.current);
        pendingRefreshTimerRef.current = null;
      }
      for (const timer of deleteAnimationTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      deleteAnimationTimersRef.current.clear();
      window.removeEventListener(
        WORKSPACES_REFRESH_EVENT,
        handleWorkspacesRefresh
      );
      window.removeEventListener(
        WORKSPACES_RESTORE_VISUAL_EVENT,
        handleWorkspacesRestoreVisual
      );
      window.removeEventListener(
        WORKSPACE_CREATE_VISUAL_EVENT,
        handleWorkspaceCreateVisual
      );
      window.removeEventListener(
        WORKSPACE_PATCH_VISUAL_EVENT,
        handleWorkspacePatchVisual
      );
      window.removeEventListener(
        WORKSPACE_DELETE_VISUAL_EVENT,
        handleWorkspaceDeleteVisual
      );
    };
  }, [navigate, refreshWorkspaces, slug]);

  if (loading) {
    return (
      <Skeleton.default
        height={40}
        width="100%"
        count={5}
        baseColor="var(--theme-sidebar-item-default)"
        highlightColor="var(--theme-sidebar-item-hover)"
        enableAnimation={true}
        className="my-1"
      />
    );
  }

  /**
   * Reorders workspaces in the UI via localstorage on client side.
   * @param {number} startIndex - the index of the workspace to move
   * @param {number} endIndex - the index to move the workspace to
   */
  function reorderWorkspaces(startIndex, endIndex) {
    const previousWorkspaces = workspaces;
    const reorderedWorkspaces = Array.from(workspaces);
    const [removed] = reorderedWorkspaces.splice(startIndex, 1);
    reorderedWorkspaces.splice(endIndex, 0, removed);
    const action = optimisticActionCenter.run({
      type: "workspace.reorder",
      scope: {
        route: "workspace-sidebar",
        surface: "workspaces",
      },
      priority: "P0",
      policy: "foreground",
      intentRank: 0,
      protected: true,
      abortable: false,
      label: "optimistic:workspace-reorder",
      dedupeKey: "optimistic:workspace-reorder",
      optimisticPatch: () => {
        setWorkspaces(reorderedWorkspaces);
        workspaceNavigationCache.setWorkspaces(reorderedWorkspaces);
      },
      rollbackPatch: () => {
        setWorkspaces(previousWorkspaces);
        workspaceNavigationCache.setWorkspaces(previousWorkspaces);
      },
      serverCall: async () => {
        const success = Workspace.storeWorkspaceOrder(
          reorderedWorkspaces.map((w) => w.id)
        );
        if (!success) throw new Error("workspace order sync failed");
        return true;
      },
    });
    void action.promise.then((outcome) => {
      if (!outcome.ok) showToast("Failed to reorder workspaces", "error");
    });
  }

  const onDragStart = (start) => {
    if (start.type !== THREAD_DND_TYPE) {
      setDraggingThread(null);
      return;
    }
    setDraggingThread(parseThreadDraggableId(start.draggableId));
  };

  const onDragEnd = async (result) => {
    setDraggingThread(null);
    if (!result.destination) return;

    if (result.type === WORKSPACE_DND_TYPE) {
      reorderWorkspaces(result.source.index, result.destination.index);
      return;
    }

    if (result.type !== THREAD_DND_TYPE) return;
    const draggedThread = parseThreadDraggableId(result.draggableId);
    const targetWorkspaceSlug = parseWorkspaceDropId(
      result.destination.droppableId
    );
    if (!draggedThread || !targetWorkspaceSlug) return;
    if (draggedThread.sourceWorkspaceSlug === targetWorkspaceSlug) return;

    const targetWorkspace = workspaces.find(
      (workspace) => workspace.slug === targetWorkspaceSlug
    );
    if (!targetWorkspace) {
      showToast("Target workspace is no longer available.", "error", {
        clear: true,
      });
      return;
    }

    const sourceThreadsBefore =
      workspaceNavigationCache.getThreads(draggedThread.sourceWorkspaceSlug) ||
      [];
    const targetThreadsBefore =
      workspaceNavigationCache.getThreads(targetWorkspaceSlug) || [];
    const threadToMove = sourceThreadsBefore.find(
      (thread) => thread?.slug === draggedThread.threadSlug
    );
    const action = optimisticActionCenter.run({
      type: "thread.move",
      scope: {
        route: "workspace-sidebar",
        surface: "threads",
        workspaceSlug: draggedThread.sourceWorkspaceSlug,
        threadSlug: draggedThread.threadSlug,
        targetWorkspaceSlug,
      },
      priority: "P0",
      policy: "foreground",
      intentRank: 1,
      protected: true,
      abortable: false,
      label: "optimistic:thread-move",
      dedupeKey: `optimistic:thread-move:${draggedThread.sourceWorkspaceSlug}:${draggedThread.threadSlug}:${targetWorkspaceSlug}`,
      optimisticPatch: () => {
        if (!threadToMove) return;
        workspaceNavigationCache.setThreads(
          draggedThread.sourceWorkspaceSlug,
          sourceThreadsBefore.filter(
            (thread) => thread?.slug !== draggedThread.threadSlug
          )
        );
        workspaceNavigationCache.setThreads(targetWorkspaceSlug, [
          threadToMove,
          ...targetThreadsBefore.filter(
            (thread) => thread?.slug !== draggedThread.threadSlug
          ),
        ]);
        dispatchThreadMoveVisual({
          threadSlug: draggedThread.threadSlug,
          sourceWorkspaceSlug: draggedThread.sourceWorkspaceSlug,
          targetWorkspaceSlug,
          thread: threadToMove,
          source: "local",
        });
      },
      rollbackPatch: () => {
        workspaceNavigationCache.setThreads(
          draggedThread.sourceWorkspaceSlug,
          sourceThreadsBefore
        );
        workspaceNavigationCache.setThreads(
          targetWorkspaceSlug,
          targetThreadsBefore
        );
        dispatchThreadMoveVisual({
          threadSlug: draggedThread.threadSlug,
          sourceWorkspaceSlug: targetWorkspaceSlug,
          targetWorkspaceSlug: draggedThread.sourceWorkspaceSlug,
          thread: threadToMove,
          source: "local-rollback",
        });
      },
      confirmPatch: ({ result }) => {
        if (result?.thread?.slug)
          workspaceNavigationCache.updateThread(
            targetWorkspaceSlug,
            result.thread
          );
      },
      serverCall: async ({ signal }) => {
        const resultPayload = await Workspace.threads.move(
          draggedThread.sourceWorkspaceSlug,
          draggedThread.threadSlug,
          targetWorkspaceSlug,
          {
            signal,
            communicationScene: "workspace-navigation",
            task: false,
          }
        );
        if (!resultPayload.success) {
          throw new Error(resultPayload.error || "Unknown error");
        }
        return resultPayload;
      },
    });
    const outcome = await action.promise;
    const resultPayload = outcome.result;
    if (!outcome.ok || !resultPayload?.success) {
      showToast(
        `Could not move thread - ${
          outcome.error?.message || resultPayload?.error || "Unknown error"
        }`,
        "error",
        { clear: true }
      );
      return;
    }

    clearLastVisitedThread(
      draggedThread.sourceWorkspaceSlug,
      draggedThread.threadSlug
    );
    rememberLastVisitedWorkspace(targetWorkspace, draggedThread.threadSlug);
    navigate(
      paths.workspace.thread(targetWorkspaceSlug, draggedThread.threadSlug),
      {
        state: { userSelectedThread: true },
      }
    );
    showToast("Thread moved.", "success", { clear: true });
  };

  function toggleWorkspaceThreads(workspaceSlug) {
    setCollapsedWorkspaces((prev) => ({
      ...prev,
      [workspaceSlug]: !prev[workspaceSlug],
    }));
  }

  function expandWorkspaceThreads(workspaceSlug) {
    setCollapsedWorkspaces((prev) => {
      if (!prev[workspaceSlug]) return prev;
      return { ...prev, [workspaceSlug]: false };
    });
  }

  const lastVisitedWorkspace = isHomePage ? getLastVisitedWorkspace() : null;
  const hasValidLastVisitedWorkspace =
    !!lastVisitedWorkspace?.slug &&
    workspaces.some((ws) => ws.slug === lastVisitedWorkspace.slug);

  // When on the home page, resolve which workspace should be virtually active
  const virtualActiveSlug = (() => {
    if (!isHomePage || workspaces.length === 0) return null;
    if (
      lastVisitedWorkspace?.slug &&
      workspaces.some((ws) => ws.slug === lastVisitedWorkspace.slug)
    )
      return lastVisitedWorkspace.slug;
    return workspaces[0]?.slug ?? null;
  })();

  return (
    <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <Droppable droppableId="workspaces" type={WORKSPACE_DND_TYPE}>
        {(provided) => (
          <div
            role="list"
            aria-label="Workspaces"
            className="flex flex-col gap-y-2"
            ref={provided.innerRef}
            {...provided.droppableProps}
          >
            {navigationUnavailable ? (
              <div
                role="status"
                className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-xs leading-5 text-amber-100 light:text-amber-800"
              >
                工作区数据暂时不可用，已保留上次可信列表。
              </div>
            ) : null}
            {workspaces.map((workspace, index) => {
              const isVirtuallyActive = workspace.slug === virtualActiveSlug;
              const isActive = workspace.slug === slug || isVirtuallyActive;
              const isCollapsed = !!collapsedWorkspaces[workspace.slug];
              const isCreating = !!creatingWorkspaces[workspace.slug];
              const isDeleting = !!deletingWorkspaces[workspace.slug];
              return (
                <Draggable
                  key={workspace.id}
                  draggableId={`workspace:${workspace.id}`}
                  index={index}
                >
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      className={`flex flex-col w-full group origin-center transition-[opacity,max-height,transform,margin] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
                        isDeleting
                          ? "overflow-hidden opacity-0 max-h-0 scale-x-0 scale-y-75 -translate-y-1 pointer-events-none"
                          : isCreating
                            ? "overflow-hidden opacity-0 max-h-0 scale-95 translate-y-1"
                            : "overflow-visible opacity-100 max-h-[999px] scale-x-100 scale-y-100 translate-y-0"
                      } ${snapshot.isDragging ? "opacity-50" : ""}`}
                      role="listitem"
                    >
                      <Droppable
                        droppableId={`${WORKSPACE_DROP_PREFIX}${workspace.slug}`}
                        type={THREAD_DND_TYPE}
                        isDropDisabled={
                          draggingThread?.sourceWorkspaceSlug === workspace.slug
                        }
                      >
                        {(dropProvided, dropSnapshot) => (
                          <div
                            ref={dropProvided.innerRef}
                            {...dropProvided.droppableProps}
                            className={`flex gap-x-2 items-center justify-between rounded-[4px] ${
                              dropSnapshot.isDraggingOver
                                ? "ring-2 ring-sky-400/80 light:ring-blue-500"
                                : ""
                            }`}
                          >
                            <Link
                              to={pathForLastVisitedThread(workspace.slug)}
                              onClick={(event) => {
                                if (event.defaultPrevented) return;
                                if (isActive) {
                                  event.preventDefault();
                                  toggleWorkspaceThreads(workspace.slug);
                                  return;
                                }
                                expandWorkspaceThreads(workspace.slug);
                              }}
                              aria-expanded={
                                isActive ? !isCollapsed : undefined
                              }
                              aria-current={isActive ? "page" : ""}
                              className={`
                                motion-hover duration-[200ms]
                                flex flex-grow w-[75%] gap-x-2 py-[6px] pl-[4px] pr-[6px] rounded-[4px] text-white justify-start items-center
                                bg-theme-sidebar-item-default
                                ${isActive ? "light:bg-blue-200 font-bold" : "hover:bg-theme-sidebar-subitem-hover light:hover:bg-slate-300"}
                              `}
                            >
                              <div className="flex flex-row justify-between w-full items-center">
                                <div
                                  {...provided.dragHandleProps}
                                  className="cursor-grab mr-[3px]"
                                >
                                  <DotsSixVertical
                                    size={20}
                                    className={`${isActive ? "text-white light:text-blue-800" : ""}`}
                                    weight="bold"
                                  />
                                </div>
                                <div className="w-[16px] h-[16px] flex items-center justify-center shrink-0">
                                  {isCollapsed ? (
                                    <CaretRight
                                      size={14}
                                      weight="bold"
                                      className={`${isActive ? "text-white light:text-blue-800" : "text-zinc-400 light:text-slate-600"}`}
                                    />
                                  ) : (
                                    <CaretDown
                                      size={14}
                                      weight="bold"
                                      className={`${isActive ? "text-white light:text-blue-800" : "text-zinc-400 light:text-slate-600"}`}
                                    />
                                  )}
                                </div>
                                <div
                                  data-tooltip-id="workspace-name"
                                  data-tooltip-content={workspace.name}
                                  className="flex items-center space-x-2 overflow-hidden flex-grow"
                                >
                                  <div className="w-[130px] overflow-hidden">
                                    <p
                                      className={`
                                      text-[14px] leading-loose whitespace-nowrap overflow-hidden
                                      ${isActive ? "font-bold text-white light:text-blue-900" : "font-medium "} truncate
                                      w-full group-hover:w-[130px] group-hover:`}
                                    >
                                      {workspace.name}
                                    </p>
                                  </div>
                                </div>
                                <div
                                  className={`flex items-center gap-x-[2px] motion-hover ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      setSelectedWs(workspace);
                                      showModal();
                                    }}
                                    data-tooltip-id="upload-workspace"
                                    data-tooltip-content={t(
                                      "chat_window.controls.upload.workspaceDescription"
                                    )}
                                    aria-label={t(
                                      "chat_window.controls.upload.workspaceDescription"
                                    )}
                                    className={`group/upload border-none rounded-md flex items-center justify-center ml-auto p-[2px] ${isActive ? "hover:bg-zinc-500 light:hover:bg-sky-800/30" : "hover:bg-zinc-500 light:hover:bg-slate-400"}`}
                                  >
                                    <UploadSimple
                                      className={`h-[20px] w-[20px] ${isActive ? "text-zinc-400 hover:text-white light:text-blue-700 light:group-hover/upload:text-blue-900" : "text-zinc-400 hover:text-white light:text-slate-600 light:group-hover/upload:text-slate-950"}`}
                                    />
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      navigate(
                                        isInWorkspaceSettings
                                          ? pathForLastVisitedThread(
                                              workspace.slug
                                            )
                                          : paths.workspace.settings.generalAppearance(
                                              workspace.slug
                                            )
                                      );
                                    }}
                                    className={`group/gear rounded-md flex items-center justify-center ml-auto p-[2px] ${isActive ? "hover:bg-zinc-500 light:hover:bg-sky-800/30" : "hover:bg-zinc-500 light:hover:bg-slate-400"}`}
                                    aria-label={t(
                                      "common.controls.workspaceSettings"
                                    )}
                                    data-tooltip-id="gear-workspace"
                                    data-tooltip-content={t(
                                      "common.controls.workspaceSettingsDescription"
                                    )}
                                  >
                                    <GearSix
                                      color={
                                        isInWorkspaceSettings &&
                                        workspace.slug === slug
                                          ? "#46C8FF"
                                          : undefined
                                      }
                                      className={`h-[20px] w-[20px] ${isActive ? "text-zinc-400 hover:text-white light:text-blue-700 light:group-hover/gear:text-blue-900" : "text-zinc-400 hover:text-white light:text-slate-600 light:group-hover/gear:text-slate-950"}`}
                                    />
                                  </button>
                                </div>
                              </div>
                            </Link>
                            <div className="hidden">
                              {dropProvided.placeholder}
                            </div>
                          </div>
                        )}
                      </Droppable>
                      {isActive && !isCollapsed && (
                        <ThreadContainer
                          workspace={workspace}
                          isActive={isActive}
                          threadDraggableId={threadDraggableId}
                          threadDndType={THREAD_DND_TYPE}
                          isVirtualThread={
                            isVirtuallyActive && !hasValidLastVisitedWorkspace
                          }
                        />
                      )}
                    </div>
                  )}
                </Draggable>
              );
            })}
            {provided.placeholder}
            {showing && (
              <ManageWorkspace
                hideModal={hideModal}
                providedSlug={selectedWs ? selectedWs.slug : null}
              />
            )}
          </div>
        )}
      </Droppable>
    </DragDropContext>
  );
}
