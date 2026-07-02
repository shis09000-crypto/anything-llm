import React, { useCallback, useEffect, useRef, useState } from "react";
import { isMobile } from "react-device-detect";
import Workspace from "@/models/workspace";
import LoadingChat from "./LoadingChat";
import ChatContainer from "./ChatContainer";
import paths from "@/utils/paths";
import ModalWrapper from "../ModalWrapper";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { DnDFileUploaderProvider } from "./ChatContainer/DnDWrapper";
import { WarningCircle } from "@phosphor-icons/react";
import {
  TTSProvider,
  useWatchForAutoPlayAssistantTTSResponse,
} from "../contexts/TTSProvider";
import { PENDING_HOME_MESSAGE } from "@/utils/constants";
import {
  draftHistoryIntegrity,
  draftNeedsServerHistoryRefresh,
  useChatThreadDrafts,
} from "@/contexts/ChatThreadDraftProvider";
import { setEventDelegatorForCodeSnippets } from "@/utils/chat/codeBlockCopy";
import { debugChatTurn } from "@/utils/chat/debug";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { threadHistoryCache } from "@/utils/chat/threadHistoryCache";
import { WorkspaceChatPerfMarks } from "@/utils/chat/performanceBudget";
import {
  findChatHistoryOrderIssue,
  normalizeChatHistoryOrder,
} from "@/utils/chat/historyOrder";
import {
  historyContainsChatId,
  readChatScrollMemory,
} from "@/utils/chat/chatScrollMemory";
import {
  defaultWorkspacePath,
  isOverviewThread,
  resolveWorkspaceEntryPath,
} from "@/utils/workspaceThreads";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import {
  historyDetailForDevice,
  historyRequestOptionsForDevice,
  historySurfaceForDevice,
} from "@/utils/chat/historyRequestOptions";
import {
  clearLastVisitedThread,
  getLastVisitedThreadSlug,
} from "@/utils/lastVisitedWorkspace";

const FIRST_PAGE_LIMIT = 20;
const ANCHOR_PAGE_LIMIT = 21;
const PRIORITY_FULL_WINDOW = 10;
const ANCHOR_PRIORITY_FULL_WINDOW = ANCHOR_PAGE_LIMIT;
const BACKGROUND_HYDRATE_BATCH_SIZE = 4;
const BACKGROUND_HYDRATE_DELAY_MS = 8_000;

function threadSwitchFlickerDebugEnabled() {
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

function debugThreadSwitchFlicker(label, payload = {}) {
  if (!threadSwitchFlickerDebugEnabled()) return;
  console.debug("[thread-switch-flicker]", label, payload);
}

function warnHistoryOrderIssue(issue = null, context = {}) {
  if (!issue || !threadSwitchFlickerDebugEnabled()) return;
  console.warn("[workspacechat-history-order]", {
    ...context,
    ...issue,
  });
}

function mergeHistoryMessages(
  existing = [],
  incoming = [],
  mode = "replace",
  context = {}
) {
  if (mode === "replace") {
    const issue = findChatHistoryOrderIssue(incoming);
    warnHistoryOrderIssue(issue, context);
    return normalizeChatHistoryOrder(incoming);
  }
  const next =
    mode === "prepend"
      ? [...incoming, ...existing]
      : [...existing, ...incoming];
  const order = [];
  const byKey = new Map();
  for (const message of next) {
    const key = `${message.chatId}:${message.role}`;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, message);
  }
  const merged = order.map((key) => byKey.get(key));
  const issue = findChatHistoryOrderIssue(merged);
  warnHistoryOrderIssue(issue, context);
  return normalizeChatHistoryOrder(merged);
}

function lightChatIdsFromHistory(history = []) {
  return [
    ...new Set(
      history
        .filter((message) => message.hydrationStatus === "light")
        .map((message) => message.chatId)
        .filter(Boolean)
    ),
  ];
}

function anchorHistoryCursor(chatId = null) {
  return chatId ? `anchor:${chatId}` : "latest";
}

function historyCacheOptions({
  workspaceSlug,
  threadSlug = null,
  kind = "page",
  cursor = "latest",
  detail = "light",
  surface = "desktop",
}) {
  return { workspaceSlug, threadSlug, kind, cursor, detail, surface };
}

