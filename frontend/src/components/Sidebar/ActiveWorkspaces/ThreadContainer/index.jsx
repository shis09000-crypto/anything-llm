import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import {
  CaretDown,
  CaretUp,
  Plus,
  CircleNotch,
  Trash,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import ThreadItem from "./ThreadItem";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  useChatThreadDrafts,
  useThreadActivitySnapshot,
} from "@/contexts/ChatThreadDraftProvider";
import { debugChatTurn } from "@/utils/chat/debug";
import { clearLastVisitedThread } from "@/utils/lastVisitedWorkspace";
import {
  isOverviewThread,
  sortThreadsForDisplay,
} from "@/utils/workspaceThreads";
import {
  COLLAPSED_THREAD_LIMIT,
  visibleThreadRows,
} from "@/utils/workspaceThreadRows";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { Draggable, Droppable } from "react-beautiful-dnd";
import { markLoginBoot } from "@/utils/loginBootPerf";
import { recordCommunicationEvent } from "@/lib/communication/communicationMetrics";
import { markTaskPerformance } from "@/utils/tasks/taskScheduler";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";
import { recoveryCenter } from "@/utils/recovery/recoveryCenter";
import {
  THREAD_CREATE_VISUAL_EVENT,
  THREAD_CREATE_ANIMATION_MS,
  THREAD_DELETE_VISUAL_EVENT,
  THREAD_DELETE_ANIMATION_MS,
  THREAD_MOVE_VISUAL_EVENT,
  THREAD_PATCH_VISUAL_EVENT,
} from "@/utils/workspaceEvents";
import { guardGlobalRefresh } from "@/utils/globalRefreshPolicy";
export const THREAD_RENAME_EVENT = "renameThread";
export const WORKSPACE_THREADS_REFRESH_EVENT = "workspaceThreadsRefresh";
const THREAD_DUPLICATE_REUSE_MS = 1_500;
const titleEventStreamsByWorkspace = new Map();

function createOptimisticThread(workspaceSlug, label) {
  const now = new Date().toISOString();
  const random =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const slug = `athena-new-thread-${random}`;
  return {
    id: `optimistic:${workspaceSlug}:${slug}`,
    slug,
    name: label,
    title: "",
    thread_type: "chat",
    createdAt: now,
    lastChatAt: now,
    lastUpdatedAt: now,
    optimistic: true,
  };
}

function mergeOptimisticThreads(serverThreads = [], currentThreads = []) {
  const serverSlugs = new Set(serverThreads.map((thread) => thread?.slug));
  const optimisticThreads = currentThreads.filter(
    (thread) => thread?.optimistic && !serverSlugs.has(thread.slug)
  );
  return optimisticThreads.length
    ? [...optimisticThreads, ...serverThreads]
    : serverThreads;
}

function cacheWorkspaceThreads(workspaceSlug, threads = []) {
  workspaceNavigationCache.setThreads(
    workspaceSlug,
    threads.filter((thread) => !thread?.optimistic)
  );
}

function cachedThreadsForWorkspace(workspaceSlug) {
  if (!workspaceSlug) return null;
  const threads = workspaceNavigationCache.getThreads(workspaceSlug, {
    allowStale: true,
  });
  return Array.isArray(threads) ? threads : null;
}

function initialThreadStateForWorkspace(workspaceSlug) {
  const cachedThreads = cachedThreadsForWorkspace(workspaceSlug);
  return {
    threads: cachedThreads || [],
    loading: !Array.isArray(cachedThreads),
  };
}

