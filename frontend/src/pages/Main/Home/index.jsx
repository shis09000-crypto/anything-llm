import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { SidebarMobileHeader } from "@/components/Sidebar";
import PromptInput, {
  PROMPT_INPUT_EVENT,
  PROMPT_INPUT_ID,
} from "@/components/WorkspaceChat/ChatContainer/PromptInput";
import DnDFileUploaderWrapper, {
  DndUploaderContext,
  DnDFileUploaderProvider,
  PASTE_ATTACHMENT_EVENT,
} from "@/components/WorkspaceChat/ChatContainer/DnDWrapper";
import { useTranslation } from "react-i18next";
import AppButton from "@/components/lib/AppButton";
import { PENDING_HOME_MESSAGE } from "@/utils/constants";
import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import QuickActions from "@/components/lib/QuickActions";
import SuggestedMessages from "@/components/lib/SuggestedMessages";
import WorkspaceModelPicker from "@/components/WorkspaceChat/ChatContainer/WorkspaceModelPicker";
import { ChatTooltips } from "@/components/WorkspaceChat/ChatContainer/ChatTooltips";
import {
  useChatThreadDrafts,
  useThreadActivitySnapshot,
} from "@/contexts/ChatThreadDraftProvider";
import WorkspaceHealthBeacon from "@/components/WorkspaceHealthBeacon";
import { WorkspaceHealthProvider } from "@/contexts/WorkspaceHealthProvider";
import useLoginMode from "@/hooks/useLoginMode";
import {
  clearLastVisitedThread,
  getLastVisitedThreadSlug,
  getLastVisitedWorkspace,
  pathForLastVisitedThread,
} from "@/utils/lastVisitedWorkspace";
import { mobileRuntimeActive } from "@/utils/mobileRuntime";
import { defaultWorkspacePath } from "@/utils/workspaceThreads";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { requestWorkspaceCreate } from "@/utils/workspaceOptimisticController";

async function getWorkspaceFromCacheOrNetwork(slug) {
  if (!slug) return null;
  const cached = workspaceNavigationCache.getWorkspaceDetail(slug, {
    allowStale: false,
  });
  if (cached) return cached;
  return workspaceNavigationCache.runInFlight(
    `workspace:${slug}`,
    ({ signal } = {}) =>
      Workspace.bySlug(slug, {
        signal,
        communicationScene: "workspace-navigation",
        task: false,
      }),
    {
      priority: "P0",
      label: "home:workspace-detail",
      scope: { route: "home", workspaceSlug: slug },
      policy: "foreground",
      emergency: true,
      intentRank: 0,
      dedupeKey: `navigation:workspace:${slug}`,
    }
  );
}

async function getThreadsFromCacheOrNetwork(slug) {
  if (!slug) return [];
  const cached = workspaceNavigationCache.getThreads(slug, {
    allowStale: false,
  });
  if (Array.isArray(cached)) return cached;
  const result = await workspaceNavigationCache.runInFlight(
    `threads:${slug}`,
    ({ signal } = {}) =>
      Workspace.threads.all(slug, {
        signal,
        communicationScene: "workspace-navigation",
        task: false,
      }),
    {
      priority: "P0",
      label: "home:resolve-last-thread",
      scope: {
        route: "home",
        workspaceSlug: slug,
        surface: "threads",
      },
      policy: "foreground",
      emergency: true,
      intentRank: 1,
      dedupeKey: `navigation:threads:${slug}`,
    }
  );
  return Array.isArray(result?.threads) ? result.threads : [];
}

async function getWorkspacesFromCacheOrNetwork() {
  const cached = workspaceNavigationCache.getWorkspaces({ allowStale: false });
  if (Array.isArray(cached)) return cached;
  const workspaces = await workspaceNavigationCache.runInFlight(
    "workspaces",
    ({ signal } = {}) =>
      Workspace.all({
        signal,
        communicationScene: "workspace-navigation",
        task: false,
      }),
    {
      priority: "P0",
      label: "home:workspaces",
      scope: { route: "home", surface: "workspaces" },
      policy: "foreground",
      emergency: true,
      intentRank: 0,
      dedupeKey: "navigation:workspaces",
    }
  );
  return Array.isArray(workspaces) ? workspaces : [];
}

