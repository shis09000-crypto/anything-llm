import React, { useCallback, useEffect, useRef, useState } from "react";
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
  shouldFetchOlderForChatScrollMemory,
} from "@/utils/chat/chatScrollMemory";
import {
  defaultWorkspacePath,
  isOverviewThread,
} from "@/utils/workspaceThreads";

const FIRST_PAGE_LIMIT = 20;
const PRIORITY_FULL_WINDOW = 0;
const BACKGROUND_HYDRATE_BATCH_SIZE = 1;
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
    getRunningThread,
    getThreadPath,
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
  const [historyState, setHistoryState] = useState({
    page: null,
    loadingRecent: false,
    loadingOlder: false,
  });
  const [chatScrollMemory, setChatScrollMemory] = useState(null);
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
    historyAbortRef.current = new AbortController();
    hydrationAbortRef.current = new AbortController();

    async function getHistory() {
      if (loading) return;
      if (!workspace?.slug) {
        setLoadedIfChanged({ key: "none", workspace: null, history: [] });
        return false;
      }

      const redirectToDefaultThread = async (reason) => {
        const { threads } = await Workspace.threads.all(workspace.slug);
        if (historySeqRef.current !== seq) return false;
        debugChatTurn("WorkspaceChat:routeFallback", {
          workspaceSlug: workspace.slug,
          requestedThreadSlug: threadSlug,
          availableThreadCount: threads.length,
          hasUserSelectedState: !!location.state?.userSelectedThread,
          reason,
        });
        navigate(defaultWorkspacePath(workspace.slug, threads), {
          replace: true,
        });
        return false;
      };

      const runningThread = getRunningThread(workspace.slug);
      if (
        !location.state?.userSelectedThread &&
        !threadSlug &&
        runningThread?.threadSlug
      ) {
        debugChatTurn("WorkspaceChat:routeFallback", {
          workspaceSlug: workspace.slug,
          requestedThreadSlug: threadSlug,
          runningThreadSlug: runningThread.threadSlug,
          reason: "running-thread-resume",
        });
        navigate(getThreadPath(workspace.slug, runningThread.threadSlug), {
          replace: true,
        });
        return false;
      }

      if (!threadSlug) return redirectToDefaultThread("missing-thread");

      const key = `${workspace.slug}:${threadSlug ?? "default"}`;
      const scrollMemory = readChatScrollMemory(key);
      setChatScrollMemory(scrollMemory);
      const draft = getDraft(workspace.slug, threadSlug);
      const needsServerHistoryRefresh = draftNeedsServerHistoryRefresh(draft);
      WorkspaceChatPerfMarks.mark(`${key}:shell`);
      const cached = await threadHistoryCache.get({
        workspaceSlug: workspace.slug,
        threadSlug,
        kind: "page",
        cursor: "latest",
      });
      if (historySeqRef.current !== seq) return;
      debugThreadSwitchFlicker("WorkspaceChat:historyCache", {
        key,
        workspaceSlug: workspace.slug,
        threadSlug,
        cacheStatus: cached ? "hit" : "miss",
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
      const payload = await requestPriorityQueue.schedule(
        () =>
          client.bootstrap(workspace.slug, {
            limit: FIRST_PAGE_LIMIT,
            detail: "light",
            priorityWindow: PRIORITY_FULL_WINDOW,
            signal: historyAbortRef.current.signal,
          }),
        {
          priority: "P0",
          label: "workspacechat:first-page",
          signal: historyAbortRef.current.signal,
          dedupeKey: `history:first:${key}`,
        }
      );
      if (!payload || historySeqRef.current !== seq) {
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
      if (!activeThread) return redirectToDefaultThread("invalid-thread");
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
      let chatHistory = payload.history || [];
      let currentPage = payload.page || null;
      debugThreadSwitchFlicker("WorkspaceChat:firstPageLoaded", {
        key,
        workspaceSlug: workspace.slug,
        threadSlug,
        durationMs: Math.round(performance.now() - firstPageStartedAt),
        historyLength: chatHistory.length,
        lightChatIds: currentPage?.lightChatIds?.length || 0,
        scrollMemoryChatId: scrollMemory?.chatId || null,
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
      await mergeAndRenderHistory({
        key,
        workspace,
        threadSlug,
        activeThread,
        history: chatHistory,
        page: currentPage,
        mode: "replace",
      });
      threadHistoryCache.set(
        {
          workspaceSlug: workspace.slug,
          threadSlug,
          kind: "page",
          cursor: "latest",
        },
        { history: chatHistory, page: currentPage, thread: activeThread }
      );
      WorkspaceChatPerfMarks.measure(
        "last 5 readable",
        `${key}:shell`,
        "lastFiveReadableMs"
      );

      if (
        scrollMemory?.chatId &&
        !historyContainsChatId(chatHistory, scrollMemory.chatId) &&
        currentPage?.hasMore
      ) {
        requestPriorityQueue.schedule(
          async () => {
            let memoryPrefetchAttempt = 0;
            let memoryPage = currentPage;
            let memoryHistory = chatHistory;
            while (
              shouldFetchOlderForChatScrollMemory({
                memory: scrollMemory,
                history: memoryHistory,
                page: memoryPage,
                attempt: memoryPrefetchAttempt,
              })
            ) {
              const beforeChatId =
                memoryPage?.nextBeforeChatId ||
                memoryHistory.find((message) => message.chatId)?.chatId;
              if (!beforeChatId) break;
              memoryPrefetchAttempt += 1;
              const olderPayload = await client.page(workspace.slug, {
                limit: FIRST_PAGE_LIMIT,
                beforeChatId,
                detail: "light",
                priorityWindow: 0,
                signal: historyAbortRef.current.signal,
              });
              if (
                !olderPayload?.history?.length ||
                historySeqRef.current !== seq
              ) {
                break;
              }
              memoryHistory = mergeHistoryMessages(
                memoryHistory,
                olderPayload.history,
                "prepend",
                {
                  key,
                  mode: "scroll-memory-prefetch",
                }
              );
              memoryPage = olderPayload.page || memoryPage;
              await mergeAndRenderHistory({
                key,
                workspace,
                threadSlug,
                activeThread,
                history: olderPayload.history,
                page: olderPayload.page || memoryPage,
                mode: "prepend",
              });
            }
            if (
              scrollMemory?.chatId &&
              historyContainsChatId(memoryHistory, scrollMemory.chatId)
            ) {
              const memoryHydration = await client.hydrate(
                workspace.slug,
                [scrollMemory.chatId],
                { signal: hydrationAbortRef.current.signal }
              );
              if (
                memoryHydration?.history?.length &&
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
                  {
                    workspaceSlug: workspace.slug,
                    threadSlug,
                    kind: "hydrate",
                    cursor: String(scrollMemory.chatId),
                  },
                  memoryHydration,
                  { indexed: true }
                );
              }
            }
            debugThreadSwitchFlicker("WorkspaceChat:scrollMemoryBackfill", {
              key,
              workspaceSlug: workspace.slug,
              threadSlug,
              scrollMemoryChatId: scrollMemory.chatId,
              attempts: memoryPrefetchAttempt,
            });
          },
          {
            priority: "P3",
            label: "workspacechat:scroll-memory-backfill",
            signal: historyAbortRef.current.signal,
            dedupeKey: `history:scroll-memory-backfill:${key}:${scrollMemory.chatId}`,
          }
        );
      } else if (
        scrollMemory?.chatId &&
        historyContainsChatId(chatHistory, scrollMemory.chatId)
      ) {
        requestPriorityQueue.schedule(
          async () => {
            await new Promise((resolve) =>
              setTimeout(resolve, BACKGROUND_HYDRATE_DELAY_MS)
            );
            if (hydrationAbortRef.current.signal.aborted) return null;
            const memoryHydration = await client.hydrate(
              workspace.slug,
              [scrollMemory.chatId],
              { signal: hydrationAbortRef.current.signal }
            );
            if (
              memoryHydration?.history?.length &&
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
                {
                  workspaceSlug: workspace.slug,
                  threadSlug,
                  kind: "hydrate",
                  cursor: String(scrollMemory.chatId),
                },
                memoryHydration,
                { indexed: true }
              );
            }
          },
          {
            priority: "P4",
            label: "workspacechat:scroll-memory-hydrate",
            signal: hydrationAbortRef.current.signal,
            dedupeKey: `history:scroll-memory-hydrate:${key}:${scrollMemory.chatId}`,
          }
        );
      }

      const lightChatIds = lightChatIdsFromHistory(chatHistory)
        .filter((chatId) => chatId !== scrollMemory?.chatId)
        .slice(-BACKGROUND_HYDRATE_BATCH_SIZE);
      if (lightChatIds.length > 0) {
        requestPriorityQueue.schedule(
          async () => {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                scrollMemory?.chatId
                  ? BACKGROUND_HYDRATE_DELAY_MS * 2
                  : BACKGROUND_HYDRATE_DELAY_MS
              )
            );
            if (hydrationAbortRef.current.signal.aborted) return null;
            const hydration = await client.hydrate(
              workspace.slug,
              lightChatIds,
              {
                signal: hydrationAbortRef.current.signal,
              }
            );
            if (!hydration?.history?.length || historySeqRef.current !== seq) {
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
              {
                workspaceSlug: workspace.slug,
                threadSlug,
                kind: "hydrate",
                cursor: lightChatIds.join(","),
              },
              hydration,
              { indexed: true }
            );
            return hydration;
          },
          {
            priority: "P4",
            label: "workspacechat:hydrate-background-batch",
            signal: hydrationAbortRef.current.signal,
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
    workspace,
    loading,
    threadSlug,
    getDraft,
    getRunningThread,
    getThreadPath,
    location.state?.userSelectedThread,
    mergeAndRenderHistory,
    navigate,
    setLoadedIfChanged,
  ]);

  const loadOlderHistory = useCallback(async () => {
    if (!loaded?.workspace?.slug || historyState.loadingOlder) return;
    if (historyState.page && !historyState.page.hasMore) return;
    const beforeChatId =
      historyState.page?.nextBeforeChatId ||
      loaded.history.find((message) => message.chatId)?.chatId;
    if (!beforeChatId) return;

    olderAbortRef.current?.abort();
    olderAbortRef.current = new AbortController();
    setHistoryState((prev) => ({ ...prev, loadingOlder: true }));

    const client = historyClient(loaded.threadSlug);
    const payload = await requestPriorityQueue.schedule(
      () =>
        client.page(loaded.workspace.slug, {
          limit: FIRST_PAGE_LIMIT,
          beforeChatId,
          detail: "light",
          priorityWindow: 0,
          signal: olderAbortRef.current.signal,
        }),
      {
        priority: "P3",
        label: "workspacechat:older-page",
        signal: olderAbortRef.current.signal,
        dedupeKey: `history:older:${loaded.key}:${beforeChatId}`,
      }
    );

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
          hasMoreHistory={!!historyState.page?.hasMore}
          isLoadingOlderHistory={historyState.loadingOlder}
          onLoadOlderHistory={loadOlderHistory}
          chatScrollMemory={chatScrollMemory}
        />
      </DnDFileUploaderProvider>
    </TTSProvider>
  );
}

export { setEventDelegatorForCodeSnippets };