export default function ThreadContainer({
  workspace,
  isVirtualThread = false,
  threadDraggableId = null,
  threadDndType = "THREAD",
}) {
  const navigate = useNavigate();
  const { threadSlug = null } = useParams();
  const initialThreadStateRef = useRef(null);
  if (!initialThreadStateRef.current) {
    initialThreadStateRef.current = initialThreadStateForWorkspace(
      workspace?.slug
    );
  }
  const [threads, setThreads] = useState(
    () => initialThreadStateRef.current.threads
  );
  const [loading, setLoading] = useState(
    () => initialThreadStateRef.current.loading
  );
  const [creatingThreads, setCreatingThreads] = useState({});
  const [deletingThreads, setDeletingThreads] = useState({});
  const [ctrlPressed, setCtrlPressed] = useState(false);
  const [showAllThreads, setShowAllThreads] = useState(false);
  const titleAnimationTimers = useRef(new Map());
  const lastAnimatedTitle = useRef(new Map());
  const threadFetchInFlightRef = useRef(null);
  const pendingThreadRefreshRef = useRef(null);
  const pendingReplayAttachedRef = useRef(false);
  const threadFetchSeqRef = useRef(0);
  const threadFetchAbortRef = useRef(null);
  const threadsRef = useRef([]);
  const threadVisualTimers = useRef(new Map());
  const deletedThreadSnapshots = useRef(new Map());
  const { t, i18n } = useTranslation();
  const { hasThreadActivity, clearThreadActivity } = useChatThreadDrafts();
  useThreadActivitySnapshot();

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    return () => {
      threadVisualTimers.current.forEach((timer) => clearTimeout(timer));
      threadVisualTimers.current.clear();
      deletedThreadSnapshots.current.clear();
    };
  }, []);

  useEffect(() => {
    if (loading || !workspace?.slug || !Array.isArray(threads)) return;
    markTaskPerformance("thread_list_cache_visible", {
      source: "component-state",
      workspaceSlug: workspace.slug,
      count: threads.length,
    });
  }, [loading, threads, workspace?.slug]);

  const clearTitleAnimation = useCallback((threadSlug) => {
    const timers = titleAnimationTimers.current.get(threadSlug) || [];
    timers.forEach((timer) => clearTimeout(timer));
    titleAnimationTimers.current.delete(threadSlug);
  }, []);

  const updateThreadTitle = useCallback(
    (threadSlug, title) => {
      setThreads((prevThreads) => {
        const nextThreads = prevThreads.map((thread) => {
          if (thread.slug !== threadSlug) return thread;
          return { ...thread, name: title, title };
        });
        cacheWorkspaceThreads(workspace.slug, nextThreads);
        return nextThreads;
      });
    },
    [workspace.slug]
  );

  const animateThreadTitle = useCallback(
    (threadSlug, title) => {
      clearTitleAnimation(threadSlug);
      updateThreadTitle(threadSlug, "");

      const chars = Array.from(title);
      if (chars.length === 0) return;

      const timers = chars.map((_, index) =>
        setTimeout(
          () => {
            updateThreadTitle(threadSlug, chars.slice(0, index + 1).join(""));
            if (index === chars.length - 1) {
              titleAnimationTimers.current.delete(threadSlug);
            }
          },
          45 * (index + 1)
        )
      );
      titleAnimationTimers.current.set(threadSlug, timers);
    },
    [clearTitleAnimation, updateThreadTitle]
  );

  useEffect(() => {
    const chatHandler = (event) => {
      const { threadSlug, newName, title, animate } = event.detail;
      const nextTitle = title || newName;
      if (!threadSlug || !nextTitle) return;

      if (animate) {
        if (lastAnimatedTitle.current.get(threadSlug) === nextTitle) return;
        lastAnimatedTitle.current.set(threadSlug, nextTitle);
        animateThreadTitle(threadSlug, nextTitle);
        return;
      }

      lastAnimatedTitle.current.set(threadSlug, nextTitle);
      clearTitleAnimation(threadSlug);
      updateThreadTitle(threadSlug, nextTitle);
    };

    window.addEventListener(THREAD_RENAME_EVENT, chatHandler);

    return () => {
      window.removeEventListener(THREAD_RENAME_EVENT, chatHandler);
      titleAnimationTimers.current.forEach((timers) =>
        timers.forEach((timer) => clearTimeout(timer))
      );
      titleAnimationTimers.current.clear();
    };
  }, [animateThreadTitle, clearTitleAnimation, updateThreadTitle]);

  useEffect(() => {
    if (!workspace.slug) return;
    const existing = titleEventStreamsByWorkspace.get(workspace.slug);
    if (existing) {
      existing.refCount += 1;
      recordCommunicationEvent({
        type: "thread-title-events-reuse",
        method: "EVENT",
        path: `/workspace/${workspace.slug}/thread-title-events`,
        communicationScene: "workspace-navigation",
        durationMs: 0,
        requestBytes: 0,
        responseBytes: 0,
        ok: true,
        workspaceSlug: workspace.slug,
        refCount: existing.refCount,
      });
      return () => {
        const entry = titleEventStreamsByWorkspace.get(workspace.slug);
        if (!entry) return;
        entry.refCount -= 1;
        if (entry.refCount <= 0) {
          entry.controller.abort();
          titleEventStreamsByWorkspace.delete(workspace.slug);
        }
      };
    }

    const ctrl = new AbortController();
    titleEventStreamsByWorkspace.set(workspace.slug, {
      controller: ctrl,
      refCount: 1,
    });
    recordCommunicationEvent({
      type: "thread-title-events-subscribe",
      method: "EVENT",
      path: `/workspace/${workspace.slug}/thread-title-events`,
      communicationScene: "workspace-navigation",
      durationMs: 0,
      requestBytes: 0,
      responseBytes: 0,
      ok: true,
      workspaceSlug: workspace.slug,
    });

    Workspace.threads
      .titleEvents(workspace.slug, {
        signal: ctrl.signal,
        onThreadRename: (thread) => {
          window.dispatchEvent(
            new CustomEvent(THREAD_RENAME_EVENT, {
              detail: {
                threadSlug: thread.slug,
                newName: thread.name,
                title: thread.title || thread.name,
                titleVersion: thread.titleVersion,
                animate: !!thread.animate,
              },
            })
          );
        },
      })
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        const recovery = recoveryCenter.handle(error, {
          source: "task",
          scope: {
            route: "workspace-sidebar",
            surface: "thread-title-events",
            workspaceSlug: workspace.slug,
          },
        });
        if (recovery?.silent) return;
        console.warn("[ThreadTitle] event stream closed", error.message);
      });

    return () => {
      const entry = titleEventStreamsByWorkspace.get(workspace.slug);
      if (!entry) return;
      entry.refCount -= 1;
      if (entry.refCount <= 0) {
        ctrl.abort();
        titleEventStreamsByWorkspace.delete(workspace.slug);
      }
    };
  }, [workspace.slug]);

  useEffect(() => {
    let mounted = true;
    const seq = threadFetchSeqRef.current + 1;
    threadFetchSeqRef.current = seq;
    threadFetchAbortRef.current?.abort();
    const controller = new AbortController();
    threadFetchAbortRef.current = controller;
    const isCurrent = () =>
      mounted &&
      !controller.signal.aborted &&
      threadFetchSeqRef.current === seq &&
      workspace.slug;

    async function fetchThreads() {
      if (!workspace.slug) return;
      setShowAllThreads(false);
      const freshThreads = workspaceNavigationCache.getThreads(workspace.slug, {
        allowStale: false,
      });
      if (Array.isArray(freshThreads)) {
        workspaceNavigationCache.debug("threads:hit", {
          workspaceSlug: workspace.slug,
          ...workspaceNavigationCache.getThreadsMeta(workspace.slug),
        });
        setThreads(freshThreads);
        setLoading(false);
        performance?.mark?.("athena:workspace-switch:threads_ready");
        markLoginBoot("threads_loaded", {
          source: "cache",
          workspaceSlug: workspace.slug,
          count: freshThreads.length,
        });
        return;
      }

      const staleThreads = workspaceNavigationCache.getThreads(workspace.slug);
      if (Array.isArray(staleThreads)) {
        workspaceNavigationCache.debug("threads:stale", {
          workspaceSlug: workspace.slug,
          ...workspaceNavigationCache.getThreadsMeta(workspace.slug),
        });
        setThreads(staleThreads);
        setLoading(false);
        performance?.mark?.("athena:workspace-switch:threads_ready");
      } else {
        workspaceNavigationCache.debug("threads:miss", {
          workspaceSlug: workspace.slug,
        });
        setLoading(true);
      }

      const request = workspaceNavigationCache.runInFlight(
        `threads:${workspace.slug}`,
        ({ signal } = {}) =>
          Workspace.threads.all(workspace.slug, {
            signal,
            task: false,
            preferSyncV2Cache: true,
          }),
        {
          reuseResolvedWithinMs: THREAD_DUPLICATE_REUSE_MS,
          priority: "P0",
          label: "navigation:threads",
          scope: {
            route: "workspace-sidebar",
            workspaceSlug: workspace.slug,
            surface: "threads",
          },
          policy: "foreground",
          emergency: true,
          intentRank: 1,
          signal: controller.signal,
          dedupeKey: `navigation:threads:${workspace.slug}`,
        }
      );
      threadFetchInFlightRef.current = request;
      let result = null;
      try {
        result = await request;
      } catch (error) {
        if (error?.name !== "AbortError" && isCurrent()) console.error(error);
        return;
      } finally {
        if (threadFetchInFlightRef.current === request) {
          threadFetchInFlightRef.current = null;
        }
      }
      const { threads } = result || {};
      if (!Array.isArray(threads)) return;
      if (!isCurrent()) return;
      const nextThreads = mergeOptimisticThreads(threads, threadsRef.current);
      cacheWorkspaceThreads(workspace.slug, nextThreads);
      setLoading(false);
      setThreads(nextThreads);
      performance?.mark?.("athena:workspace-switch:threads_ready");
      markTaskPerformance("thread_ready", {
        workspaceSlug: workspace.slug,
        count: threads.length,
      });
      markLoginBoot("threads_loaded", {
        source: "network",
        workspaceSlug: workspace.slug,
        count: threads.length,
      });
    }
    fetchThreads();
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [workspace.slug]);

  useEffect(() => {
    async function refreshThreads(event) {
      if (event?.detail?.workspaceSlug !== workspace.slug) return;
      recordCommunicationEvent({
        type: "workspace-threads-refresh-handled",
        method: "EVENT",
        path: WORKSPACE_THREADS_REFRESH_EVENT,
        communicationScene: "workspace-navigation",
        durationMs: 0,
        requestBytes: 0,
        responseBytes: 0,
        ok: true,
        workspaceSlug: workspace.slug,
        reason: event?.detail?.reason || "refresh",
        source: event?.detail?.source || null,
        replayed: !!event?.detail?.replayed,
      });
      const guard = guardGlobalRefresh({
        detail: event?.detail || {},
        path: WORKSPACE_THREADS_REFRESH_EVENT,
        source: "thread-container",
      });
      if (!guard.allowed) return;
      if (threadFetchInFlightRef.current) {
        pendingThreadRefreshRef.current = {
          workspaceSlug: workspace.slug,
          ...(event?.detail || {}),
        };
        if (!pendingReplayAttachedRef.current) {
          pendingReplayAttachedRef.current = true;
          threadFetchInFlightRef.current.finally(() => {
            pendingReplayAttachedRef.current = false;
            if (!pendingThreadRefreshRef.current) return;
            const pendingDetail = pendingThreadRefreshRef.current;
            pendingThreadRefreshRef.current = null;
            window.dispatchEvent(
              new CustomEvent(WORKSPACE_THREADS_REFRESH_EVENT, {
                detail: {
                  ...pendingDetail,
                  workspaceSlug: workspace.slug,
                  force: false,
                  replayed: true,
                },
              })
            );
          });
        }
        return;
      }
      const seq = threadFetchSeqRef.current + 1;
      threadFetchSeqRef.current = seq;
      threadFetchAbortRef.current?.abort();
      const controller = new AbortController();
      threadFetchAbortRef.current = controller;
      const isCurrent = () =>
        !controller.signal.aborted &&
        threadFetchSeqRef.current === seq &&
        workspace.slug === event?.detail?.workspaceSlug;
      let result = null;
      try {
        result = await workspaceNavigationCache.runInFlight(
          `threads:${workspace.slug}`,
          ({ signal } = {}) =>
            Workspace.threads.all(workspace.slug, {
              signal,
              task: false,
            }),
          {
            reuseResolvedWithinMs:
              event?.detail?.force && !event?.detail?.replayed
                ? 0
                : THREAD_DUPLICATE_REUSE_MS,
            priority: "P0",
            label: "navigation:threads-refresh",
            scope: {
              route: "workspace-sidebar",
              workspaceSlug: workspace.slug,
              surface: "threads",
            },
            policy: "foreground",
            emergency: true,
            intentRank: 1,
            signal: controller.signal,
            dedupeKey: `navigation:threads:${workspace.slug}`,
          }
        );
      } catch (error) {
        if (error?.name !== "AbortError" && isCurrent()) console.error(error);
        return;
      }
      const { threads: refreshedThreads } = result || {};
      if (!Array.isArray(refreshedThreads)) return;
      if (!isCurrent()) return;
      performance?.mark?.("athena:workspace-switch:threads_ready");
      const currentBySlug = new Map(
        threadsRef.current.map((thread) => [thread.slug, thread])
      );
      const animations = [];
      const nextThreads = mergeOptimisticThreads(
        refreshedThreads,
        threadsRef.current
      ).map((thread) => {
        const currentThread = currentBySlug.get(thread.slug);
        const currentTitle = currentThread?.title || currentThread?.name || "";
        const nextTitle = thread.title || thread.name || "";
        const shouldAnimateTitle =
          currentThread &&
          currentTitle !== nextTitle &&
          thread.titleSource !== "manual" &&
          lastAnimatedTitle.current.get(thread.slug) !== nextTitle &&
          !thread.deleted;

        if (!shouldAnimateTitle) return thread;

        lastAnimatedTitle.current.set(thread.slug, nextTitle);
        animations.push({ slug: thread.slug, title: nextTitle });
        return { ...thread, name: "", title: "" };
      });
      cacheWorkspaceThreads(workspace.slug, nextThreads);
      setThreads(nextThreads);
      animations.forEach(({ slug, title }) => animateThreadTitle(slug, title));
    }

    window.addEventListener(WORKSPACE_THREADS_REFRESH_EVENT, refreshThreads);
    return () =>
      window.removeEventListener(
        WORKSPACE_THREADS_REFRESH_EVENT,
        refreshThreads
      );
  }, [animateThreadTitle, workspace.slug]);

  // Enable toggling of bulk-deletion by holding meta-key (ctrl on win and cmd/fn on others)
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (["Control", "Meta"].includes(event.key)) {
        setCtrlPressed(true);
      }
    };

    const handleKeyUp = (event) => {
      if (["Control", "Meta"].includes(event.key)) {
        setCtrlPressed(false);
        // when toggling, unset bulk progress so
        // previously marked threads that were never deleted
        // come back to life.
        setThreads((prev) =>
          prev.map((t) => {
            return { ...t, deleted: false };
          })
        );
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const toggleForDeletion = (id) => {
    setThreads((prev) =>
      prev.map((t) => {
        if (isOverviewThread(t)) return t;
        if (t.id !== id) return t;
        return { ...t, deleted: !t.deleted };
      })
    );
  };

  const markThreadCreating = useCallback((threadSlugToMark) => {
    if (!threadSlugToMark) return;
    setCreatingThreads((prev) => ({ ...prev, [threadSlugToMark]: true }));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setCreatingThreads((prev) => {
          if (!prev[threadSlugToMark]) return prev;
          const next = { ...prev };
          delete next[threadSlugToMark];
          return next;
        });
      });
    });
    const timer = setTimeout(() => {
      threadVisualTimers.current.delete(`create:${threadSlugToMark}`);
      setCreatingThreads((prev) => {
        if (!prev[threadSlugToMark]) return prev;
        const next = { ...prev };
        delete next[threadSlugToMark];
        return next;
      });
    }, THREAD_CREATE_ANIMATION_MS + 80);
    threadVisualTimers.current.set(`create:${threadSlugToMark}`, timer);
  }, []);

  const clearThreadDeleteTimer = useCallback((threadSlugToClear) => {
    const timerKey = `delete:${threadSlugToClear}`;
    const timer = threadVisualTimers.current.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      threadVisualTimers.current.delete(timerKey);
    }
  }, []);

  const restoreThreadSnapshot = useCallback(
    (thread) => {
      const threadSlugToRestore = thread?.slug;
      if (!threadSlugToRestore) return;
      clearThreadDeleteTimer(threadSlugToRestore);
      const snapshot =
        deletedThreadSnapshots.current.get(threadSlugToRestore) || null;
      deletedThreadSnapshots.current.delete(threadSlugToRestore);
      setDeletingThreads((prev) => {
        if (!prev[threadSlugToRestore]) return prev;
        const next = { ...prev };
        delete next[threadSlugToRestore];
        return next;
      });
      setThreads((prev) => {
        const nextThreads = Array.isArray(snapshot)
          ? snapshot
          : [
              thread,
              ...prev.filter(
                (existing) => existing.slug !== threadSlugToRestore
              ),
            ];
        cacheWorkspaceThreads(workspace.slug, nextThreads);
        return nextThreads;
      });
      markThreadCreating(threadSlugToRestore);
    },
    [clearThreadDeleteTimer, markThreadCreating, workspace.slug]
  );

  const removeThread = useCallback(
    (threadOrSlug, options = {}) => {
      const threadSlugToRemove =
        typeof threadOrSlug === "string" ? threadOrSlug : threadOrSlug?.slug;
      if (!threadSlugToRemove) return;
      clearThreadDeleteTimer(threadSlugToRemove);
      deletedThreadSnapshots.current.set(
        threadSlugToRemove,
        threadsRef.current
      );
      setDeletingThreads((prev) => ({
        ...prev,
        [threadSlugToRemove]: true,
      }));
      const timer = setTimeout(() => {
        threadVisualTimers.current.delete(`delete:${threadSlugToRemove}`);
        deletedThreadSnapshots.current.delete(threadSlugToRemove);
        setThreads((prev) => {
          const nextThreads = prev.filter(
            (thread) => thread.slug !== threadSlugToRemove
          );
          cacheWorkspaceThreads(workspace.slug, nextThreads);
          return nextThreads;
        });
        setDeletingThreads((prev) => {
          if (!prev[threadSlugToRemove]) return prev;
          const next = { ...prev };
          delete next[threadSlugToRemove];
          return next;
        });
        clearLastVisitedThread(workspace.slug, threadSlugToRemove);
        if (options.navigateAfter) {
          navigate(paths.workspace.chat(workspace.slug), {
            replace: true,
            state: { deletedThreadSlug: threadSlugToRemove },
          });
        }
      }, THREAD_DELETE_ANIMATION_MS);
      threadVisualTimers.current.set(`delete:${threadSlugToRemove}`, timer);
    },
    [clearThreadDeleteTimer, navigate, workspace.slug]
  );

  const handleDeleteAll = async () => {
    const slugs = threads
      .filter((t) => t.deleted === true && !isOverviewThread(t))
      .map((t) => t.slug);
    if (!slugs.length) return;
    const previousThreads = threadsRef.current;
    const action = optimisticActionCenter.run({
      type: "thread.deleteBulk",
      scope: {
        route: "workspace-sidebar",
        surface: "threads",
        workspaceSlug: workspace.slug,
      },
      priority: "P0",
      policy: "foreground",
      intentRank: 1,
      protected: true,
      abortable: false,
      tombstone: true,
      label: "optimistic:thread-delete-bulk",
      dedupeKey: `optimistic:thread-delete-bulk:${workspace.slug}:${slugs.join(",")}`,
      optimisticPatch: () => {
        slugs.forEach((slug) =>
          removeThread(slug, { navigateAfter: slug === threadSlug })
        );
      },
      rollbackPatch: () => {
        slugs.forEach((slug) => clearThreadDeleteTimer(slug));
        deletedThreadSnapshots.current.clear();
        setDeletingThreads({});
        setThreads(previousThreads);
        cacheWorkspaceThreads(workspace.slug, previousThreads);
        slugs.forEach((slug) => markThreadCreating(slug));
      },
      serverCall: async ({ signal }) => {
        const success = await Workspace.threads.deleteBulk(
          workspace.slug,
          slugs,
          {
            signal,
            communicationScene: "workspace-navigation",
            task: false,
            skipCacheUpdate: true,
          }
        );
        if (!success) throw new Error("bulk delete failed");
        return true;
      },
    });
    const outcome = await action.promise;
    if (!outcome.ok) {
      showToast("批量删除线程失败。", "error", { clear: true });
      return;
    }
    slugs.forEach((slug) => clearLastVisitedThread(workspace.slug, slug));
  };

  function handleThreadCreated(thread, options = {}) {
    if (!thread?.slug) return;
    setThreads((prev) => {
      const nextThreads = [
        thread,
        ...prev.filter(
          (existing) =>
            existing.slug !== thread.slug &&
            existing.slug !== options.replaceSlug
        ),
      ];
      cacheWorkspaceThreads(workspace.slug, nextThreads);
      return nextThreads;
    });
    if (options.animate !== false) markThreadCreating(thread.slug);
  }

  function handleThreadPatched(threadPatch, options = {}) {
    const threadSlugToPatch = threadPatch?.slug || options.threadSlug;
    if (!threadSlugToPatch) return;
    clearTitleAnimation(threadSlugToPatch);
    setThreads((prev) => {
      let found = false;
      const nextThreads = prev.map((thread) => {
        if (thread.slug !== threadSlugToPatch) return thread;
        found = true;
        return { ...thread, ...threadPatch, slug: threadSlugToPatch };
      });
      const resolvedThreads =
        found || options.insertIfMissing !== true
          ? nextThreads
          : [{ ...threadPatch, slug: threadSlugToPatch }, ...prev];
      cacheWorkspaceThreads(workspace.slug, resolvedThreads);
      return resolvedThreads;
    });
  }

  function handleThreadRemoved(threadSlugToRemove) {
    removeThread(threadSlugToRemove);
  }

  function handleThreadCreateFailed(threadSlugToRemove) {
    handleThreadRemoved(threadSlugToRemove);
    if (
      typeof window !== "undefined" &&
      window.location.pathname ===
        paths.workspace.thread(workspace.slug, threadSlugToRemove)
    ) {
      navigate(paths.workspace.chat(workspace.slug), {
        replace: true,
        state: { threadCreateFailed: true },
      });
    }
  }

  function handleThreadCreateResolved(optimisticSlug, thread) {
    if (!thread?.slug) return;
    handleThreadCreated(thread, {
      replaceSlug: optimisticSlug,
      animate: false,
    });
    if (
      typeof window !== "undefined" &&
      window.location.pathname ===
        paths.workspace.thread(workspace.slug, optimisticSlug)
    ) {
      navigate(paths.workspace.thread(workspace.slug, thread.slug), {
        replace: true,
        state: { userSelectedThread: true, createdFromOptimistic: true },
      });
    }
  }

  useEffect(() => {
    const handleThreadCreateVisual = (event) => {
      const detail = event?.detail || {};
      if (detail.workspaceSlug !== workspace.slug || !detail.thread?.slug)
        return;
      handleThreadCreated(detail.thread, {
        replaceSlug: detail.replaceSlug || null,
        animate: detail.animate !== false,
      });
    };

    const handleThreadDeleteVisual = (event) => {
      const detail = event?.detail || {};
      if (detail.workspaceSlug !== workspace.slug || !detail.threadSlug) return;
      removeThread(detail.threadSlug, {
        navigateAfter: detail.threadSlug === threadSlug,
      });
    };

    const handleThreadPatchVisual = (event) => {
      const detail = event?.detail || {};
      if (detail.workspaceSlug !== workspace.slug) return;
      const thread =
        detail.thread ||
        (detail.threadSlug
          ? {
              slug: detail.threadSlug,
              ...(detail.threadName ? { name: detail.threadName } : {}),
              ...(detail.title || detail.threadName
                ? { title: detail.title || detail.threadName }
                : {}),
            }
          : null);
      if (!thread?.slug) return;
      handleThreadPatched(thread, {
        insertIfMissing: !!detail.insertIfMissing,
        threadSlug: detail.threadSlug,
      });
    };

    const handleThreadMoveVisual = (event) => {
      const detail = event?.detail || {};
      if (detail.sourceWorkspaceSlug === workspace.slug && detail.threadSlug) {
        removeThread(detail.threadSlug, {
          navigateAfter: detail.threadSlug === threadSlug,
        });
      }
      if (
        detail.targetWorkspaceSlug === workspace.slug &&
        detail.thread?.slug
      ) {
        handleThreadCreated(detail.thread, {
          animate: detail.animate !== false,
        });
      }
    };

    window.addEventListener(
      THREAD_CREATE_VISUAL_EVENT,
      handleThreadCreateVisual
    );
    window.addEventListener(THREAD_PATCH_VISUAL_EVENT, handleThreadPatchVisual);
    window.addEventListener(THREAD_MOVE_VISUAL_EVENT, handleThreadMoveVisual);
    window.addEventListener(
      THREAD_DELETE_VISUAL_EVENT,
      handleThreadDeleteVisual
    );
    return () => {
      window.removeEventListener(
        THREAD_CREATE_VISUAL_EVENT,
        handleThreadCreateVisual
      );
      window.removeEventListener(
        THREAD_PATCH_VISUAL_EVENT,
        handleThreadPatchVisual
      );
      window.removeEventListener(
        THREAD_MOVE_VISUAL_EVENT,
        handleThreadMoveVisual
      );
      window.removeEventListener(
        THREAD_DELETE_VISUAL_EVENT,
        handleThreadDeleteVisual
      );
    };
  }, [
    clearTitleAnimation,
    handleThreadCreated,
    handleThreadPatched,
    removeThread,
    threadSlug,
    workspace.slug,
  ]);

  useEffect(() => {
    const currentActivity = hasThreadActivity(workspace.slug, threadSlug);
    if (["completed", "failed"].includes(currentActivity?.status)) {
      clearThreadActivity(workspace.slug, threadSlug);
    }
  }, [workspace.slug, threadSlug, hasThreadActivity, clearThreadActivity]);

  const sortedThreadRows = getSortedThreadRows(
    threads,
    workspace.slug,
    hasThreadActivity
  );
  const chatThreadRows = sortedThreadRows.filter(
    ({ thread }) => !isOverviewThread(thread)
  );
  const canToggleThreadList = chatThreadRows.length > COLLAPSED_THREAD_LIMIT;
  const { threadRows, hiddenThreadCount } = visibleThreadRows({
    sortedThreadRows,
    activeThreadSlug: threadSlug,
    expanded: showAllThreads,
    collapsedLimit: COLLAPSED_THREAD_LIMIT,
  });
  const activeThreadIdx = (() => {
    const idx = threadRows.findIndex((row) => row.thread?.slug === threadSlug);
    if (idx >= 0) return idx;
    if (isVirtualThread) return threadRows.length;
    return -1;
  })();

  useEffect(() => {
    debugChatTurn("ThreadContainer:renderState", {
      workspaceSlug: workspace.slug,
      activeThreadSlug: threadSlug,
      runningRows: threadRows
        .filter((row) => row.activity?.status === "running")
        .map((row) => ({
          threadSlug: row.thread.slug,
          turnId: row.activity.turnId,
        })),
    });
  }, [threadRows, threadSlug, workspace.slug]);

  if (loading) {
    return (
      <div className="flex flex-col bg-pulse w-full h-10 items-center justify-center">
        <p className="text-xs text-white animate-pulse">loading threads....</p>
      </div>
    );
  }

  return (
    <Droppable droppableId={`threads:${workspace.slug}`} type={threadDndType}>
      {(provided) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          className="flex flex-col"
          role="list"
          aria-label="Threads"
        >
          {threadRows.map(({ thread, activity }, i) => {
            const isActiveThread = activeThreadIdx === i;
            const rowActivity = displayActivity(activity, isActiveThread);
            const dragDisabled =
              !thread.slug ||
              thread.virtual ||
              isOverviewThread(thread) ||
              rowActivity?.status === "running";
            return (
              <Draggable
                key={thread.slug || thread.id}
                draggableId={
                  thread.slug
                    ? threadDraggableId?.(workspace.slug, thread.slug) ||
                      `thread:${workspace.slug}:${thread.slug}`
                    : `thread:${workspace.slug}:missing-${thread.id || i}`
                }
                index={i}
                isDragDisabled={dragDisabled}
              >
                {(dragProvided, snapshot) => (
                  <ThreadItem
                    idx={i}
                    dragProvided={dragProvided}
                    isDragging={snapshot.isDragging}
                    ctrlPressed={ctrlPressed}
                    toggleMarkForDeletion={toggleForDeletion}
                    activeIdx={activeThreadIdx}
                    isActive={isActiveThread}
                    workspace={workspace}
                    onRemove={removeThread}
                    onRestore={restoreThreadSnapshot}
                    thread={thread}
                    activity={rowActivity}
                    hasNext={i !== threadRows.length - 1 || isVirtualThread}
                    isCreatingVisual={!!creatingThreads[thread.slug]}
                    isDeletingVisual={!!deletingThreads[thread.slug]}
                  />
                )}
              </Draggable>
            );
          })}
          {provided.placeholder}
          {isVirtualThread && (
            <ThreadItem
              idx={activeThreadIdx}
              activeIdx={activeThreadIdx}
              isActive={true}
              workspace={workspace}
              thread={{
                slug: null,
                name: t("common.newThread"),
                virtual: true,
              }}
              hasNext={false}
            />
          )}
          {canToggleThreadList && (
            <ThreadListToggleButton
              expanded={showAllThreads}
              hiddenCount={hiddenThreadCount}
              language={i18n.language}
              onClick={() => setShowAllThreads((prev) => !prev)}
            />
          )}
          <DeleteAllThreadButton
            ctrlPressed={ctrlPressed}
            threads={threads}
            onDelete={handleDeleteAll}
          />
          <NewThreadButton
            workspace={workspace}
            onThreadCreated={handleThreadCreated}
            onThreadCreateResolved={handleThreadCreateResolved}
            onThreadCreateFailed={handleThreadCreateFailed}
          />
        </div>
      )}
    </Droppable>
  );
}