async function getTargetWorkspace() {
  const lastVisited = getLastVisitedWorkspace();
  if (lastVisited?.slug) {
    const workspace = await getWorkspaceFromCacheOrNetwork(lastVisited.slug);
    if (workspace) {
      const threadSlug = getLastVisitedThreadSlug(workspace.slug);
      if (threadSlug) {
        const threads = await getThreadsFromCacheOrNetwork(workspace.slug);
        const threadExists = threads.some(
          (thread) => thread.slug === threadSlug
        );
        if (!threadExists) {
          clearLastVisitedThread(workspace.slug, threadSlug);
          return {
            workspace,
            redirectPath: defaultWorkspacePath(workspace.slug, threads),
          };
        }
      }
      return {
        workspace,
        redirectPath: pathForLastVisitedThread(workspace.slug),
      };
    }
  }

  const workspaces = await getWorkspacesFromCacheOrNetwork();
  return {
    workspace: workspaces.length > 0 ? workspaces[0] : null,
    redirectPath:
      workspaces.length > 0 ? paths.workspace.chat(workspaces[0].slug) : null,
  };
}

async function createDefaultWorkspace(workspaceName = "My Workspace") {
  const action = requestWorkspaceCreate({
    name: workspaceName,
  });
  const outcome = await action?.handle?.promise;
  const { workspace, message: errorMsg } = outcome?.result || {};
  if (!workspace) {
    showToast(
      errorMsg || outcome?.error?.message || "Failed to create workspace",
      "error"
    );
    return null;
  }
  return workspace;
}

export default function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mobileLayoutActive = mobileRuntimeActive();
  const [workspace, setWorkspace] = useState(null);
  const [threadSlug, setThreadSlug] = useState(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const pendingFilesRef = useRef([]);
  const { hasWorkspaceActivity, getRunningThread, getThreadPath } =
    useChatThreadDrafts();
  useThreadActivitySnapshot();

  const navigateToRunningThread = useCallback(
    (workspaceSlug) => {
      const runningThread = getRunningThread(workspaceSlug);
      if (!runningThread) return false;
      navigate(getThreadPath(workspaceSlug, runningThread.threadSlug));
      return true;
    },
    [getRunningThread, getThreadPath, navigate]
  );

  useEffect(() => {
    async function init() {
      const { workspace: ws, redirectPath } = await getTargetWorkspace();
      if (ws) {
        if (redirectPath) {
          navigate(redirectPath, { replace: true });
          return;
        }
        const [suggestedMessages, { showAgentCommand }] = await Promise.all([
          Workspace.getSuggestedMessages(ws.slug),
          Workspace.agentCommandAvailable(ws.slug),
        ]);
        setWorkspace({
          ...ws,
          suggestedMessages,
          showAgentCommand,
        });
      }
      setWorkspaceLoading(false);
    }
    init();
  }, [navigate]);

  // When workspace/thread becomes available and we have pending files, trigger upload
  useEffect(() => {
    if (workspace && threadSlug && pendingFilesRef.current.length > 0) {
      const files = pendingFilesRef.current;
      pendingFilesRef.current = [];
      window.dispatchEvent(
        new CustomEvent(PASTE_ATTACHMENT_EVENT, { detail: { files } })
      );
    }
  }, [workspace, threadSlug]);

  // Handle paste events when no thread exists yet
  useEffect(() => {
    if (threadSlug) return;

    async function handlePaste(e) {
      const files = e.detail?.files;
      if (!files?.length) return;

      pendingFilesRef.current = files;
      let ws = workspace;
      if (!ws) {
        ws = await createDefaultWorkspace(t("new-workspace.placeholder"));
        if (!ws) return;
        setWorkspace(ws);
      }
      if (navigateToRunningThread(ws.slug)) return;
      if (hasWorkspaceActivity(ws.slug)) {
        navigate(paths.workspace.chat(ws.slug));
        return;
      }
      const { thread } = await Workspace.threads.new(ws.slug);
      if (thread) setThreadSlug(thread.slug);
    }

    window.addEventListener(PASTE_ATTACHMENT_EVENT, handlePaste);
    return () =>
      window.removeEventListener(PASTE_ATTACHMENT_EVENT, handlePaste);
  }, [
    workspace,
    threadSlug,
    hasWorkspaceActivity,
    navigate,
    navigateToRunningThread,
  ]);

  async function handleDropWithoutWorkspace(acceptedFiles) {
    setDragging(false);
    pendingFilesRef.current = acceptedFiles;
    const ws = await createDefaultWorkspace(t("new-workspace.placeholder"));
    if (!ws) return;
    setWorkspace(ws);
    if (navigateToRunningThread(ws.slug)) return;
    if (hasWorkspaceActivity(ws.slug)) {
      navigate(paths.workspace.chat(ws.slug));
      return;
    }
    const { thread } = await Workspace.threads.new(ws.slug);
    if (thread) setThreadSlug(thread.slug);
  }

  async function handleDropWithWorkspace(acceptedFiles) {
    setDragging(false);
    pendingFilesRef.current = acceptedFiles;
    if (navigateToRunningThread(workspace.slug)) return;
    if (hasWorkspaceActivity(workspace.slug)) {
      navigate(paths.workspace.chat(workspace.slug));
      return;
    }
    const { thread } = await Workspace.threads.new(workspace.slug);
    if (thread) setThreadSlug(thread.slug);
  }

  if (workspaceLoading) {
    return (
      <div
        style={{ height: mobileLayoutActive ? "100%" : "calc(100% - 32px)" }}
        className="motion-hover relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-zinc-900 light:bg-white w-full h-full overflow-hidden"
      />
    );
  }

  if (!workspace) {
    return <NoWorkspacesAssigned />;
  }

  if (workspace && threadSlug) {
    return (
      <DnDFileUploaderProvider workspace={workspace} threadSlug={threadSlug}>
        <HomeContent
          workspace={workspace}
          setWorkspace={setWorkspace}
          threadSlug={threadSlug}
          setThreadSlug={setThreadSlug}
        />
      </DnDFileUploaderProvider>
    );
  }

  return (
    <DndUploaderContext.Provider
      value={{
        files: [],
        ready: true,
        dragging,
        setDragging,
        onDrop: workspace
          ? handleDropWithWorkspace
          : handleDropWithoutWorkspace,
        parseAttachments: () => [],
      }}
    >
      <HomeContent
        workspace={workspace}
        setWorkspace={setWorkspace}
        threadSlug={null}
        setThreadSlug={setThreadSlug}
      />
    </DndUploaderContext.Provider>
  );
}

