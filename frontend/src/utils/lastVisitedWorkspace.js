import {
  LAST_VISITED_WORKSPACE,
  LAST_VISITED_WORKSPACE_THREADS,
} from "@/utils/constants";
import paths from "@/utils/paths";
import { safeJsonParse } from "@/utils/request";
import {
  hydrateUserStateValue,
  pushUserStateValue,
  USER_STATE_NAMESPACES,
} from "@/utils/userStateSync";

let hydratedRecentNavigation = false;

function readRecentNavigationState() {
  return {
    workspace: safeJsonParse(
      localStorage.getItem(LAST_VISITED_WORKSPACE),
      null
    ),
    threadsByWorkspace: readThreadMap(),
  };
}

function writeRecentNavigationState(value = {}) {
  const current = readRecentNavigationState();
  if (value.workspace) {
    localStorage.setItem(
      LAST_VISITED_WORKSPACE,
      JSON.stringify(value.workspace)
    );
  }
  if (value.threadsByWorkspace) {
    const incomingThreads = value.threadsByWorkspace || {};
    const mergedThreads = { ...incomingThreads };
    for (const [workspaceSlug, threadSlug] of Object.entries(
      current.threadsByWorkspace || {}
    )) {
      if (threadSlug && !incomingThreads[workspaceSlug]) {
        mergedThreads[workspaceSlug] = threadSlug;
      }
    }
    writeThreadMap(mergedThreads);
  }
}

function syncRecentNavigation() {
  if (hydratedRecentNavigation) return;
  hydratedRecentNavigation = true;
  void hydrateUserStateValue({
    namespace: USER_STATE_NAMESPACES.recentNavigation,
    fallback: readRecentNavigationState(),
    apply: writeRecentNavigationState,
  });
}

function persistRecentNavigation() {
  pushUserStateValue(
    USER_STATE_NAMESPACES.recentNavigation,
    "global",
    readRecentNavigationState()
  );
}

function readThreadMap() {
  const value = safeJsonParse(
    localStorage.getItem(LAST_VISITED_WORKSPACE_THREADS),
    {}
  );
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function writeThreadMap(threadMap = {}) {
  localStorage.setItem(
    LAST_VISITED_WORKSPACE_THREADS,
    JSON.stringify(threadMap)
  );
}

export function getLastVisitedWorkspace() {
  syncRecentNavigation();
  return safeJsonParse(localStorage.getItem(LAST_VISITED_WORKSPACE), null);
}

export function rememberLastVisitedWorkspace(workspace, threadSlug = null) {
  if (!workspace?.slug) return;
  localStorage.setItem(
    LAST_VISITED_WORKSPACE,
    JSON.stringify({
      slug: workspace.slug,
      name: workspace.name,
    })
  );
  setLastVisitedThread(workspace.slug, threadSlug);
  persistRecentNavigation();
}

export function getLastVisitedThreadSlug(workspaceSlug) {
  syncRecentNavigation();
  if (!workspaceSlug) return null;
  const threadMap = readThreadMap();
  return threadMap[workspaceSlug] ?? null;
}

export function setLastVisitedThread(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) return;
  writeThreadMap({
    ...readThreadMap(),
    [workspaceSlug]: threadSlug || null,
  });
  persistRecentNavigation();
}

export function clearLastVisitedThread(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) return;
  const threadMap = readThreadMap();
  if (threadMap[workspaceSlug] !== (threadSlug || null)) return;
  delete threadMap[workspaceSlug];
  writeThreadMap(threadMap);
  persistRecentNavigation();
}

export function pathForLastVisitedThread(workspaceSlug) {
  const threadSlug = getLastVisitedThreadSlug(workspaceSlug);
  return threadSlug
    ? paths.workspace.thread(workspaceSlug, threadSlug)
    : paths.workspace.chat(workspaceSlug);
}