function historyClient(threadSlug = null) {
  return threadSlug
    ? {
        bootstrap: (workspaceSlug, options) =>
          Workspace.threads.chatBootstrap(workspaceSlug, threadSlug, options),
        page: (workspaceSlug, options) =>
          Workspace.threads.chatHistoryPage(workspaceSlug, threadSlug, options),
        hydrate: (workspaceSlug, chatIds, options) =>
          Workspace.threads.chatHistoryHydration(
            workspaceSlug,
            threadSlug,
            chatIds,
            options
          ),
      }
    : {
        bootstrap: (workspaceSlug, options) =>
          Workspace.chatBootstrap(workspaceSlug, options),
        page: (workspaceSlug, options) =>
          Workspace.chatHistoryPage(workspaceSlug, options),
        hydrate: (workspaceSlug, chatIds, options) =>
          Workspace.chatHistoryHydration(workspaceSlug, chatIds, options),
      };
}

export default function WorkspaceChat({ loading, workspace }) {
  useWatchForAutoPlayAssistantTTSResponse();
  const { threadSlug = null } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    getDraft,
    mergeServerHistory,
    getThreadActivity,
    clearThreadActivity,
  } = useChatThreadDrafts();
  // Stores { key, workspace, history } currently rendered. On route changes we
  // switch this shell immediately so the user sees the target thread loading
  // instead of the previous thread while network work is still in flight.
  const [loaded, setLoaded] = useState(null);
  const restoredChatKeysRef = useRef(new Set());
  const historyAbortRef = useRef(null);
  const hydrationAbortRef = useRef(null);
  const olderAbortRef = useRef(null);
  const historySeqRef = useRef(0);
  const lastRouteFallbackRef = useRef(null);
  const [historyState, setHistoryState] = useState({
    page: null,
    loadingRecent: false,
    loadingOlder: false,
  });
  const [chatScrollMemory, setChatScrollMemory] = useState(null);
  const navigateIfChanged = useCallback(
    (to, options) => {
      const currentPath = `${location.pathname}${location.search}${location.hash}`;
      const targetPath =
        typeof to === "string"
          ? to
          : `${to?.pathname || ""}${to?.search || ""}${to?.hash || ""}`;
      if (!targetPath || targetPath === currentPath) return false;
      navigate(to, options);
      return true;
    },
    [location.hash, location.pathname, location.search, navigate]
  );
  const setLoadedIfChanged = useCallback((next) => {
    setLoaded((prev) => {
      if (
        prev?.key === next.key &&
        prev?.workspace === next.workspace &&
        prev?.threadSlug === next.threadSlug &&
        prev?.activeThread === next.activeThread &&
        prev?.history === next.history
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const mergeAndRenderHistory = useCallback(
    async ({
      key,
      workspace,
      threadSlug,
      activeThread,
      history,
      page,
      mode = "replace",
    }) => {
      setLoaded((prev) => {
        const base =
          prev?.key === key
            ? prev
            : { key, workspace, threadSlug, activeThread, history: [] };
        return {
          ...base,
          workspace,
          threadSlug,
          activeThread,
          history: mergeHistoryMessages(base.history, history, mode, {
            key,
            mode,
          }),
        };
      });
      if (page) {
        setHistoryState((prev) => ({
          ...prev,
          page,
          loadingRecent: false,
          loadingOlder: false,
        }));
      }
      mergeServerHistory({
        workspaceSlug: workspace.slug,
        threadSlug,
        history,
      });
    },
    [mergeServerHistory]
  );

  useEffect(() => {
    const seq = historySeqRef.current + 1;
    historySeqRef.current = seq;
    historyAbortRef.current?.abort();
    hydrationAbortRef.current?.abort();
    olderAbortRef.current?.abort();
    historyAbortRef.current = new AbortController();
    hydrationAbortRef.current = new AbortController();
    const historySignal = historyAbortRef.current.signal;
    const hydrationSignal = hydrationAbortRef.current.signal;
    requestPriorityQueue.clear((entry) =>
      String(entry.dedupeKey || "").startsWith("history:")
    );

    async function getHistory() {
      if (loading) return;
      if (!workspace?.slug) {
        setLoadedIfChanged({ key: "none", workspace: null, history: [] });
        return false;
      }

      const fallbackToWorkspaceEntry = (reason) => {
        const cachedThreads =
          workspaceNavigationCache.getThreads(workspace.slug, {
            allowStale: false,
          }) ||
          workspaceNavigationCache.getThreads(workspace.slug) ||
          [];
        const target = defaultWorkspacePath(workspace.slug, cachedThreads);
        const fallbackKey = `${workspace.slug}:${threadSlug || "__workspace__"}:${reason}:${target}`;
        if (lastRouteFallbackRef.current === fallbackKey) return false;
        lastRouteFallbackRef.current = fallbackKey;
        debugChatTurn("WorkspaceChat:routeFallback", {
          workspaceSlug: workspace.slug,
          requestedThreadSlug: threadSlug,
          reason,
          target,
        });
        navigateIfChanged(target, { replace: true });
        return false;
      };

      const loadThreadsForWorkspaceEntry = async () => {
        const freshThreads = workspaceNavigationCache.getThreads(
          workspace.slug,
          { allowStale: false }
        );
        if (Array.isArray(freshThreads)) {
          return { threads: freshThreads, trusted: true };
        }

        const staleThreads = workspaceNavigationCache.getThreads(
          workspace.slug
        );

        try {
          const result = await workspaceNavigationCache.runInFlight(
            `threads:${workspace.slug}`,
            () =>
              requestPriorityQueue.schedule(
                () =>
                  Workspace.threads.all(workspace.slug, {
                    signal: historySignal,
                    task: false,
                  }),
                {
                  priority: "P0",
                  label: "workspacechat:resolve-entry-threads",
                  kind: "navigation",
                  scope: {
                    route: "workspace-chat",
                    workspaceSlug: workspace.slug,
                    threadSlug: threadSlug || null,
                  },
                  policy: "foreground",
                  emergency: true,
                  signal: historySignal,
                  dedupeKey: `navigation:threads:${workspace.slug}`,
                }
              ),
            { reuseResolvedWithinMs: 1_500 }
          );
          return {
            threads: Array.isArray(result?.threads) ? result.threads : [],
            trusted: true,
          };
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          console.error(error);
          return {
            threads: Array.isArray(staleThreads) ? staleThreads : [],
            trusted: false,
          };
        }
      };

      const resolveWorkspaceRootEntry = async () => {
        setHistoryState({
          page: null,
          loadingRecent: true,
          loadingOlder: false,
        });
        setLoaded((prev) => {
          if (prev?.workspace?.slug === workspace.slug && prev?.threadSlug)
            return prev;
          return null;
        });

        const lastThreadSlug = getLastVisitedThreadSlug(workspace.slug);
        const { threads, trusted } = await loadThreadsForWorkspaceEntry();
        if (historySignal.aborted || historySeqRef.current !== seq)
          return false;

        const hasValidLastThread =
          !!lastThreadSlug &&
          threads.some((thread) => thread?.slug === lastThreadSlug);
        if (lastThreadSlug && trusted && !hasValidLastThread) {
          clearLastVisitedThread(workspace.slug, lastThreadSlug);
        }

        const target = resolveWorkspaceEntryPath(
          workspace.slug,
          threads,
          lastThreadSlug
        );
        const rootPath = paths.workspace.chat(workspace.slug);
        if (target !== rootPath) {
          debugChatTurn("WorkspaceChat:workspaceRootEntry", {
            workspaceSlug: workspace.slug,
            lastThreadSlug,
            hasValidLastThread,
            target,
          });
          navigateIfChanged(target, {
            replace: true,
            state: {
              workspaceEntry: hasValidLastThread
                ? "last-thread"
                : "workspace-entry",
            },
          });
          return false;
        }

        setHistoryState({
          page: null,
          loadingRecent: false,
          loadingOlder: false,
        });
        return true;
      };

      if (!threadSlug) {
        const shouldLoadRootHistory = await resolveWorkspaceRootEntry();
        if (!shouldLoadRootHistory) return false;
      }

      const key = `${workspace.slug}:${threadSlug ?? "default"}`;
      const scrollMemory = readChatScrollMemory(key);
      const restoreChatId = scrollMemory?.chatId || null;
      const initialHistoryCursor = anchorHistoryCursor(restoreChatId);
      setChatScrollMemory(scrollMemory);
      const draft = getDraft(workspace.slug, threadSlug);
      const needsServerHistoryRefresh = draftNeedsServerHistoryRefresh(draft);
      const historySurface = historySurfaceForDevice({ mobile: isMobile });
      const isMobileHistorySurface = historySurface === "mobile";
      const initialHistoryDetail = restoreChatId
        ? "full"
        : historyDetailForDevice({ surface: historySurface });
      const historyOptionsForSurface = (options = {}) =>
        historyRequestOptionsForDevice({
          mobile: isMobile,
          surface: historySurface,
          ...options,
        });
      WorkspaceChatPerfMarks.mark(`${key}:shell`);
      const rawCached = await threadHistoryCache.get(
        historyCacheOptions({
          workspaceSlug: workspace.slug,
          threadSlug,
          kind: "page",
          cursor: initialHistoryCursor,
          detail: initialHistoryDetail,
          surface: historySurface,
        })
      );
      const cached =
        isMobileHistorySurface &&
        lightChatIdsFromHistory(rawCached?.history).length
          ? null
          : rawCached;
      if (rawCached && !cached) {
        debugThreadSwitchFlicker("WorkspaceChat:skipLightMobileCache", {
          key,
          workspaceSlug: workspace.slug,
          threadSlug,
          initialHistoryCursor,
          lightChatIds: lightChatIdsFromHistory(rawCached.history).length,
        });
      }
      if (historySeqRef.current !== seq) return;
      debugThreadSwitchFlicker("WorkspaceChat:historyCache", {
        key,
        workspaceSlug: workspace.slug,
        threadSlug,
        initialHistoryCursor,
        cacheStatus: cached ? "hit" : "miss",
        cacheDetail: initialHistoryDetail,
        historySurface,
        cachedHistoryLength: cached?.history?.length || 0,
        hasDraft: !!draft,
        needsServerHistoryRefresh,
      });
      const cachedHistory = cached?.history || [];
      const cachedThread = cached?.thread || null;
      setHistoryState({
        page: cached?.page || null,
        loadingRecent: true,
        loadingOlder: false,
      });
      if (draft) {
        if (needsServerHistoryRefresh) {
          debugChatTurn("WorkspaceChat:needsServerHistoryRefresh", {
            key,
            workspaceSlug: workspace.slug,
            threadSlug,
            ...draftHistoryIntegrity(draft),
          });
        }
        setLoadedIfChanged({
          key,
          workspace,
          threadSlug,
          activeThread: cachedThread,
          history: cachedHistory,
        });
      } else if (cached) {
        setLoaded((prev) => {
          const canTrustEmptyCache =
            prev?.key === key || cachedHistory.length > 0;
          if (!canTrustEmptyCache) return prev?.history?.length ? prev : null;
          return {
            key,
            workspace,
            threadSlug,
            activeThread: cachedThread,
            history: cachedHistory,
          };
        });
      } else {
        setLoadedIfChanged({
          key,
          workspace,
          threadSlug,
          activeThread: null,
          history: [],
        });
      }
      if (cached?.page)
        setHistoryState((prev) => ({ ...prev, page: cached.page }));
      WorkspaceChatPerfMarks.measure(
        "thread shell",
        `${key}:shell`,
        "threadShellMs"
      );

      const client = historyClient(threadSlug);
      const firstPageStartedAt = performance.now();
      let currentHistoryDetail = initialHistoryDetail;
      const firstPageOptions = restoreChatId
        ? {
            limit: ANCHOR_PAGE_LIMIT,
            detail: "full",
            priorityWindow: ANCHOR_PRIORITY_FULL_WINDOW,
            anchorChatId: restoreChatId,
            signal: historySignal,
            task: false,
          }
        : historyOptionsForSurface({
            limit: FIRST_PAGE_LIMIT,
            priorityWindow: PRIORITY_FULL_WINDOW,
            signal: historySignal,
            task: false,
          });
      let payload = await requestPriorityQueue.schedule(
        () => client.bootstrap(workspace.slug, firstPageOptions),
        {
          priority: "P0",
          label: "workspacechat:first-page",
          kind: "chat",
          scope: {
            route: "workspace-chat",
            workspaceSlug: workspace.slug,
            threadSlug: threadSlug || null,
          },
          policy: "foreground",
          emergency: true,
          signal: historySignal,
          dedupeKey: `history:first:${key}:${initialHistoryCursor}`,
        }
      );
      if (!payload || historySignal.aborted || historySeqRef.current !== seq) {
        debugThreadSwitchFlicker("WorkspaceChat:firstPageSkipped", {
          key,
          workspaceSlug: workspace.slug,
          threadSlug,
          durationMs: Math.round(performance.now() - firstPageStartedAt),
          reason: !payload ? "empty-or-aborted" : "stale-sequence",
        });
        return;
      }
      const activeThread = payload.thread || null;
      if (threadSlug && !activeThread) {
        if (threadSlug === getLastVisitedThreadSlug(workspace.slug)) {
          clearLastVisitedThread(workspace.slug, threadSlug);
        }
        return fallbackToWorkspaceEntry("invalid-thread");
      }
      if (isOverviewThread(activeThread)) {
        setHistoryState({
          page: null,
          loadingRecent: false,
          loadingOlder: false,
        });
        setLoadedIfChanged({
          key,
          workspace,
          threadSlug,
          activeThread,
          history: [],
        });
        setChatScrollMemory(null);
        return false;
      }
      let effectiveRestoreChatId = restoreChatId;
      if (restoreChatId && payload.page?.anchorFound === false) {
        setChatScrollMemory(null);
        effectiveRestoreChatId = null;
        const fallbackOptions = historyOptionsForSurface({
          limit: FIRST_PAGE_LIMIT,
          priorityWindow: PRIORITY_FULL_WINDOW,
        });
        currentHistoryDetail = fallbackOptions.detail;
        payload = await requestPriorityQueue.schedule(
          () =>
            client.bootstrap(workspace.slug, {
              ...fallbackOptions,
              signal: historySignal,
              task: false,
            }),
          {
            priority: "P0",
            label: "workspacechat:first-page-fallback",
            kind: "chat",
            scope: {
              route: "workspace-chat",
              workspaceSlug: workspace.slug,
              threadSlug: threadSlug || null,
            },
            policy: "foreground",
            emergency: true,
            signal: historySignal,
            dedupeKey: `history:first-fallback:${key}`,
          }
        );
        if (!payload || historySignal.aborted || historySeqRef.current !== seq)
          return;
      }
      let chatHistory = payload.history || [];
      let currentPage = payload.page || null;
      const mobileLightChatIds = isMobileHistorySurface
        ? lightChatIdsFromHistory(chatHistory)
        : [];
      if (mobileLightChatIds.length > 0) {
        const hydration = await requestPriorityQueue.schedule(
          () =>
            client.hydrate(workspace.slug, mobileLightChatIds, {
              signal: historySignal,
              task: false,
            }),
          {
            priority: "P1",
            label: "workspacechat:mobile-light-hydrate",
            kind: "chat",
            scope: {
              route: "workspace-chat",
              workspaceSlug: workspace.slug,
              threadSlug: threadSlug || null,
            },
            policy: "visible",
            signal: historySignal,
            dedupeKey: `history:mobile-hydrate:${key}:${mobileLightChatIds.join(",")}`,
          }
        );
        if (historySignal.aborted || historySeqRef.current !== seq) return;
        if (hydration?.history?.length) {
          chatHistory = mergeHistoryMessages(
            chatHistory,
            hydration.history,
            "append",
            {
              key,
              mode: "mobile-light-hydrate",
            }
          );
          currentPage = currentPage
            ? { ...currentPage, lightChatIds: [] }
            : currentPage;
          currentHistoryDetail = "full";
        }
      }
      debugThreadSwitchFlicker("WorkspaceChat:firstPageLoaded", {
        key,
        workspaceSlug: workspace.slug,
        threadSlug,
        durationMs: Math.round(performance.now() - firstPageStartedAt),
        historyLength: chatHistory.length,
        lightChatIds: currentPage?.lightChatIds?.length || 0,
        historySurface,
        detail: currentHistoryDetail,
        scrollMemoryChatId: effectiveRestoreChatId || null,
        anchorFound: currentPage?.anchorFound ?? null,
        scrollMemoryPrefetchAttempt: 0,
      });
      const latestDraft = getDraft(workspace.slug, threadSlug);
      const latestDraftNeedsRefresh =
        draftNeedsServerHistoryRefresh(latestDraft);
      if (!restoredChatKeysRef.current.has(key) || latestDraftNeedsRefresh) {
        debugChatTurn("WorkspaceChat:mergeServerHistory", {
          key,
          workspaceSlug: workspace.slug,
          threadSlug,
          historyLength: chatHistory.length,
          wasAlreadyRestored: restoredChatKeysRef.current.has(key),
          needsServerHistoryRefresh:
            needsServerHistoryRefresh || latestDraftNeedsRefresh,
          ...draftHistoryIntegrity(latestDraft),
        });
        restoredChatKeysRef.current.add(key);
      }
      if (historySignal.aborted || historySeqRef.current !== seq) return;
      await mergeAndRenderHistory({
        key,
        workspace,
        threadSlug,
        activeThread,
        history: chatHistory,
        page: currentPage,
        mode: "replace",
      });
      if (lightChatIdsFromHistory(chatHistory).length === 0) {
        threadHistoryCache.set(
          historyCacheOptions({
            workspaceSlug: workspace.slug,
            threadSlug,
            kind: "page",
            cursor: anchorHistoryCursor(effectiveRestoreChatId),
            detail: currentHistoryDetail,
            surface: historySurface,
          }),
          { history: chatHistory, page: currentPage, thread: activeThread }
        );
      }
      WorkspaceChatPerfMarks.measure(
        "last 5 readable",
        `${key}:shell`,
        "lastFiveReadableMs"
      );

      if (effectiveRestoreChatId && currentPage?.anchorFound === true) {
        const newerAfterChatId =
          currentPage?.newerAfterChatId || currentPage?.nextAfterChatId;
        if (currentPage?.hasNewer && newerAfterChatId) {
          requestPriorityQueue.schedule(
            async () => {
              const newerOptions = historyOptionsForSurface({
                limit: FIRST_PAGE_LIMIT,
                afterChatId: newerAfterChatId,
                priorityWindow: PRIORITY_FULL_WINDOW,
              });
              const newerPayload = await client.page(workspace.slug, {
                ...newerOptions,
                signal: historySignal,
                task: false,
              });
              if (
                !newerPayload?.history?.length ||
                historySignal.aborted ||
                historySeqRef.current !== seq
              ) {
                return null;
              }
              await mergeAndRenderHistory({
                key,
                workspace,
                threadSlug,
                activeThread,
                history: newerPayload.history,
                mode: "append",
              });
              threadHistoryCache.set(
                historyCacheOptions({
                  workspaceSlug: workspace.slug,
                  threadSlug,
                  kind: "page",
                  cursor: `newer:${newerAfterChatId}`,
                  detail: newerOptions.detail,
                  surface: historySurface,
                }),
                {
                  history: newerPayload.history,
                  page: newerPayload.page,
                  thread: activeThread,
                }
              );
              return newerPayload;
            },
            {
              priority: "P4",
              label: "workspacechat:newer-page",
              kind: "prefetch",
              scope: {
                route: "workspace-chat",
                workspaceSlug: workspace.slug,
                threadSlug: threadSlug || null,
              },
              policy: "maintenance",
              signal: historySignal,
              dedupeKey: `history:newer:${key}:${newerAfterChatId}`,
            }
          );
        }

        requestPriorityQueue.schedule(
          async () => {
            if (!historyContainsChatId(chatHistory, effectiveRestoreChatId)) {
              return null;
            }
            await new Promise((resolve) =>
              setTimeout(resolve, BACKGROUND_HYDRATE_DELAY_MS)
            );
            if (hydrationSignal.aborted) return null;
            const memoryHydration = await client.hydrate(
              workspace.slug,
              [effectiveRestoreChatId],
              { signal: hydrationSignal, task: false }
            );
            if (
              memoryHydration?.history?.length &&
              !hydrationSignal.aborted &&
              historySeqRef.current === seq
            ) {
              await mergeAndRenderHistory({
                key,
                workspace,
                threadSlug,
                activeThread,
                history: memoryHydration.history,
                mode: "append",
              });
              threadHistoryCache.set(
                historyCacheOptions({
                  workspaceSlug: workspace.slug,
                  threadSlug,
                  kind: "hydrate",
                  cursor: String(effectiveRestoreChatId),
                  detail: "full",
                  surface: historySurface,
                }),
                memoryHydration,
                { indexed: true }
              );
            }
          },
          {
            priority: "P4",
            label: "workspacechat:scroll-memory-hydrate",
            kind: "prefetch",
            scope: {
              route: "workspace-chat",
              workspaceSlug: workspace.slug,
              threadSlug: threadSlug || null,
            },
            policy: "maintenance",
            signal: hydrationSignal,
            dedupeKey: `history:scroll-memory-hydrate:${key}:${effectiveRestoreChatId}`,
          }
        );
      }

      const lightChatIds = lightChatIdsFromHistory(chatHistory)
        .filter((chatId) => chatId !== effectiveRestoreChatId)
        .slice(isMobileHistorySurface ? 0 : -BACKGROUND_HYDRATE_BATCH_SIZE);
      if (lightChatIds.length > 0) {
        requestPriorityQueue.schedule(
          async () => {
            if (!isMobileHistorySurface) {
              await new Promise((resolve) =>
                setTimeout(
                  resolve,
                  effectiveRestoreChatId
                    ? BACKGROUND_HYDRATE_DELAY_MS * 2
                    : BACKGROUND_HYDRATE_DELAY_MS
                )
              );
            }
            if (hydrationSignal.aborted) return null;
            const hydration = await client.hydrate(
              workspace.slug,
              lightChatIds,
              {
                signal: hydrationSignal,
                task: false,
              }
            );
            if (
              !hydration?.history?.length ||
              hydrationSignal.aborted ||
              historySeqRef.current !== seq
            ) {
              return null;
            }
            await mergeAndRenderHistory({
              key,
              workspace,
              threadSlug,
              activeThread,
              history: hydration.history,
              mode: "append",
            });
            threadHistoryCache.set(
              historyCacheOptions({
                workspaceSlug: workspace.slug,
                threadSlug,
                kind: "hydrate",
                cursor: lightChatIds.join(","),
                detail: "full",
                surface: historySurface,
              }),
              hydration,
              { indexed: true }
            );
            return hydration;
          },
          {
            priority: isMobileHistorySurface ? "P1" : "P4",
            label: "workspacechat:hydrate-background-batch",
            kind: "prefetch",
            scope: {
              route: "workspace-chat",
              workspaceSlug: workspace.slug,
              threadSlug: threadSlug || null,
            },
            policy: isMobileHistorySurface ? "visible" : "maintenance",
            signal: hydrationSignal,
            dedupeKey: `history:hydrate:${key}:${lightChatIds.join(",")}`,
          }
        );
      }
    }
    getHistory().catch((error) => {
      if (error?.name !== "AbortError") console.error(error);
    });
    return () => {
      historyAbortRef.current?.abort();
      hydrationAbortRef.current?.abort();
    };
  }, [
    workspace?.slug,
    loading,
    threadSlug,
    getDraft,
    mergeAndRenderHistory,
    navigateIfChanged,
    setLoadedIfChanged,
  ]);

  const loadOlderHistory = useCallback(async () => {
    if (!loaded?.workspace?.slug || historyState.loadingOlder) return;
    if (
      historyState.page &&
      !(historyState.page.hasOlder ?? historyState.page.hasMore)
    )
      return;
    const beforeChatId =
      historyState.page?.olderBeforeChatId ||
      historyState.page?.nextBeforeChatId ||
      loaded.history.find((message) => message.chatId)?.chatId;
    if (!beforeChatId) return;

    olderAbortRef.current?.abort();
    olderAbortRef.current = new AbortController();
    const olderSignal = olderAbortRef.current.signal;
    const olderSeq = historySeqRef.current;
    setHistoryState((prev) => ({ ...prev, loadingOlder: true }));

    const client = historyClient(loaded.threadSlug);
    const historySurface = historySurfaceForDevice({ mobile: isMobile });
    const olderOptions = historyRequestOptionsForDevice({
      mobile: isMobile,
      surface: historySurface,
      limit: FIRST_PAGE_LIMIT,
      beforeChatId,
      priorityWindow: PRIORITY_FULL_WINDOW,
    });
    const payload = await requestPriorityQueue.schedule(
      () =>
        client.page(loaded.workspace.slug, {
          ...olderOptions,
          signal: olderSignal,
          task: false,
        }),
      {
        priority: "P3",
        label: "workspacechat:older-page",
        kind: "prefetch",
        scope: {
          route: "workspace-chat",
          workspaceSlug: loaded.workspace.slug,
          threadSlug: loaded.threadSlug || null,
        },
        policy: "prefetch",
        signal: olderSignal,
        dedupeKey: `history:older:${loaded.key}:${beforeChatId}`,
      }
    );

    if (olderSignal.aborted || historySeqRef.current !== olderSeq) return;
    if (!payload?.history?.length) {
      setHistoryState((prev) => ({ ...prev, loadingOlder: false }));
      return;
    }
    await mergeAndRenderHistory({
      key: loaded.key,
      workspace: loaded.workspace,
      threadSlug: loaded.threadSlug,
      activeThread: loaded.activeThread,
      history: payload.history,
      page: payload.page,
      mode: "prepend",
    });
  }, [
    historyState.loadingOlder,
    historyState.page,
    loaded,
    mergeAndRenderHistory,
  ]);

  useEffect(() => {
    if (!workspace?.slug) return;
    const activity = getThreadActivity(workspace.slug, threadSlug);
    if (["completed", "failed"].includes(activity?.status)) {
      clearThreadActivity(workspace.slug, threadSlug);
    }
  }, [workspace?.slug, threadSlug, getThreadActivity, clearThreadActivity]);

  const hasPendingMessage = !!sessionStorage.getItem(PENDING_HOME_MESSAGE);
  useEffect(() => {
    debugThreadSwitchFlicker("WorkspaceChat:loadingShell", {
      workspaceSlug: workspace?.slug || null,
      threadSlug,
      loading,
      loadedKey: loaded?.key || null,
      skeletonVisible: loaded === null && !hasPendingMessage,
      pendingMessageShellVisible: loaded === null && hasPendingMessage,
    });
  }, [hasPendingMessage, loaded, loading, threadSlug, workspace?.slug]);

  if (loaded === null) {
    if (hasPendingMessage) {
      return (
        <div className="motion-hover relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full" />
      );
    }
    return <LoadingChat />;
  }
  if (!loading && !workspace) {
    return (
      <>
        {loading === false && !workspace && (
          <ModalWrapper isOpen={true}>
            <div className="w-full max-w-2xl bg-theme-bg-secondary rounded-lg shadow border-2 border-theme-modal-border overflow-hidden">
              <div className="relative p-6 border-b rounded-t border-theme-modal-border">
                <div className="w-full flex gap-x-2 items-center">
                  <WarningCircle
                    className="text-red-500 w-6 h-6"
                    weight="fill"
                  />
                  <h3 className="text-xl font-semibold text-red-500 overflow-hidden overflow-ellipsis whitespace-nowrap">
                    Workspace not found
                  </h3>
                </div>
              </div>
              <div className="py-7 px-9 space-y-2 flex-col">
                <p className="text-white text-sm">
                  The workspace you're looking for is not available. It may have
                  been deleted or you may not have access to it.
                </p>
              </div>
              <div className="flex w-full justify-end items-center p-6 space-x-2 border-t border-theme-modal-border rounded-b">
                <Link
                  to={paths.home()}
                  className="motion-hover bg-white text-black hover:opacity-60 px-4 py-2 rounded-lg text-sm"
                >
                  Return to homepage
                </Link>
              </div>
            </div>
          </ModalWrapper>
        )}
        <LoadingChat />
      </>
    );
  }
  if (
    loaded?.activeThread === null &&
    historyState.loadingRecent &&
    loaded.history.length === 0
  ) {
    return <LoadingChat />;
  }

  setEventDelegatorForCodeSnippets();
  return (
    <TTSProvider>
      <DnDFileUploaderProvider
        workspace={loaded.workspace}
        threadSlug={loaded.threadSlug}
      >
        <ChatContainer
          key={loaded.key}
          workspace={loaded.workspace}
          threadSlug={loaded.threadSlug}
          activeThread={loaded.activeThread}
          knownHistory={loaded.history}
          hasMoreHistory={
            !!(historyState.page?.hasOlder ?? historyState.page?.hasMore)
          }
          isLoadingOlderHistory={historyState.loadingOlder}
          onLoadOlderHistory={loadOlderHistory}
          chatScrollMemory={chatScrollMemory}
        />
      </DnDFileUploaderProvider>
    </TTSProvider>
  );
}

export { setEventDelegatorForCodeSnippets };