function displayActivity(activity, isActive) {
  if (isActive) return activity?.status === "running" ? activity : null;
  return activity?.status === "running" ? activity : null;
}

function getSortedThreadRows(threads, workspaceSlug, hasThreadActivity) {
  return sortThreadsForDisplay(threads, workspaceSlug, hasThreadActivity);
}

function ThreadListToggleButton({
  expanded = false,
  hiddenCount = 0,
  language = "en",
  onClick,
}) {
  const isChinese = String(language || "").startsWith("zh");
  const label = expanded
    ? isChinese
      ? "收起"
      : "Show first 5"
    : isChinese
      ? `展开全部（还有 ${hiddenCount} 个）`
      : `Show all (${hiddenCount} more)`;
  const Icon = expanded ? CaretUp : CaretDown;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full relative flex h-[34px] items-center border-none hover:bg-[var(--theme-sidebar-thread-selected)] light:hover:bg-slate-300 hover:light:bg-theme-sidebar-subitem-hover rounded-lg"
      aria-expanded={expanded}
    >
      <div className="flex w-full gap-x-2 items-center pl-4">
        <div className="bg-zinc-800 light:bg-slate-50 p-2 rounded-lg h-[24px] w-[24px] flex items-center justify-center">
          <Icon
            weight="bold"
            size={14}
            className="shrink-0 text-white light:text-theme-text-primary"
          />
        </div>
        <p className="text-left text-white light:text-theme-text-primary text-sm font-semibold truncate">
          {label}
        </p>
      </div>
    </button>
  );
}

