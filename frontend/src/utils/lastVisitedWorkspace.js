import {
  LAST_VISITED_WORKSPACE,
  LAST_VISITED_WORKSPACE_THREADS,
} from "@/utils/constants";
import paths from "@/utils/paths";
import { safeJsonParse } from "@/utils/request";

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
}

export function getLastVisitedThreadSlug(workspaceSlug) {
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
}

export function clearLastVisitedThread(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) return;
  const threadMap = readThreadMap();
  if (threadMap[workspaceSlug] !== (threadSlug || null)) return;
  delete threadMap[workspaceSlug];
  writeThreadMap(threadMap);
}

export function pathForLastVisitedThread(workspaceSlug) {
  const threadSlug = getLastVisitedThreadSlug(workspaceSlug);
  return threadSlug
    ? paths.workspace.thread(workspaceSlug, threadSlug)
    : paths.workspace.chat(workspaceSlug);
}