function HomeContent({ workspace, setWorkspace, threadSlug, setThreadSlug }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const loginMode = useLoginMode();
  const mobileLayoutActive = mobileRuntimeActive();
  const [loading, setLoading] = useState(false);
  const { files, parseAttachments } = useContext(DndUploaderContext);
  const { hasWorkspaceActivity, getRunningThread, getThreadPath } =
    useChatThreadDrafts();
  useThreadActivitySnapshot();
  const runningThread = workspace?.slug
    ? getRunningThread(workspace.slug)
    : null;
  const hasUserIcon = loginMode !== null;

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(PROMPT_INPUT_EVENT, {
        detail: { messageContent: "", writeMode: "replace" },
      })
    );
  }, []);

  async function submitMessage(message, attachments = []) {
    if (!message || loading) return;
    setLoading(true);
    try {
      let targetWorkspace = workspace;
      let targetThread = threadSlug;

      if (!targetWorkspace) {
        targetWorkspace = await createDefaultWorkspace(
          t("new-workspace.placeholder")
        );
        if (!targetWorkspace) {
          setLoading(false);
          return;
        }
        setWorkspace(targetWorkspace);
      }

      if (!targetThread) {
        const activeThread = getRunningThread(targetWorkspace.slug);
        if (activeThread) {
          navigate(
            getThreadPath(targetWorkspace.slug, activeThread.threadSlug)
          );
          setLoading(false);
          return;
        }
        if (hasWorkspaceActivity(targetWorkspace.slug)) {
          navigate(paths.workspace.chat(targetWorkspace.slug));
          setLoading(false);
          return;
        }
        const { thread } = await Workspace.threads.new(targetWorkspace.slug);
        targetThread = thread?.slug;
        if (thread) setThreadSlug(thread.slug);
      }

      sessionStorage.setItem(
        PENDING_HOME_MESSAGE,
        JSON.stringify({ message, attachments })
      );

      if (targetThread) {
        navigate(paths.workspace.thread(targetWorkspace.slug, targetThread));
      } else {
        navigate(paths.workspace.chat(targetWorkspace.slug));
      }
    } catch (error) {
      console.error("Error submitting message:", error);
      showToast("Failed to send message", "error");
      setLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const currentMessage =
      document.getElementById(PROMPT_INPUT_ID)?.value?.trim() || "";
    await submitMessage(currentMessage, parseAttachments());
  }

  function sendCommand({
    text = "",
    autoSubmit = false,
    writeMode = "replace",
  }) {
    if (autoSubmit) {
      if (writeMode === "append") {
        const currentText =
          document.getElementById(PROMPT_INPUT_ID)?.value ?? "";
        text = currentText + text;
      }
      if (!text.trim()) return;
      submitMessage(text.trim());
      return;
    }
    window.dispatchEvent(
      new CustomEvent(PROMPT_INPUT_EVENT, {
        detail: { messageContent: text, writeMode },
      })
    );
  }

  async function handleEditWorkspace() {
    let targetWorkspace = workspace;

    if (!targetWorkspace) {
      targetWorkspace = await createDefaultWorkspace(
        t("new-workspace.placeholder")
      );
      if (!targetWorkspace) return;
      setWorkspace(targetWorkspace);
    }

    navigate(paths.workspace.settings.generalAppearance(targetWorkspace.slug));
  }

  return (
    <div
      style={{ height: mobileLayoutActive ? "100%" : "calc(100% - 32px)" }}
      className="motion-hover relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-zinc-900 light:bg-white w-full h-full overflow-hidden border-none light:border-solid light:border light:border-theme-modal-border"
    >
      {mobileLayoutActive && <SidebarMobileHeader />}
      {!mobileLayoutActive && workspace?.slug && (
        <div
          className={`absolute top-3 md:top-5 z-30 h-[40px] w-[40px] ${
            hasUserIcon ? "right-[55px] md:right-[67px]" : "right-4 md:right-6"
          }`}
        >
          <WorkspaceHealthProvider workspaceSlug={workspace.slug}>
            <WorkspaceHealthBeacon workspaceSlug={workspace.slug} />
          </WorkspaceHealthProvider>
        </div>
      )}
      <WorkspaceModelPicker
        workspaceSlug={workspace?.slug}
        modelName={workspace?.chatModel}
      />
      <DnDFileUploaderWrapper>
        <div className="flex flex-col h-full w-full items-center justify-center">
          <div className="flex flex-col items-center w-full max-w-[750px]">
            <h1 className="text-white text-xl md:text-2xl mb-11 text-center">
              {t("main-page.greeting")}
            </h1>
            <PromptInput
              workspace={workspace}
              submit={handleSubmit}
              isStreaming={loading}
              sendCommand={sendCommand}
              attachments={files}
              centered={true}
              workspaceSlug={workspace?.slug}
              threadSlug={threadSlug}
            />
            {runningThread && (
              <button
                type="button"
                onClick={() =>
                  navigate(
                    getThreadPath(workspace.slug, runningThread.threadSlug)
                  )
                }
                className="mt-4 text-sm font-semibold text-sky-300 light:text-blue-700 hover:underline"
              >
                {t("common.return-running-thread")}
              </button>
            )}
            <QuickActions
              hasAvailableWorkspace={!!workspace}
              onCreateAgent={() => navigate(paths.settings.agentSkills())}
              onEditWorkspace={handleEditWorkspace}
              onUploadDocument={() =>
                document.getElementById("dnd-chat-file-uploader")?.click()
              }
            />
          </div>
          <SuggestedMessages
            suggestedMessages={workspace?.suggestedMessages}
            sendCommand={sendCommand}
          />
        </div>
      </DnDFileUploaderWrapper>
      <ChatTooltips />
    </div>
  );
}

function NoWorkspacesAssigned() {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const mobileLayoutActive = mobileRuntimeActive();

  async function createFirstWorkspace() {
    if (creating) return;
    setCreating(true);
    const workspace = await createDefaultWorkspace(
      t("new-workspace.placeholder")
    );
    setCreating(false);
    if (workspace) navigate(defaultWorkspacePath(workspace.slug));
  }

  return (
    <div
      style={{ height: mobileLayoutActive ? "100%" : "calc(100% - 32px)" }}
      className="motion-hover relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-zinc-900 light:bg-white w-full h-full overflow-hidden"
    >
      <div className="flex flex-col h-full w-full items-center justify-center">
        <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
          <p className="text-white/80 light:text-slate-700 text-sm">
            你还没有工作区。创建一个工作区后，就可以开始添加知识、创建线程并进行对话。
          </p>
          <AppButton
            type="button"
            size="md"
            loading={creating}
            onClick={createFirstWorkspace}
          >
            {t("new-workspace.title")}
          </AppButton>
        </div>
      </div>
    </div>
  );
}