function NewThreadButton({
  workspace,
  onThreadCreated,
  onThreadCreateResolved,
  onThreadCreateFailed,
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const onClick = async () => {
    if (loading || !workspace?.slug) return;
    const optimisticThread = createOptimisticThread(
      workspace.slug,
      t("common.newThread")
    );

    setLoading(true);
    const action = optimisticActionCenter.run({
      type: "thread.create",
      scope: {
        route: "workspace-sidebar",
        surface: "thread-create",
        workspaceSlug: workspace.slug,
        optimisticThreadSlug: optimisticThread.slug,
      },
      priority: "P0",
      policy: "foreground",
      intentRank: 2,
      protected: true,
      abortable: false,
      emergency: true,
      label: "optimistic:thread-create",
      dedupeKey: `optimistic:thread-create:${workspace.slug}:${optimisticThread.slug}`,
      optimisticPatch: () => onThreadCreated?.(optimisticThread),
      rollbackPatch: () => onThreadCreateFailed?.(optimisticThread.slug),
      confirmPatch: ({ result }) => {
        if (result?.thread?.slug)
          onThreadCreateResolved?.(optimisticThread.slug, result.thread);
      },
      serverCall: async ({ signal }) => {
        const result = await Workspace.threads.new(workspace.slug, {
          signal,
          communicationScene: "workspace-navigation",
          task: false,
          skipCacheUpdate: true,
        });
        if (result?.error || !result?.thread?.slug) {
          throw new Error(result?.error || "Invalid thread response");
        }
        return result;
      },
    });
    navigate(paths.workspace.thread(workspace.slug, optimisticThread.slug), {
      state: {
        userSelectedThread: true,
        optimisticNewThread: {
          slug: optimisticThread.slug,
          workspaceSlug: workspace.slug,
        },
      },
    });
    const outcome = await action.promise;
    if (!outcome.ok) {
      showToast(
        `Could not create thread - ${outcome.error?.message}`,
        "error",
        {
          clear: true,
        }
      );
    }
    setLoading(false);
  };

  return (
    <button
      onClick={onClick}
      disabled={loading}
      aria-busy={loading}
      className="w-full relative flex h-[40px] items-center border-none hover:bg-[var(--theme-sidebar-thread-selected)] light:hover:bg-slate-300 hover:light:bg-theme-sidebar-subitem-hover rounded-lg disabled:cursor-not-allowed disabled:opacity-70"
    >
      <div className="flex w-full gap-x-2 items-center pl-4">
        <div className="bg-zinc-800 light:bg-slate-50 p-2 rounded-lg h-[24px] w-[24px] flex items-center justify-center">
          {loading ? (
            <CircleNotch
              weight="bold"
              size={14}
              className="shrink-0 animate-spin text-white light:text-theme-text-primary"
            />
          ) : (
            <Plus
              weight="bold"
              size={14}
              className="shrink-0 text-white light:text-theme-text-primary"
            />
          )}
        </div>

        {loading ? (
          <p className="text-left text-white light:text-theme-text-primary text-sm">
            {t("common.startingThread")}
          </p>
        ) : (
          <p className="text-left text-white light:text-theme-text-primary text-sm font-semibold">
            {t("common.newThread")}
          </p>
        )}
      </div>
    </button>
  );
}

function DeleteAllThreadButton({ ctrlPressed, threads, onDelete }) {
  if (!ctrlPressed || threads.filter((t) => t.deleted).length === 0)
    return null;
  return (
    <button
      type="button"
      onClick={onDelete}
      className="w-full relative flex h-[40px] items-center border-none hover:bg-red-400/20 rounded-lg group"
    >
      <div className="flex w-full gap-x-2 items-center pl-4">
        <div className="bg-transparent p-2 rounded-lg h-[24px] w-[24px] flex items-center justify-center">
          <Trash
            weight="bold"
            size={14}
            className="shrink-0 text-white light:text-red-500/50 group-hover:text-red-400"
          />
        </div>
        <p className="text-white light:text-theme-text-secondary text-left text-sm group-hover:text-red-400">
          Delete Selected
        </p>
      </div>
    </button>
  );
}
