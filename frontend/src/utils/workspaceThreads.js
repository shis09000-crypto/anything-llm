import paths from "./paths.js";

export const THREAD_TYPES = {
  chat: "chat",
  overview: "overview",
};

export const THREAD_CREATED_FROM = {
  workspaceDefault: "workspace_default",
};

export function isOverviewThread(thread = null) {
  return thread?.thread_type === THREAD_TYPES.overview;
}

export function isWorkspaceDefaultChatThread(thread = null) {
  return (
    thread?.thread_type === THREAD_TYPES.chat &&
    thread?.created_from === THREAD_CREATED_FROM.workspaceDefault
  );
}

export function isDefaultWorkspaceChatThread(thread = null) {
  return (
    isWorkspaceDefaultChatThread(thread) &&
    isUntitledDefaultNamedChatThread(thread)
  );
}

export function isUntitledDefaultNamedChatThread(thread = null) {
  if (thread?.thread_type !== THREAD_TYPES.chat || thread?.title) return false;
  const name = (thread?.name || "").trim().toLowerCase();
  return ["", "new thread", "thread"].includes(name);
}

export function findOverviewThread(threads = []) {
  return threads.find((thread) => isOverviewThread(thread)) || null;
}

export function isNavigableWorkspaceThread(thread = null) {
  return !!thread?.slug && thread?.deleted !== true;
}

export function isWorkspaceEntryChatThread(thread = null) {
  return isNavigableWorkspaceThread(thread) && !isOverviewThread(thread);
}

export function findWorkspaceEntryThread(threads = []) {
  const sortedThreads = threads
    .map((thread, index) => ({ thread, index }))
    .filter(({ thread }) => isNavigableWorkspaceThread(thread))
    .sort((a, b) => {
      const rank = (thread) => (isOverviewThread(thread) ? 1 : 0);
      const rankDiff = rank(a.thread) - rank(b.thread);
      if (rankDiff !== 0) return rankDiff;
      const latestDiff =
        threadLatestTime(b.thread) - threadLatestTime(a.thread);
      if (latestDiff !== 0) return latestDiff;
      const latestIdDiff =
        Number(b.thread?.lastChatId || 0) - Number(a.thread?.lastChatId || 0);
      if (latestIdDiff !== 0) return latestIdDiff;
      return a.index - b.index;
    });

  return sortedThreads[0]?.thread || null;
}

export function resolveWorkspaceEntryThread(
  threads = [],
  preferredThreadSlug = null
) {
  const preferredThread = preferredThreadSlug
    ? threads.find(
        (thread) =>
          thread?.slug === preferredThreadSlug &&
          isNavigableWorkspaceThread(thread)
      )
    : null;

  return preferredThread || findWorkspaceEntryThread(threads);
}

export function resolveWorkspaceEntryPath(
  workspaceSlug,
  threads = [],
  preferredThreadSlug = null
) {
  if (!workspaceSlug) return paths.home();
  const thread = resolveWorkspaceEntryThread(threads, preferredThreadSlug);
  return thread?.slug
    ? paths.workspace.thread(workspaceSlug, thread.slug)
    : paths.workspace.chat(workspaceSlug);
}

export function displayThreadName(thread = null, t = null) {
  if (!thread) return "";
  if (isOverviewThread(thread)) return t?.("common.overviewPage") || "Overview";
  if (isUntitledDefaultNamedChatThread(thread))
    return t?.("common.newThread") || "New Thread";
  return thread.title || thread.name || "";
}

export function sortThreadsForDisplay(
  threads = [],
  workspaceSlug,
  activityFor
) {
  return threads
    .map((thread, index) => ({
      thread,
      index,
      activity: activityFor?.(workspaceSlug, thread.slug),
    }))
    .sort((a, b) => {
      const rank = (thread) => {
        if (isOverviewThread(thread)) return 0;
        return 1;
      };
      const rankDiff = rank(a.thread) - rank(b.thread);
      if (rankDiff !== 0) return rankDiff;
      if (activitySortRank(a.activity) !== activitySortRank(b.activity)) {
        return activitySortRank(a.activity) - activitySortRank(b.activity);
      }
      if (activitySortRank(a.activity) === 0) {
        return (b.activity?.updatedAt || 0) - (a.activity?.updatedAt || 0);
      }
      const latestDiff =
        threadLatestTime(b.thread) - threadLatestTime(a.thread);
      if (latestDiff !== 0) return latestDiff;
      const latestIdDiff =
        Number(b.thread?.lastChatId || 0) - Number(a.thread?.lastChatId || 0);
      if (latestIdDiff !== 0) return latestIdDiff;
      return a.index - b.index;
    });
}

export function defaultWorkspacePath(workspaceSlug, threads = []) {
  return resolveWorkspaceEntryPath(workspaceSlug, threads);
}

function activitySortRank(activity) {
  if (activity?.status === "running") return 0;
  return 1;
}

function threadLatestTime(thread = null) {
  const timestamp =
    thread?.lastChatAt || thread?.lastUpdatedAt || thread?.createdAt || 0;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? time : 0;
}
