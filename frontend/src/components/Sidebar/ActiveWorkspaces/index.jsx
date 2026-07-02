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
import ThreadContainer, {
  WORKSPACE_THREADS_REFRESH_EVENT,
} from "./ThreadContainer";
import { DragDropContext, Droppable, Draggable } from "react-beautiful-dnd";
import showToast from "@/utils/toast";
import {
  clearLastVisitedThread,
  getLastVisitedWorkspace,
  pathForLastVisitedThread,
  rememberLastVisitedWorkspace,
} from "@/utils/lastVisitedWorkspace";
import { WORKSPACES_REFRESH_EVENT } from "@/utils/workspaceEvents";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { markLoginBoot } from "@/utils/loginBootPerf";
import { markTaskPerformance } from "@/utils/tasks/taskScheduler";

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

function refreshWorkspaceThreads(workspaceSlug) {
  if (!workspaceSlug) return;
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_THREADS_REFRESH_EVENT, {
      detail: { workspaceSlug },
    })
  );
}

function navigationWriteTask(label, workspaceSlug, scope = {}) {
  return {
    label,
    kind: "navigation",
    priority: "P0",
    policy: "foreground",
    protected: true,
    abortable: false,
    intentRank: 1,
    scope: {
      route: "workspace-sidebar",
      surface: "threads",
      workspaceSlug,
      ...scope,
    },
  };
}

export default function ActiveWorkspaces() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { slug } = useParams();
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState([]);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState({});
  const [selectedWs, setSelectedWs] = useState(null);
  const [draggingThread, setDraggingThread] = useState(null);
  const { showing, showModal, hideModal } = useManageWorkspaceModal();
  const isInWorkspaceSettings = !!useMatch("/workspace/:slug/settings/*");
  const isHomePage = !!useMatch("/");
  const refreshInFlightRef = useRef(null);
  const pendingForceRefreshRef = useRef(false);
  const pendingRefreshTimerRef = useRef(null);
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

      const workspaces = await workspaceNavigationCache.runInFlight(
        "workspaces:all",
        () =>
          requestPriorityQueue.schedule(
            ({ signal }) =>
              Workspace.all({
                signal,
                task: false,
              }),
            {
              priority: "P0",
              label: "navigation:workspaces",
              kind: "navigation",
              scope: { route: "workspace-sidebar", surface: "workspaces" },
              policy: "foreground",
              emergency: true,
              intentRank: 0,
              dedupeKey: "navigation:workspaces",
            }
          ),
        { reuseResolvedWithinMs: force ? 0 : NAV_DUPLICATE_REUSE_MS }
      );
      if (!workspaces) return null;
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
    const handleWorkspacesRefresh = (event) => {
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
      refreshWorkspaces({ force: !!event.detail?.force });
    };

    refreshWorkspaces();
    window.addEventListener(WORKSPACES_REFRESH_EVENT, handleWorkspacesRefresh);
    return () => {
      if (pendingRefreshTimerRef.current) {
        window.clearTimeout(pendingRefreshTimerRef.current);
        pendingRefreshTimerRef.current = null;
      }
      window.removeEventListener(
        WORKSPACES_REFRESH_EVENT,
        handleWorkspacesRefresh
      );
    };
  }, [refreshWorkspaces]);

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
    const reorderedWorkspaces = Array.from(workspaces);
    const [removed] = reorderedWorkspaces.splice(startIndex, 1);
    reorderedWorkspaces.splice(endIndex, 0, removed);
    setWorkspaces(reorderedWorkspaces);
    workspaceNavigationCache.setWorkspaces(reorderedWorkspaces);
    const success = Workspace.storeWorkspaceOrder(
      reorderedWorkspaces.map((w) => w.id)
    );
    if (!success) {
      showToast("Failed to reorder workspaces", "error");
      Workspace.all().then((workspaces) => setWorkspaces(workspaces));
    }
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

    const resultPayload = await Workspace.threads.move(
      draggedThread.sourceWorkspaceSlug,
      draggedThread.threadSlug,
      targetWorkspaceSlug,
      {
        communicationScene: "workspace-navigation",
        task: navigationWriteTask(
          "navigation:thread-move",
          draggedThread.sourceWorkspaceSlug,
          {
            threadSlug: draggedThread.threadSlug,
            targetWorkspaceSlug,
          }
        ),
      }
    );
    if (!resultPayload.success) {
      showToast(
        `Could not move thread - ${resultPayload.error || "Unknown error"}`,
        "error",
        { clear: true }
      );
      refreshWorkspaceThreads(draggedThread.sourceWorkspaceSlug);
      refreshWorkspaceThreads(targetWorkspaceSlug);
      return;
    }

    clearLastVisitedThread(
      draggedThread.sourceWorkspaceSlug,
      draggedThread.threadSlug
    );
    rememberLastVisitedWorkspace(targetWorkspace, draggedThread.threadSlug);
    refreshWorkspaceThreads(draggedThread.sourceWorkspaceSlug);
    refreshWorkspaceThreads(targetWorkspaceSlug);
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
            {workspaces.map((workspace, index) => {
              const isVirtuallyActive = workspace.slug === virtualActiveSlug;
              const isActive = workspace.slug === slug || isVirtuallyActive;
              const isCollapsed = !!collapsedWorkspaces[workspace.slug];
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
                      className={`flex flex-col w-full group ${
                        snapshot.isDragging ? "opacity-50" : ""
                      }`}
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
